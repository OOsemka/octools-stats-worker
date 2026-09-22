/**
 * OCTools Stats API — Cloudflare Worker + D1
 *
 * Aggregates download counts and 5-star ratings for OpenShift Community Tools
 * extensions across all clusters.  No PII is collected; the only identifier is
 * a SHA-256 hash of the cluster UUID used for rating dedup.
 *
 * Endpoints:
 *   GET  /v1/stats              — aggregated stats for all tools
 *   POST /v1/stats/download     — increment download counter
 *   POST /v1/stats/rating       — upsert a cluster's rating
 *   DELETE /v1/stats/rating     — remove a cluster's rating
 *   GET  /v1/versions           — all tool versions grouped by tool_id
 *   GET  /v1/versions/:toolId   — versions for a single tool
 *   POST /v1/versions           — upsert a version row (admin-only)
 *   GET  /v1/catalog            — catalog format with stats + versions
 *   GET  /health                — health check
 */

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
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
/*  Auth helper                                                       */
/* ------------------------------------------------------------------ */

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token === env.ADMIN_TOKEN;
}

/* ------------------------------------------------------------------ */
/*  Version types                                                     */
/* ------------------------------------------------------------------ */

interface ToolVersionRow {
  tool_id: string;
  version: string;
  channel: string;
  openshift: string;
  image: string;
  git_ref: string | null;
  deploy_url: string | null;
  updated_at: string;
}

interface VersionEntry {
  version: string;
  channel: string;
  openshift: string;
  image: string;
  gitRef: string | null;
  deployUrl: string | null;
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns stats in the PublicCatalog format expected by the storefront sidecar.
 * Now includes versions[] per extension, grouped by (tool_id, version, channel)
 * with openshift values collected into an array.
 */
async function handleGetCatalog(db: D1Database): Promise<Response> {
  const statsRows = await db
    .prepare('SELECT tool_id, downloads, category FROM tools_stats')
    .all<{ tool_id: string; downloads: number; category: string | null }>();

  const ratingRows = await db
    .prepare(
      `SELECT tool_id,
              COUNT(*) as rating_count,
              ROUND(AVG(stars), 2) as rating_avg
       FROM ratings
       GROUP BY tool_id`
    )
    .all<{ tool_id: string; rating_count: number; rating_avg: number }>();

  const versionRows = await db
    .prepare('SELECT tool_id, version, channel, openshift, image, git_ref, deploy_url FROM tool_versions ORDER BY tool_id, version')
    .all<ToolVersionRow>();

  const toolMap = new Map<string, { downloads: number; ratingCount: number; ratingAvg: number; category: string | null }>();
  for (const row of statsRows.results) {
    toolMap.set(row.tool_id, { downloads: row.downloads, ratingCount: 0, ratingAvg: 0, category: row.category || null });
  }
  for (const row of ratingRows.results) {
    const existing = toolMap.get(row.tool_id);
    if (existing) {
      existing.ratingCount = row.rating_count;
      existing.ratingAvg = row.rating_avg;
    } else {
      toolMap.set(row.tool_id, { downloads: 0, ratingCount: row.rating_count, ratingAvg: row.rating_avg, category: null });
    }
  }

  // Group versions by (tool_id, version, channel) and collect openshift into arrays
  const versionsByTool = new Map<string, Map<string, { version: string; channel: string; openshift: string[]; image: string; gitRef: string | null; deployUrl: string | null }>>();
  for (const row of versionRows.results) {
    if (!versionsByTool.has(row.tool_id)) {
      versionsByTool.set(row.tool_id, new Map());
    }
    const toolVersions = versionsByTool.get(row.tool_id)!;
    const key = `${row.version}|${row.channel}`;
    const existing = toolVersions.get(key);
    if (existing) {
      existing.openshift.push(row.openshift);
    } else {
      toolVersions.set(key, {
        version: row.version,
        channel: row.channel,
        openshift: [row.openshift],
        image: row.image,
        gitRef: row.git_ref,
        deployUrl: row.deploy_url,
      });
    }
    // Ensure the tool appears in toolMap even if it has no stats
    if (!toolMap.has(row.tool_id)) {
      toolMap.set(row.tool_id, { downloads: 0, ratingCount: 0, ratingAvg: 0, category: null });
    }
  }

  const extensions = Array.from(toolMap.entries()).map(([id, data]) => {
    const toolVersions = versionsByTool.get(id);
    const versions = toolVersions
      ? Array.from(toolVersions.values()).map(v => ({
          version: v.version,
          channel: v.channel,
          openshift: v.openshift,
          image: v.image,
          ...(v.gitRef ? { gitRef: v.gitRef } : {}),
          ...(v.deployUrl ? { deployUrl: v.deployUrl } : {}),
        }))
      : [];

    return {
      id,
      consolePlugin: id,
      ...(data.category ? { category: data.category } : {}),
      downloads: data.downloads,
      rating: {
        average: data.ratingAvg,
        count: data.ratingCount,
      },
      versions,
    };
  });

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

  return json({ tools, timestamp: new Date().toISOString() }, 200, 300);
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
/*  Version handlers                                                  */
/* ------------------------------------------------------------------ */

async function handleGetVersions(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare('SELECT tool_id, version, channel, openshift, image, git_ref, deploy_url, updated_at FROM tool_versions ORDER BY tool_id, version')
    .all<ToolVersionRow>();

  const versions: Record<string, VersionEntry[]> = {};
  for (const row of rows.results) {
    if (!versions[row.tool_id]) {
      versions[row.tool_id] = [];
    }
    versions[row.tool_id].push({
      version: row.version,
      channel: row.channel,
      openshift: row.openshift,
      image: row.image,
      gitRef: row.git_ref,
      deployUrl: row.deploy_url,
    });
  }

  return json({ versions }, 200, 300);
}

async function handleGetVersionsByTool(db: D1Database, toolId: string): Promise<Response> {
  const rows = await db
    .prepare('SELECT tool_id, version, channel, openshift, image, git_ref, deploy_url, updated_at FROM tool_versions WHERE tool_id = ? ORDER BY version')
    .bind(toolId)
    .all<ToolVersionRow>();

  const versions: VersionEntry[] = rows.results.map(row => ({
    version: row.version,
    channel: row.channel,
    openshift: row.openshift,
    image: row.image,
    gitRef: row.git_ref,
    deployUrl: row.deploy_url,
  }));

  return json({ toolId, versions }, 200, 300);
}

async function handlePostVersion(request: Request, db: D1Database, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return errorResponse(401, 'Unauthorized: invalid or missing admin token');
  }

  let body: {
    toolId?: string;
    version?: string;
    channel?: string;
    openshift?: string;
    image?: string;
    gitRef?: string;
    deployUrl?: string;
    category?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const toolId = body.toolId?.trim();
  const version = body.version?.trim();
  const channel = body.channel?.trim() || 'stable';
  const openshift = body.openshift?.trim();
  const image = body.image?.trim();
  const gitRef = body.gitRef?.trim() || null;
  const deployUrl = body.deployUrl?.trim() || null;
  const category = body.category?.trim() || null;

  if (!toolId || toolId.length > 128) {
    return errorResponse(400, 'Missing or invalid toolId');
  }
  if (!version) {
    return errorResponse(400, 'Missing version');
  }
  if (!openshift) {
    return errorResponse(400, 'Missing openshift');
  }
  if (!image) {
    return errorResponse(400, 'Missing image');
  }

  await db
    .prepare(
      `INSERT INTO tool_versions (tool_id, version, channel, openshift, image, git_ref, deploy_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tool_id, version, openshift)
       DO UPDATE SET channel = excluded.channel, image = excluded.image,
                     git_ref = excluded.git_ref, deploy_url = excluded.deploy_url,
                     updated_at = datetime('now')`
    )
    .bind(toolId, version, channel, openshift, image, gitRef, deployUrl)
    .run();

  if (category) {
    await db
      .prepare(
        `INSERT INTO tools_stats (tool_id, downloads, category) VALUES (?, 0, ?)
         ON CONFLICT(tool_id) DO UPDATE SET category = excluded.category`
      )
      .bind(toolId, category)
      .run();
  }

  return json({ ok: true, toolId, version, openshift });
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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check
    if (pathname === '/health' && method === 'GET') {
      return json({ ok: true, version: '1.1.0' });
    }

    // GET stats (read-only, cached)
    if (pathname === '/v1/stats' && method === 'GET') {
      return handleGetStats(env.DB);
    }

    // GET catalog-format stats (for storefront sidecar public-catalog fetch)
    if ((pathname === '/v1/catalog' || pathname === '/') && method === 'GET') {
      return handleGetCatalog(env.DB);
    }

    // GET /v1/versions — all tool versions
    if (pathname === '/v1/versions' && method === 'GET') {
      return handleGetVersions(env.DB);
    }

    // GET /v1/versions/:toolId — versions for a single tool
    const versionMatch = pathname.match(/^\/v1\/versions\/([^/]+)$/);
    if (versionMatch && method === 'GET') {
      return handleGetVersionsByTool(env.DB, decodeURIComponent(versionMatch[1]));
    }

    // Write endpoints — rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // POST /v1/versions — admin-only upsert (no rate limit for admin)
    if (pathname === '/v1/versions' && method === 'POST') {
      return handlePostVersion(request, env.DB, env);
    }

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
