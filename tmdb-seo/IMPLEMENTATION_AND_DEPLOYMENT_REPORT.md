# TMDB SEO Implementation And Deployment Report

Date: 2026-04-19  
Project: `tmdb-seo`  
Production URL: <https://tmdb-seo.pages.dev/>

This document records what has been implemented in the project, what was deployed
to Cloudflare, which checks were run, and the operational caveats a developer
should know before continuing work.

## Executive Summary

`tmdb-seo` is an Astro 4 server-rendered SEO site deployed to Cloudflare Pages.
It reads movie, provider, cast, genre, collection, sitemap, and click analytics
data from Cloudflare D1. The project currently implements the Phase 1 through
Phase 3 scope described in `../tmdb_seo_product_spec.md`.

The site is live at:

```text
https://tmdb-seo.pages.dev/
```

The Cloudflare deployment is functional. The full local SQLite export was
imported into D1, and remote table counts match the local export exactly.

The main known production risk is D1 performance on queries that read
`movie_providers`. Cloudflare D1 could not build the four large
`movie_providers` indexes because each index build exceeded D1 CPU, memory, or
storage operation limits. The relevant pages still return successfully, but they
scan the 12.5M-row provider table and are therefore slow.

Update on 2026-04-20: actor pages were changed to avoid this provider-table
scan during page rendering. They now list actor movie credits through the
indexed cast/movie path and leave provider availability to the linked movie
pages.

## Cloudflare Resources

The following Cloudflare resources were created and bound to the app:

| Resource | Name | Binding | ID |
|---|---|---|---|
| Cloudflare Pages project | `tmdb-seo` | n/a | n/a |
| Cloudflare D1 database | `tmdb-seo` | `DB` | `ed9a3474-da58-4d3f-b954-a7f55ae525d0` |
| Cloudflare KV namespace | `tmdb-seo-CACHE` | `CACHE` | `00a519a0a87e494e90a211539bc3ab95` |

The Pages production branch is `main`.

The first production deployment created this deployment alias:

```text
https://12e79fa4.tmdb-seo.pages.dev
```

The project domain that verified correctly is:

```text
https://tmdb-seo.pages.dev/
```

The deployment-specific alias initially had TLS handshake propagation issues
when tested immediately after deployment. The project domain worked and returned
HTTP 200.

## Configuration Changes

`wrangler.toml` was updated with real Cloudflare resource bindings:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tmdb-seo"
database_id = "ed9a3474-da58-4d3f-b954-a7f55ae525d0"

[[kv_namespaces]]
binding = "CACHE"
id = "00a519a0a87e494e90a211539bc3ab95"
```

Runtime variables were also set in `wrangler.toml`:

```toml
SITE_URL = "https://tmdb-seo.pages.dev"
PUBLIC_GA_MEASUREMENT_ID = ""
ADMIN_KEY = "<generated-admin-key-present-in-wrangler.toml>"
AMAZON_AFFILIATE_TAG = "wheretowatch9-21"
APPLE_AFFILIATE_URL = ""
GSC_VERIFICATION_CODE = ""
```

Security note: `ADMIN_KEY` should eventually be moved out of `wrangler.toml`
and into Cloudflare Pages environment variables or secrets. This report does not
repeat the actual key value.

GA4, affiliate, and Google Search Console values are intentionally blank because
real production values were not supplied.

## Implemented Project Scope

### Data Export

Implemented file:

```text
export_to_sqlite.py
```

The export script reads `tmdb.duckdb` from this directory or the parent
directory and writes `tmdb_seo.db`.

Current behavior:

- Performs a full migration by default.
- Supports the smaller original SEO-filtered export through `--seo-filter`.
- Produces D1-compatible SQLite tables.
- Creates local SQLite indexes used by the app.
- Creates `click_events` for affiliate/click tracking.

Exported SQLite tables:

- `movies`
- `movie_providers`
- `movie_genres`
- `movie_cast`
- `people`
- `collections`
- `genre_platform_index`
- `click_events`

### Astro And Cloudflare Runtime

Implemented files:

```text
astro.config.mjs
src/env.d.ts
src/middleware.ts
src/layouts/Layout.astro
```

Runtime behavior:

- Astro is configured with `output: "server"`.
- Cloudflare adapter is configured in directory mode.
- Partytown is configured for GA4 loading when a GA measurement ID is provided.
- Image service is passthrough, so TMDB images are loaded from TMDB image CDN.
- Cloudflare runtime bindings are typed through `src/env.d.ts`.
- Middleware blocks Astro's internal `/_image` endpoint with a 404 response.

### Shared Libraries

Implemented files:

```text
src/lib/db.ts
src/lib/site.ts
src/lib/affiliate.ts
src/lib/sitemap.ts
```

`src/lib/db.ts` centralizes D1 query helpers for:

- Movie lookup by slug.
- Movie provider lookup by movie and region.
- Movie cast lookup.
- Provider catalog pages.
- Actor pages.
- Collection pages.
- Genre/provider landing pages.
- Homepage top movies.
- Homepage movie search.
- Sitemap data.

`src/lib/site.ts` provides:

- Canonical URL generation.
- Base URL resolution from `SITE_URL`.
- Slug formatting.
- Meta description truncation.
- Region display names.
- XML escaping.
- TMDB image URL helpers.
- TMDB attribution constants.

`src/lib/affiliate.ts` provides:

- Amazon and Prime Video redirect URL construction to Amazon Prime Video search
  with `AMAZON_AFFILIATE_TAG`.
- Apple affiliate wrapping when `APPLE_AFFILIATE_URL` is configured.
- URL safety checks for redirect destinations.

`src/lib/sitemap.ts` provides:

- Shared sitemap XML response construction.
- Movie sitemap chunk sizing.

### Implemented Routes

Implemented page and endpoint routes:

```text
/
/movie/[slug]
/streaming/[provider]/[region]
/actor/[slug]
/genre/[genre]/[provider]
/collection/[id]
/go/[provider]
/api/search
/api/stats
/robots.txt
/sitemap-index.xml
/sitemap-actors.xml
/sitemap-providers.xml
/sitemap-movies-1.xml
/sitemap-movies-2.xml
/sitemap-movies-3.xml
/sitemap-movies-4.xml
/sitemap-movies-5.xml
/sitemap-movies-6.xml
/404
```

Implemented route behavior:

- Homepage lists popular movies from D1 and supports movie search suggestions.
- Movie pages render movie metadata, overview, ratings, runtime, genres,
  provider availability, cast links, canonical URL, Open Graph metadata, and
  `schema.org/Movie` JSON-LD.
- Provider pages render provider-region movie catalogs and
  `schema.org/ItemList` JSON-LD.
- Actor pages render actor credits without joining `movie_providers` during
  page rendering.
- Genre/provider pages use `genre_platform_index` for metadata and list
  matching movies.
- Collection pages render franchise/collection metadata and movies.
- `/go/[provider]` logs click events to D1 and redirects to the destination URL.
- `/api/search` returns movie suggestions for homepage search.
- `/api/stats` requires `x-admin-key` matching `ADMIN_KEY`.
- `robots.txt` blocks `/go/` and `/api/`, and references the sitemap index.
- Sitemaps are chunked to keep movie sitemap files below search-engine limits.

### SEO And Analytics Support

Implemented SEO features:

- Canonical URL support.
- Per-page title and meta description support.
- Open Graph metadata.
- JSON-LD for movie, person, and item-list pages.
- `robots.txt`.
- Sitemap index.
- Chunked movie sitemaps.
- Actor sitemap.
- Provider sitemap.
- TMDB attribution in the layout.
- Affiliate disclosure in the layout.

Implemented analytics support:

- GA4 loading through Partytown when `PUBLIC_GA_MEASUREMENT_ID` is configured.
- D1 click logging through `/go/[provider]`.
- Admin stats endpoint through `/api/stats`.

Not yet configured with real production values:

- GA4 measurement ID.
- Google Search Console verification code.
- Amazon affiliate tag is configured as `wheretowatch9-21`.
- Apple affiliate URL.

## D1 Import Details

The local SQLite database was already present:

```text
tmdb_seo.db
```

Approximate local size:

```text
2.8 GB
```

A SQL dump was created:

```bash
sqlite3 tmdb_seo.db ".dump" > tmdb_seo.sql
```

Dump size:

```text
2.6 GB
```

Line count:

```text
14,425,296 lines
```

The dump was split into upload-sized SQL chunks. A line-preserving splitter was
used instead of a byte split so SQL statements would not be cut in half.

The first generated chunk set included `BEGIN TRANSACTION` and `COMMIT`
wrappers, but D1 rejected explicit transaction statements in imported SQL files.
The chunks were rewritten into a D1-safe chunk set by removing:

```sql
BEGIN TRANSACTION;
COMMIT;
```

D1-safe chunk files:

```text
d1_chunk_0001.sql through d1_chunk_0187.sql
```

Chunk count:

```text
187
```

Max chunk size:

```text
about 15 MB
```

Chunks `0001` through `0186` imported successfully. Chunk `0187` initially
failed because it contained the final data plus all index creation statements
and exceeded D1 CPU time. It was split into:

```text
d1_chunk_0187_data.sql
d1_index_01.sql through d1_index_14.sql
```

The data-only final chunk imported successfully.

## Remote D1 Data Verification

Remote D1 counts were verified with a scalar subquery count query. The remote
counts matched the local export:

| Table | Remote D1 rows |
|---|---:|
| `movies` | 232,916 |
| `movie_providers` | 12,491,535 |
| `movie_genres` | 393,001 |
| `movie_cast` | 918,464 |
| `people` | 347,031 |
| `collections` | 5,001 |
| `genre_platform_index` | 37,257 |
| `click_events` | 0 |

Remote D1 database info after import:

```text
Database size: about 2.2 GB
Tables: 8
Running region: APAC
```

## Remote D1 Index Status

The following indexes exist on remote D1:

| Index | Table | Status |
|---|---|---|
| `sqlite_autoindex_movies_1` | `movies` | Exists |
| `sqlite_autoindex_people_1` | `people` | Exists |
| `idx_movies_slug` | `movies` | Created |
| `idx_movies_pop` | `movies` | Created |
| `idx_movies_coll` | `movies` | Created |
| `idx_people_slug` | `people` | Created |
| `idx_mg_movie` | `movie_genres` | Created after retry |
| `idx_mg_genre` | `movie_genres` | Created |
| `idx_mc_movie` | `movie_cast` | Created |
| `idx_mc_person` | `movie_cast` | Created |
| `idx_gpi_lookup` | `genre_platform_index` | Created |
| `idx_click_ts` | `click_events` | Created |

The following intended indexes could not be created on remote D1:

| Index | Table | Failure mode |
|---|---|---|
| `idx_mp_movie` | `movie_providers(movie_id)` | D1 CPU time limit exceeded |
| `idx_mp_region` | `movie_providers(region)` | D1 reset / timeout |
| `idx_mp_provider` | `movie_providers(provider_slug, region)` | SQLite out of memory |
| `idx_mp_type` | `movie_providers(type)` | D1 storage timeout |

These failures are caused by trying to build large indexes on a 12.5M-row table
inside D1's execution limits. The data is present, but queries against
`movie_providers` are slower because they scan the table.

## Performance Findings

Representative remote D1 query checks:

| Query shape | Result | Observed SQL behavior |
|---|---|---|
| Homepage top movies | Success | Used `idx_movies_pop`; around 0.37 ms SQL duration |
| Movie provider lookup by `movie_id` and `region` | Success | Scanned about 12.5M rows; around 2.6 s SQL duration |
| Provider catalog lookup by `provider_slug` and `region` | Success | Scanned about 12.9M rows; around 4.4 s SQL duration |

Representative live HTTP checks:

| URL | Method | Result |
|---|---|---|
| `https://tmdb-seo.pages.dev/` | `HEAD` | 200 |
| `https://tmdb-seo.pages.dev/movie/avatar-fire-and-ash-2025` | `HEAD` | 200 |
| `https://tmdb-seo.pages.dev/streaming/amazon-video/US` | `HEAD` | 200 |
| `https://tmdb-seo.pages.dev/robots.txt` | `GET` | 200 |
| `https://tmdb-seo.pages.dev/sitemap-index.xml` | `GET` | 200 |
| `https://tmdb-seo.pages.dev/api/stats` without admin key | `GET` | 403 |

The movie and provider pages returned 200 but were slow at the HTTP layer during
verification because provider-table indexes are missing.

Important endpoint note: `HEAD` requests to Astro `.ts` endpoint routes returned
404 during verification, while `GET` returned the expected results. This affected
`robots.txt`, `sitemap-index.xml`, and `/api/stats` during testing. Search
engines and browsers normally fetch these endpoints with `GET`.

## Build Verification

Build command:

```bash
npm run build
```

Build script:

```bash
ASTRO_TELEMETRY_DISABLED=1 astro check && ASTRO_TELEMETRY_DISABLED=1 astro build
```

Astro check diagnostics result:

```text
0 errors
0 warnings
0 hints
```

The full build completed successfully. Astro also emitted adapter/image-service
warnings stating that the Cloudflare adapter is not compatible with the Sharp
image service. The project uses passthrough images and TMDB image CDN URLs, so
this warning did not block the build.

## Deployment Verification

Wrangler authentication:

```bash
npx wrangler login
npx wrangler whoami
```

The CLI was authenticated successfully before resource creation and deploy.

Cloudflare resources were created with:

```bash
npx wrangler d1 create tmdb-seo
npx wrangler kv namespace create CACHE
npx wrangler pages project create tmdb-seo --production-branch=main
```

The production deploy was run with:

```bash
npx wrangler pages deploy ./dist --project-name=tmdb-seo --branch=main --commit-dirty=true
```

Deployment result:

```text
Deployment complete
Project URL: https://tmdb-seo.pages.dev/
Deployment alias: https://12e79fa4.tmdb-seo.pages.dev
```

The production deployment was also visible through:

```bash
npx wrangler pages deployment list --project-name=tmdb-seo
```

## Local Verification Performed

Local row counts were verified before import:

| Table | Local SQLite rows |
|---|---:|
| `movies` | 232,916 |
| `movie_providers` | 12,491,535 |
| `movie_genres` | 393,001 |
| `movie_cast` | 918,464 |
| `people` | 347,031 |
| `collections` | 5,001 |
| `genre_platform_index` | 37,257 |

A full SQLite `PRAGMA integrity_check;` was started but was stopped after
several minutes because it was blocking the deployment path on a multi-gigabyte
database. It did not report an error before being stopped. Row counts were used
as the practical verification before upload, and remote counts were verified
after import.

## Generated Local Deployment Artifacts

The deployment produced large local artifacts:

| Artifact | Approximate size | Purpose |
|---|---:|---|
| `tmdb_seo.sql` | 2.6 GB | SQLite dump used for D1 import |
| `chunk_*.sql` | 2.7 GB total | First transaction-wrapped chunk set |
| `d1_chunk_*.sql` | 2.6 GB total | D1-safe chunk set |
| `d1-import.log` | 452 KB | D1 data import log |
| `d1-index.log` | 32 KB | D1 index creation log |

These files are ignored by `.gitignore`. They can be deleted when no longer
needed for audit or retry purposes.

## Known Limitations And Follow-Up Work

### Provider Table Performance

The full `movie_providers` table was imported, but the provider-table indexes
could not be created inside D1's limits. This directly affects:

- `/movie/[slug]`, because provider lookup filters by `movie_id` and `region`.
- `/streaming/[provider]/[region]`, because provider catalog lookup filters by
  `provider_slug` and `region`.
- `/sitemap-providers.xml`, because it groups provider-region combinations.
- `/go/[provider]` only indirectly; redirect logging itself writes to
  `click_events`.

Possible follow-up approaches:

1. Reduce the remote D1 dataset to the SEO subset instead of full migration.
2. Split `movie_providers` by region into separate tables, at least for high
   traffic regions such as `US`, `IN`, `GB`, `CA`, and `AU`.
3. Materialize provider-region page tables with pre-ranked movie lists.
4. Store movie-provider availability in a movie-centric compact table for
   `/movie/[slug]` pages.
5. Build indexes locally before import and test whether D1 preserves them when
   importing a schema/data dump. If D1 still rebuilds indexes during import, this
   may not avoid the same limit.
6. Consider smaller D1 databases by region or provider if the project remains on
   D1.

### Production Configuration

The following values still need real production configuration:

- `PUBLIC_GA_MEASUREMENT_ID`
- `GSC_VERIFICATION_CODE`
- `AMAZON_AFFILIATE_TAG`
- `APPLE_AFFILIATE_URL`
- Any custom production domain replacing `tmdb-seo.pages.dev`

After a custom domain is configured, update:

```toml
SITE_URL = "https://YOUR_DOMAIN"
```

Then rebuild and redeploy so canonical URLs, robots, and sitemap URLs point to
the final domain.

### Secret Handling

Move `ADMIN_KEY` out of `wrangler.toml` and into Cloudflare Pages environment
variables or secrets before sharing this repository broadly.

### Local Runtime Testing

Wrangler warned that the local machine is on macOS 12.6.0, while Cloudflare
`workerd` local runtime support expects macOS 13.5 or newer. Because of that,
runtime verification was performed against the live Cloudflare deployment rather
than relying on local `wrangler pages dev`.

## Quick Developer Start

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Deploy current `dist` to the existing Pages project:

```bash
npx wrangler pages deploy ./dist --project-name=tmdb-seo --branch=main --commit-dirty=true
```

Verify remote D1 counts:

```bash
npx wrangler d1 execute tmdb-seo --remote --command="SELECT (SELECT COUNT(*) FROM movies) AS movies, (SELECT COUNT(*) FROM movie_providers) AS movie_providers, (SELECT COUNT(*) FROM movie_genres) AS movie_genres, (SELECT COUNT(*) FROM movie_cast) AS movie_cast, (SELECT COUNT(*) FROM people) AS people, (SELECT COUNT(*) FROM collections) AS collections, (SELECT COUNT(*) FROM genre_platform_index) AS genre_platform_index, (SELECT COUNT(*) FROM click_events) AS click_events;" --yes --json
```

Verify live app:

```bash
curl -I --http1.1 https://tmdb-seo.pages.dev/
curl -I --http1.1 https://tmdb-seo.pages.dev/movie/avatar-fire-and-ash-2025
curl -I --http1.1 https://tmdb-seo.pages.dev/streaming/amazon-video/US
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://tmdb-seo.pages.dev/robots.txt
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://tmdb-seo.pages.dev/sitemap-index.xml
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://tmdb-seo.pages.dev/api/stats
```

Expected live results:

```text
/                                  200
/movie/avatar-fire-and-ash-2025    200
/streaming/amazon-video/US         200
/robots.txt                        200 text/plain
/sitemap-index.xml                 200 application/xml
/api/stats without x-admin-key     403
```
