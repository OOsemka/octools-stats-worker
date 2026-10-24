# octools-stats-worker

Cloudflare Worker behind **https://api.octools.net**: the public catalog API for OpenShift Community Tools (OCT). It serves version rows, download counts and ratings, backed by a D1 database. The public API reference is https://octools.net/api/.

**Community project. Not officially supported by Red Hat.**

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | `{"ok":true,"version":...}` |
| GET | `/v1/catalog` | none | All tools with stats, metadata and version rows; installed storefronts sync from this (hourly) |
| GET | `/v1/stats` | none | Downloads and ratings |
| GET | `/v1/versions`, `/v1/versions/:toolId` | none | Version rows |
| POST | `/v1/versions` | **admin** | Upsert one version row |
| POST | `/v1/stats/download` | none, rate-limited | Increment downloads (storefront Add) |
| POST / DELETE | `/v1/stats/rating` | none, rate-limited | Upsert / remove a rating (deduped by cluster hash) |

Version rows are keyed by `(toolId, version, openshift)`: **one row per OpenShift minor**, `openshift` is a single string and `image` is that minor's combined tag. Optional fields: `channel`, `gitRef`, `deployUrl`, and tile metadata (`category`, `description`, `displayName`, `href`, `icon`, `git`).

## Publishing a release (seeding)

Run after the storefront PR that adds the rows is merged, against the storefront's `catalog/community.yaml`:

```bash
DRY_RUN=1 TOOL=<tool-id> CATALOG_PATH=../oct-storefront/catalog/community.yaml node seed.js
ADMIN_TOKEN=<admin token> TOOL=<tool-id> CATALOG_PATH=../oct-storefront/catalog/community.yaml node seed.js
curl -s https://api.octools.net/v1/versions/<tool-id>
```

- `TOOL` limits the run to one tool; without it every catalog row is upserted (idempotent).
- Catalog rows listing several minors are posted as one row per minor; the catalog's `deployURL` is sent as `deployUrl`.
- Use `curl` to check results: Cloudflare rejects some default client user agents (Python `urllib` gets 403).

## The admin token

`ADMIN_TOKEN` is a **Worker secret**, never a `[vars]` entry and never committed (`seed.js` refuses to write without it). Maintainers keep it in a password manager. To rotate:

```bash
openssl rand -hex 32 > <private file, mode 600>
npx wrangler secret put ADMIN_TOKEN < <that file>
```

An old value that was ever committed must be treated as public and rotated, not just moved.

## Deploying

There is no CI; deploys are manual with a Cloudflare API token that has Workers and D1 permissions:

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy --dry-run --outdir /tmp/w   # check bindings first
npx wrangler deploy
```

### Database migrations

Schema files are applied in order: `schema.sql`, `schema-v2.sql`, `schema-v3.sql`, `schema-v4.sql` (v4 adds the tile metadata columns `/v1/catalog` selects). **Apply a migration before deploying code that needs it**, and record a restore point first:

```bash
npx wrangler d1 time-travel info octools-stats            # note the bookmark
npx wrangler d1 execute octools-stats --remote --file=./schema-vN.sql
npx wrangler d1 execute octools-stats --remote --command "SELECT name FROM pragma_table_info('tools_stats')"
# rollback if needed: npx wrangler d1 time-travel restore octools-stats --bookmark=<bookmark>
```

After a deploy, re-run `seed.js` without `TOOL` if new columns need to be filled for every tool.

## Related repositories

- `oct-storefront` — the in-console storefront and the canonical `catalog/community.yaml`
- `octools-website` — octools.net (API docs, developer guide)
