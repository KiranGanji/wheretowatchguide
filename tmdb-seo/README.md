# TMDB Streaming Guide

Astro SSR site for TMDB streaming availability pages, implemented through Phase 3 of
`../tmdb_seo_product_spec.md`.

## Implemented

- Phase 1 local data export: `export_to_sqlite.py`
- Phase 2 Astro + Cloudflare app setup
- Phase 2 D1 query helpers, affiliate redirect helper, base layout, GA4 wiring
- Phase 3 movie, provider, actor, genre/provider, collection, redirect, stats,
  sitemap, and robots routes
- Homepage movie search with suggestions after 3 typed characters

## Local Commands

```bash
npm install
python3 export_to_sqlite.py
npm run build
```

The export script reads `tmdb.duckdb` from either this directory or the parent
directory and writes `tmdb_seo.db` here. By default it performs a full migration.
Use `python3 export_to_sqlite.py --seo-filter` only if you intentionally want the
original filtered Phase 1 subset.

Local `wrangler pages dev` requires Cloudflare `workerd`. On macOS, workerd
requires macOS 13.5 or newer; use a supported macOS version or a Linux
DevContainer for local D1-bound runtime testing.

## Cloudflare Values To Replace

Update `wrangler.toml` before a real Cloudflare deploy:

- `database_id`
- KV namespace `id`
- `SITE_URL`
- `PUBLIC_GA_MEASUREMENT_ID`
- `ADMIN_KEY`
- `AMAZON_AFFILIATE_TAG`
- `APPLE_AFFILIATE_URL`
- `GSC_VERIFICATION_CODE`

## D1 Import

After Cloudflare D1 exists and `wrangler.toml` has the real IDs:

```bash
mkdir -p sql
sqlite3 tmdb_seo.db .dump > sql/tmdb_seo.sql
split -b 18m sql/tmdb_seo.sql sql/chunk_
npx wrangler d1 execute tmdb-seo --local --file=sql/tmdb_seo.sql
npx wrangler d1 execute tmdb-seo --remote --file=sql/chunk_aa
```

Repeat the remote command for each generated chunk.

## Project Purpose

This project is a programmatic SEO streaming guide built from the local TMDB
DuckDB data asset. The site answers search queries such as where a movie can be
streamed, rented, or bought, and it routes provider clicks through an internal
redirect so affiliate tags and click analytics can be applied centrally.

The application is intentionally server-rendered at the Cloudflare edge. Astro
renders pages on request, Cloudflare D1 stores the exported SQLite data, and
Cloudflare Pages serves the Worker output. The source DuckDB file is local-only
and is not deployed.

The implementation currently covers Phase 1 through Phase 3 of the product spec:

- DuckDB to SQLite export for D1 import
- Astro 4 SSR application with the Cloudflare adapter
- Shared D1 query helpers
- Affiliate redirect and click logging
- Movie, provider, actor, genre, collection, sitemap, robots, and stats routes
- Homepage search suggestions backed by D1 movie search
- GA4 script loading through Partytown
- TMDB attribution and affiliate disclosure in the shared footer

## Current Data State

`export_to_sqlite.py` now defaults to a full migration of the local DuckDB into
`tmdb_seo.db`. The current exported SQLite database has been verified against
the DuckDB counts:

| Table | Rows |
|---|---:|
| `movies` | 232,916 |
| `movie_providers` | 12,491,535 |
| `movie_genres` | 393,001 |
| `movie_cast` | 918,464 |
| `people` | 347,031 |
| `collections` | 5,001 |
| `genre_platform_index` | 37,257 |

The generated SQLite file is roughly 2.8GB. This is expected for the full
migration and remains below Cloudflare D1's 5GB storage limit at the time this
was implemented.

If a smaller SEO-only database is wanted, run:

```bash
python3 export_to_sqlite.py --seo-filter
```

That mode applies the original Phase 1 filter:

- `popularity > 5`
- `vote_average > 4`
- non-empty overview
- at least one provider offer

## High-Level Architecture

```text
tmdb.duckdb
  -> export_to_sqlite.py
  -> tmdb_seo.db
  -> Cloudflare D1
  -> Astro SSR routes on Cloudflare Pages / Workers
  -> GA4, D1 click_events, sitemap, robots
```

The runtime request flow is:

1. A user requests a page such as `/movie/avatar-fire-and-ash-2025`.
2. Astro SSR runs at the Cloudflare edge.
3. Route code reads `Astro.locals.runtime.env.DB`.
4. Shared helpers in `src/lib/db.ts` query D1.
5. The page renders SEO metadata, canonical URL, JSON-LD, TMDB images, and
   provider links.
6. Provider links point to `/go/[provider]`, not directly to external platforms.
7. `/go/[provider]` logs a click into D1 `click_events`, injects affiliate tags
   where supported, and returns an HTTP 302 redirect.

## Folder Structure

```text
tmdb-seo/
├── README.md
├── package.json
├── package-lock.json
├── astro.config.mjs
├── tsconfig.json
├── wrangler.toml
├── export_to_sqlite.py
├── tmdb_seo.db
├── sql/
│   └── generated SQL dump and chunk files
├── src/
│   ├── env.d.ts
│   ├── middleware.ts
│   ├── layouts/
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── affiliate.ts
│   │   ├── db.ts
│   │   ├── sitemap.ts
│   │   └── site.ts
│   └── pages/
│       ├── index.astro
│       ├── 404.astro
│       ├── movie/
│       │   └── [slug].astro
│       ├── streaming/
│       │   └── [provider]/
│       │       └── [region].astro
│       ├── actor/
│       │   └── [slug].astro
│       ├── genre/
│       │   └── [genre]/
│       │       └── [provider].astro
│       ├── collection/
│       │   └── [id].astro
│       ├── go/
│       │   └── [provider].ts
│       ├── api/
│       │   ├── search.ts
│       │   └── stats.ts
│       ├── robots.txt.ts
│       ├── sitemap-index.xml.ts
│       ├── sitemap-actors.xml.ts
│       ├── sitemap-providers.xml.ts
│       ├── sitemap-movies-1.xml.ts
│       ├── sitemap-movies-2.xml.ts
│       ├── sitemap-movies-3.xml.ts
│       ├── sitemap-movies-4.xml.ts
│       ├── sitemap-movies-5.xml.ts
│       └── sitemap-movies-6.xml.ts
├── dist/
└── node_modules/
```

Generated or local-only files are ignored by `.gitignore`, including:

- `node_modules`
- `dist`
- `.astro`
- `.wrangler`
- `.dev.vars`
- `tmdb_seo.db`
- `*.db-wal`
- `*.db-shm`
- `*.duckdb`
- `*.sql`
- `chunk_*`
- `sql/` dump and chunk contents

## Important Files

### `export_to_sqlite.py`

Exports the local `tmdb.duckdb` into a D1-compatible SQLite database. It searches
for `tmdb.duckdb` in this directory first, then in the parent directory.

Default mode performs a full migration. `--seo-filter` performs the original
filtered Phase 1 export.

The script creates these SQLite tables:

- `movies`
- `movie_providers`
- `movie_genres`
- `movie_cast`
- `people`
- `collections`
- `genre_platform_index`
- `click_events`

It also creates indexes used by the page routes and sitemap routes.

### `astro.config.mjs`

Configures Astro for Cloudflare SSR:

- `output: 'server'`
- `@astrojs/cloudflare` adapter
- `@astrojs/partytown` integration for GA4
- passthrough image service
- `SITE_URL` fallback support

The app uses normal `<img>` tags pointed at `image.tmdb.org`; TMDB images are not
downloaded or self-hosted.

### `wrangler.toml`

Cloudflare Pages and runtime binding configuration. This file still contains
placeholders that must be replaced before deployment:

- D1 database ID
- KV namespace ID
- production site URL
- GA4 measurement ID
- admin key
- affiliate values
- Google Search Console verification code

### `src/env.d.ts`

Defines the Cloudflare runtime bindings exposed through Astro locals:

- `DB`
- `CACHE`
- `SITE_URL`
- `PUBLIC_GA_MEASUREMENT_ID`
- `ADMIN_KEY`
- `AMAZON_AFFILIATE_TAG`
- `APPLE_AFFILIATE_URL`
- `GSC_VERIFICATION_CODE`

### `src/middleware.ts`

Normalizes request paths and blocks Astro's internal `/_image` endpoint with a
404 response. The project does not use Astro image optimization at runtime.

### `src/layouts/Layout.astro`

Shared HTML shell for all pages. It provides:

- `<html lang="en">`
- title, description, canonical URL
- Open Graph metadata
- optional JSON-LD injection
- GA4 loading through Partytown
- Google Search Console verification meta tag when configured
- shared header and footer
- TMDB attribution
- affiliate disclosure
- global CSS

### `src/lib/db.ts`

All D1 query helpers live here. Page routes should use this file instead of
inlining SQL where possible.

Implemented helper areas:

- movie lookup by slug
- movie provider lookup by region
- cast lookup
- provider catalog pages
- actor pages
- collection pages
- genre/provider pages
- top movies for the homepage
- movie search for homepage suggestions and submitted searches
- sitemap queries

### `src/lib/affiliate.ts`

Builds outbound affiliate URLs. Current behavior:

- Amazon and Prime Video providers redirect to Amazon Prime Video search URLs
  with `AMAZON_AFFILIATE_TAG`
- Apple URLs can be wrapped with `APPLE_AFFILIATE_URL`
- unknown providers pass through unchanged
- only `http` and `https` destinations are accepted by the redirect route

### `src/lib/site.ts`

Shared site helpers:

- base URL and canonical URL building
- slug formatting
- meta description truncation
- region display names
- XML escaping
- TMDB image URL helpers
- TMDB attribution constants

### `src/lib/sitemap.ts`

Shared movie sitemap response builder. Movie sitemaps are chunked at 45,000 URLs
per file to stay under Google's 50,000 URL limit.

## Page Routes

### `/`

Homepage with popular movies from the database and a movie title search box.
Client-side suggestions begin after 3 typed characters and use `/api/search`.
Submitted searches render matching movie cards on the homepage.

### `/movie/[slug]`

Movie detail page targeting queries like "where to watch [movie]". It renders:

- SEO title and description
- poster image
- overview, genres, runtime, ratings
- region-aware provider availability
- affiliate redirect links
- cast links
- `schema.org/Movie` JSON-LD
- edge cache header: `public, max-age=3600, stale-while-revalidate=86400`

Region is determined from Cloudflare's `cf-ipcountry` header and defaults to
`US`.

### `/streaming/[provider]/[region]`

Provider catalog page, for example `/streaming/netflix/US`. It renders movies
available through a provider in a region, includes a client-side genre filter,
and emits `schema.org/ItemList` JSON-LD.

Cache header:

```text
public, max-age=43200, stale-while-revalidate=86400
```

### `/actor/[slug]`

Actor streaming guide page. It lists actor movie credits through the indexed
`people` -> `movie_cast` -> `movies` path and emits `schema.org/Person` JSON-LD.
Availability remains on each linked movie page, which avoids scanning the large
`movie_providers` table during actor page rendering.

Cache header:

```text
public, max-age=86400, stale-while-revalidate=604800
```

### `/genre/[genre]/[provider]`

Genre plus provider landing page, such as action movies on Prime Video. It uses
the `genre_platform_index` table for metadata and renders an `ItemList`.

### `/collection/[id]`

Franchise or collection page. It lists movies in release order and shows provider
badges where available.

### `/go/[provider]`

Affiliate redirect endpoint. Every provider link should route through this
endpoint.

It accepts:

- `movie`
- `region`
- `title`
- `dest`

It writes to `click_events` and returns HTTP 302 with:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
```

### `/api/stats`

Admin analytics endpoint for click data. Requires:

```text
x-admin-key: ADMIN_KEY
```

It returns:

- total clicks
- top movies by clicks
- top providers
- top regions
- daily click counts

### `/api/search`

Movie search suggestion endpoint used by the homepage. It returns up to eight
movie suggestions after the query has at least 3 characters.

### Sitemap Routes

Implemented sitemap endpoints:

- `/sitemap-index.xml`
- `/sitemap-movies-1.xml`
- `/sitemap-movies-2.xml`
- `/sitemap-movies-3.xml`
- `/sitemap-movies-4.xml`
- `/sitemap-movies-5.xml`
- `/sitemap-movies-6.xml`
- `/sitemap-actors.xml`
- `/sitemap-providers.xml`

The sitemap index calculates how many movie sitemap chunks are required from the
live D1 movie count. With the current 232,916 movie database, six movie sitemap
files are needed.

### `/robots.txt`

Allows normal crawling and blocks redirect/admin routes:

```text
Disallow: /go/
Disallow: /api/
```

## Deployment Checklist

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Cloudflare Resources

Log in to Cloudflare and create D1 and KV:

```bash
npx wrangler login
npx wrangler d1 create tmdb-seo
npx wrangler kv:namespace create CACHE
```

Copy the generated IDs into `wrangler.toml`.

### 3. Configure `wrangler.toml`

Replace these placeholders:

```toml
database_id = "PASTE_DATABASE_ID_HERE"
id = "PASTE_KV_ID_HERE"
SITE_URL = "https://YOUR_DOMAIN.com"
PUBLIC_GA_MEASUREMENT_ID = "G-XXXXXXXXXX"
ADMIN_KEY = "REPLACE_WITH_LONG_RANDOM_SECRET"
AMAZON_AFFILIATE_TAG = "wheretowatch9-21"
APPLE_AFFILIATE_URL = "https://apple.co/YOUR_APPLE_AFFILIATE_LINK"
GSC_VERIFICATION_CODE = "YOUR_GSC_VERIFICATION_CODE"
```

For production, prefer setting secrets and environment variables in Cloudflare
Pages project settings rather than committing real values.

### 4. Export SQLite

For full data:

```bash
python3 export_to_sqlite.py
```

For the smaller original SEO subset:

```bash
python3 export_to_sqlite.py --seo-filter
```

Verify the SQLite file:

```bash
sqlite3 tmdb_seo.db "PRAGMA integrity_check;"
sqlite3 tmdb_seo.db "SELECT COUNT(*) FROM movies;"
```

### 5. Import Data Into D1

Create a SQL dump:

```bash
mkdir -p sql
sqlite3 tmdb_seo.db .dump > sql/tmdb_seo.sql
```

The full dump is large. Split it before remote import:

```bash
split -b 18m sql/tmdb_seo.sql sql/chunk_
```

Then import each chunk:

```bash
npx wrangler d1 execute tmdb-seo --remote --file=sql/chunk_aa
npx wrangler d1 execute tmdb-seo --remote --file=sql/chunk_ab
```

Continue for every generated chunk.

### 6. Build

```bash
npm run build
```

This runs:

```bash
astro check
astro build
```

The latest verification completed with:

```text
0 errors
0 warnings
0 hints
```

### 7. Deploy To Cloudflare Pages

In Cloudflare Pages:

- Framework preset: Astro
- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: 20.x
- D1 binding: `DB`
- KV binding: `CACHE`

Then connect the repository and deploy from the main branch.

### 8. Configure Analytics And Search

Set:

- `PUBLIC_GA_MEASUREMENT_ID`
- `GSC_VERIFICATION_CODE`

After deployment, submit:

```text
https://YOUR_DOMAIN.com/sitemap-index.xml
```

in Google Search Console.

### 9. Configure Affiliate Programs

Set affiliate values in Cloudflare Pages environment variables:

- `AMAZON_AFFILIATE_TAG`
- `APPLE_AFFILIATE_URL`

Add new provider rules in `src/lib/affiliate.ts` as additional affiliate
programs are approved.

## Local Development Notes

Normal Astro development:

```bash
npm run dev
```

Cloudflare-bound local runtime testing requires workerd. The current local
machine reported macOS 12.6, while Cloudflare workerd requires macOS 13.5 or
newer. Use macOS 13.5+ or a Linux DevContainer for local D1-bound testing.

The generated SQLite database is ignored by git. If another machine needs the
database, regenerate it from `tmdb.duckdb` or transfer it outside git.

## Verification Commands

Useful checks:

```bash
python3 -m py_compile export_to_sqlite.py
sqlite3 tmdb_seo.db "PRAGMA integrity_check;"
sqlite3 tmdb_seo.db "SELECT COUNT(*) FROM movies;"
npm run build
```

Expected full migration counts:

```text
movies                 232916
movie_providers        12491535
movie_genres           393001
movie_cast             918464
people                 347031
collections            5001
genre_platform_index   37257
```

## Known Caveats

- The full SQLite database is large, around 2.8GB. D1 import will take time and
  should be done in chunks.
- `npm audit` reports advisories in the Astro 4 / Cloudflare adapter dependency
  chain. The spec fixes Astro 4.x, so this was not force-upgraded to Astro 6.
  Review this before production launch.
- The app currently implements Phase 1 through Phase 3. Phase 4 through Phase 6
  items, including full analytics setup, production Cloudflare deployment, and
  nightly sync workflows, still need real account credentials and project
  decisions before implementation.
