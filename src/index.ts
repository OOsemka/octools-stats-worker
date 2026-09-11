/**
 * OCTools Stats API — Cloudflare Worker + D1
 *
 * Aggregates download counts and 5-star ratings for OpenShift Community Tools
 * extensions across all clusters.  No PII is collected; the only identifier is
 * a SHA-256 hash of the cluster UUID used for rating dedup.
 *
 * Endpoints:
 *   GET  /v1/stats            — aggregated stats for all tools
 *   POST /v1/stats/download   — increment download counter
 *   POST /v1/stats/rating     — upsert a cluster's rating
 *   DELETE /v1/stats/rating   — remove a cluster's rating
 *   GET  /health              — health check
 */

export interface Env {
  DB: D1Database;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/* ------------------------------------------------------------------ */
/*  Rate limiter (simple in-memory, per-isolate)                      */
/* ------------------------------------------------------------------ */

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 20; // max writes per IP per minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns stats in the PublicCatalog format expected by the storefront sidecar.
 * The sidecar calls GET COMMUNITY_TOOLS_CATALOG_URL and expects:
 * { extensions: [{ id, consolePlugin, downloads, rating: { average, count } }] }
 */
async function handleGetCatalog(db: D1Database): Promise<Response> {
  const statsRows = await db
    .prepare('SELECT tool_id, downloads FROM tools_stats')
    .all<{ tool_id: string; downloads: number }>();

  const ratingRows = await db
    .prepare(
      `SELECT tool_id,
              COUNT(*) as rating_count,
              ROUND(AVG(stars), 2) as rating_avg
       FROM ratings
       GROUP BY tool_id`
    )
    .all<{ tool_id: string; rating_count: number; rating_avg: number }>();

  const toolMap = new Map<string, { downloads: number; ratingCount: number; ratingAvg: number }>();
  for (const row of statsRows.results) {
    toolMap.set(row.tool_id, { downloads: row.downloads, ratingCount: 0, ratingAvg: 0 });
  }
  for (const row of ratingRows.results) {
    const existing = toolMap.get(row.tool_id);
    if (existing) {
      existing.ratingCount = row.rating_count;
      existing.ratingAvg = row.rating_avg;
    } else {
      toolMap.set(row.tool_id, { downloads: 0, ratingCount: row.rating_count, ratingAvg: row.rating_avg });
    }
  }

  const extensions = Array.from(toolMap.entries()).map(([id, data]) => ({
    id,
    consolePlugin: id,
    downloads: data.downloads,
    rating: {
      average: data.ratingAvg,
      count: data.ratingCount,
    },
  }));

  return json({
    extensions,
    generatedAt: new Date().toISOString(),
  }, 200, 300);
}

async function handleGetStats(db: D1Database): Promise<Response> {
  const statsRows = await db
    .prepare('SELECT tool_id, downloads FROM tools_stats')
    .all<{ tool_id: string; downloads: number }>();

  const ratingRows = await db
    .prepare(
      `SELECT tool_id,
              COUNT(*) as rating_count,
              ROUND(AVG(stars), 2) as rating_avg
       FROM ratings
       GROUP BY tool_id`
    )
    .all<{ tool_id: string; rating_count: number; rating_avg: number }>();

  // Merge into a single map
  const toolMap = new Map<string, { downloads: number; ratingCount: number; ratingAvg: number }>();

  for (const row of statsRows.results) {
    toolMap.set(row.tool_id, {
      downloads: row.downloads,
      ratingCount: 0,
      ratingAvg: 0,
    });
  }

  for (const row of ratingRows.results) {
    const existing = toolMap.get(row.tool_id);
    if (existing) {
      existing.ratingCount = row.rating_count;
      existing.ratingAvg = row.rating_avg;
    } else {
      toolMap.set(row.tool_id, {
        downloads: 0,
        ratingCount: row.rating_count,
        ratingAvg: row.rating_avg,
      });
    }
  }

  const tools: Record<string, { downloads: number; ratingCount: number; ratingAvg: number }> = {};
  for (const [id, data] of toolMap) {
    tools[id] = data;
  }

  return json({ tools, timestamp: new Date().toISOString() }, 200, 300); // cache 5 min
}

async function handlePostDownload(request: Request, db: D1Database): Promise<Response> {
  let body: { toolId?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const toolId = body.toolId?.trim();
  if (!toolId || toolId.length > 128) {
    return errorResponse(400, 'Missing or invalid toolId');
  }

  await db
    .prepare(
      `INSERT INTO tools_stats (tool_id, downloads) VALUES (?, 1)
       ON CONFLICT(tool_id) DO UPDATE SET downloads = downloads + 1`
    )
    .bind(toolId)
    .run();

  return json({ ok: true, toolId });
}

async function handlePostRating(request: Request, db: D1Database): Promise<Response> {
  let body: { toolId?: string; clusterHash?: string; stars?: number };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const toolId = body.toolId?.trim();
  const clusterHash = body.clusterHash?.trim();
  const stars = body.stars;

  if (!toolId || toolId.length > 128) {
    return errorResponse(400, 'Missing or invalid toolId');
  }
  if (!clusterHash || !SHA256_RE.test(clusterHash)) {
    return errorResponse(400, 'clusterHash must be a 64-character hex SHA-256 hash');
  }
  if (typeof stars !== 'number' || stars < 1 || stars > 5 || !Number.isInteger(stars)) {
    return errorResponse(400, 'stars must be an integer between 1 and 5');
  }

  await db
    .prepare(
      `INSERT INTO ratings (tool_id, cluster_hash, stars, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(tool_id, cluster_hash)
       DO UPDATE SET stars = excluded.stars, updated_at = datetime('now')`
    )
    .bind(toolId, clusterHash, stars)
    .run();

  return json({ ok: true, toolId, stars });
}

async function handleDeleteRating(request: Request, db: D1Database): Promise<Response> {
  let body: { toolId?: string; clusterHash?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const toolId = body.toolId?.trim();
  const clusterHash = body.clusterHash?.trim();

  if (!toolId) {
    return errorResponse(400, 'Missing toolId');
  }
  if (!clusterHash || !SHA256_RE.test(clusterHash)) {
    return errorResponse(400, 'Invalid clusterHash');
  }

  await db
    .prepare('DELETE FROM ratings WHERE tool_id = ? AND cluster_hash = ?')
    .bind(toolId, clusterHash)
    .run();

  return json({ ok: true, toolId });
}

/* ------------------------------------------------------------------ */
/*  Router                                                            */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check
    if (pathname === '/health' && method === 'GET') {
      return json({ ok: true, version: '1.0.0' });
    }

    // GET stats (read-only, cached)
    if (pathname === '/v1/stats' && method === 'GET') {
      return handleGetStats(env.DB);
    }

    // GET catalog-format stats (for storefront sidecar public-catalog fetch)
    if ((pathname === '/v1/catalog' || pathname === '/') && method === 'GET') {
      return handleGetCatalog(env.DB);
    }

    // Write endpoints — rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (pathname === '/v1/stats/download' && method === 'POST') {
      if (isRateLimited(ip)) {
        return errorResponse(429, 'Rate limited. Try again later.');
      }
      return handlePostDownload(request, env.DB);
    }

    if (pathname === '/v1/stats/rating' && method === 'POST') {
      if (isRateLimited(ip)) {
        return errorResponse(429, 'Rate limited. Try again later.');
      }
      return handlePostRating(request, env.DB);
    }

    if (pathname === '/v1/stats/rating' && method === 'DELETE') {
      if (isRateLimited(ip)) {
        return errorResponse(429, 'Rate limited. Try again later.');
      }
      return handleDeleteRating(request, env.DB);
    }

    return errorResponse(404, 'Not found');
  },
} satisfies ExportedHandler<Env>;
