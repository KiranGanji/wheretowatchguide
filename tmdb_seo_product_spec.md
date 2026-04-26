# TMDB Streaming Guide — Product Specification
### AI Agent Build Brief · Version 1.0

---

## Purpose of This Document

This document is a complete, end-to-end product specification for an AI coding agent to build, deploy, and operate a large-scale SEO content site that monetises the TMDB (The Movie Database) dataset.

**Read this document in full before writing a single line of code.** Every section is load-bearing. Decisions made in the data layer affect the analytics layer; decisions made in the routing layer affect the sitemap; decisions made in the affiliate layer affect the daily sync. Understand the whole system first, then implement phase by phase in the order given.

The spec is intentionally prescriptive about technology choices. Do not substitute alternatives unless a stated tool is genuinely unavailable. Where flexibility exists, it is marked explicitly.

---

## What We Are Building

A programmatically-generated streaming guide website with 50,000–200,000+ pages targeting high-volume search queries such as:

- *"Where to watch Inception"*
- *"Movies on Netflix India right now"*
- *"Tom Hanks movies on Prime Video"*
- *"Action movies streaming in the UK"*

Every page surface relevant streaming providers for that movie/actor/platform/region combination, with affiliate links to Amazon Prime Video, Apple TV+, and other monetised platforms. When a user clicks through and rents, buys, or signs up, the site earns a commission.

The site is a **data product**, not a content product. The value comes from freshness (nightly TMDB sync), completeness (1.17M movies, 13M+ watch offers), and SEO correctness (structured data, canonical URLs, sitemaps, Core Web Vitals). No human writes any page. The AI agent builds the pipeline; the pipeline produces the pages.

---

## The Data Asset

The builder has an existing **DuckDB database** (`tmdb.duckdb`) that has been pre-populated with TMDB data. This is the source of truth.

### Key table counts (as of build date)

| Table | Rows |
|---|---|
| `movies` | 1,177,409 |
| `movie_watch_provider_offers` | 13,082,647 |
| `movie_watch_provider_links` | 5,953,791 |
| `people` (actors, directors) | 3,999,522 |
| `watch_providers` | 814 |
| `genres` | 19 |
| `keywords` | 71,033 |
| `movie_cast_credits` | 7,367,267 |

### Critical join paths

```
movies.id
  → movie_watch_provider_offers.movie_id → watch_providers.provider_id
  → movie_watch_provider_links.movie_id  (region landing page URL)
  → movie_cast_credits.movie_id          → people.person_id
  → movie_genre_map.movie_id             → genres.genre_id
  → movie_release_dates.movie_id
```

### Key columns on `movies`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | TMDB movie ID, primary key |
| `title` | TEXT | Display title |
| `overview` | TEXT | Plot summary — used as meta description base |
| `release_date` | DATE | Used to disambiguate slugs (e.g. `inception-2010`) |
| `vote_average` | REAL | 0–10 rating |
| `vote_count` | INTEGER | Used to gate `aggregateRating` JSON-LD |
| `popularity` | REAL | TMDB popularity score — primary sort for page priority |
| `poster_path` | TEXT | Relative path — prefix with `https://image.tmdb.org/t/p/w500` |
| `backdrop_path` | TEXT | Relative path — prefix with `https://image.tmdb.org/t/p/original` |
| `runtime` | INTEGER | Minutes |
| `tagline` | TEXT | Secondary display text |
| `collection_id` | INTEGER | Franchise grouping |
| `collection_name` | TEXT | Franchise name |

### `movie_watch_provider_offers` key columns

| Column | Notes |
|---|---|
| `movie_id` | Foreign key to `movies.id` |
| `region` | ISO 3166-1 alpha-2 (e.g. `IN`, `US`, `GB`) |
| `provider_id` | Foreign key to `watch_providers.provider_id` |
| `type` | `flatrate` / `rent` / `buy` / `free` / `ads` |
| `display_priority` | Lower = show first |

---

## Architecture Overview

```
DuckDB (source)
    ↓  export_to_sqlite.py (one-time + nightly delta)
Cloudflare D1 (SQLite, edge-native)
    ↓  queried by
Astro SSR pages (Cloudflare Workers)
    ↓  served via
Cloudflare Pages (CDN + edge cache)
    ↓  tracked by
GA4 + Google Search Console + D1 click_events table
    ↓  synced nightly by
GitHub Actions → TMDB API → DuckDB → D1 delta push
```

### Why Astro (not Next.js)

Next.js on Cloudflare Pages requires the `@cloudflare/next-on-pages` adapter which has documented limitations: no Node.js `fs` APIs, partial App Router support, and complex bundle configuration. Astro's Cloudflare adapter is first-party, production-ready, and outputs zero client-side JavaScript by default — the correct default for a pure-content SEO site. React components can be added as Astro islands wherever interactivity is genuinely needed.

### Why Cloudflare D1

- Native SQLite — the DuckDB export pipeline goes DuckDB → SQLite → D1 with no schema translation
- 5GB free, 25M reads/day free — fits the entire filtered dataset comfortably
- Edge-native — queries execute at the Cloudflare PoP closest to the user, not a centralised DB server
- `wrangler d1` CLI makes local development and production pushes identical

---

## Tech Stack (fixed — do not substitute)

| Layer | Technology |
|---|---|
| Framework | Astro 4.x with `@astrojs/cloudflare` adapter |
| Runtime | Cloudflare Workers (via Astro SSR) |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV |
| Hosting | Cloudflare Pages |
| CDN / SSL / DDoS | Cloudflare (automatic) |
| CI/CD | GitHub Actions |
| Analytics — traffic | Google Analytics 4 (GA4) |
| Analytics — search | Google Search Console |
| Analytics — affiliate | D1 `click_events` table + `/api/stats` endpoint |
| GA4 loading strategy | `@astrojs/partytown` (loads GA4 in Web Worker — required for Core Web Vitals) |
| Sitemap | `@astrojs/sitemap` + custom chunked sitemap routes |
| Structured data | schema.org JSON-LD injected per page type |
| Source DB | DuckDB (local machine, not deployed) |
| Image CDN | TMDB image CDN (`image.tmdb.org`) — no self-hosting required |

---

## Phase 1 — Data Layer

### 1.1 Install Wrangler and create D1 database

```bash
npm install -g wrangler
wrangler login
wrangler d1 create tmdb-seo
# Save the database_id printed — required in wrangler.toml
wrangler kv:namespace create CACHE
# Save the kv id printed — required in wrangler.toml
```

### 1.2 Export DuckDB → SQLite (`export_to_sqlite.py`)

Create this file at the project root. It reads from the existing `tmdb.duckdb` and writes a filtered `tmdb_seo.db` (SQLite) containing only the data needed for page generation.

**Filter criteria:**
- `movies.popularity > 5`
- `movies.vote_average > 4`
- `movies.overview IS NOT NULL`
- Movie must have at least one row in `movie_watch_provider_offers`

**Slug generation rule:** `LOWER(REGEXP_REPLACE(title, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || YEAR(release_date)`
Example: `"Inception" (2010)` → `inception-2010`

```python
import duckdb, sqlite3

src = duckdb.connect('tmdb.duckdb', read_only=True)
dst = sqlite3.connect('tmdb_seo.db')
dst.execute('PRAGMA journal_mode=WAL')
dst.execute('PRAGMA synchronous=NORMAL')

# MOVIES
dst.execute("""
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY,
  title TEXT,
  original_title TEXT,
  overview TEXT,
  release_date TEXT,
  vote_average REAL,
  vote_count INTEGER,
  popularity REAL,
  poster_path TEXT,
  backdrop_path TEXT,
  runtime INTEGER,
  tagline TEXT,
  collection_id INTEGER,
  collection_name TEXT,
  slug TEXT UNIQUE
)""")

rows = src.execute("""
  SELECT m.id, m.title, m.original_title, m.overview,
         CAST(m.release_date AS VARCHAR),
         CAST(m.vote_average AS REAL),
         CAST(m.vote_count AS INTEGER),
         CAST(m.popularity AS REAL),
         m.poster_path, m.backdrop_path,
         m.runtime, m.tagline,
         m.collection_id, m.collection_name,
         LOWER(REGEXP_REPLACE(m.title, '[^a-zA-Z0-9]+', '-', 'g'))
           || '-' || YEAR(m.release_date::DATE) AS slug
  FROM movies m
  WHERE m.popularity > 5
    AND m.vote_average > 4
    AND m.overview IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM movie_watch_provider_offers o WHERE o.movie_id = m.id
    )
""").fetchall()
dst.executemany("INSERT OR REPLACE INTO movies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
print(f'movies: {len(rows)}')

# WATCH PROVIDERS
dst.execute("""
CREATE TABLE IF NOT EXISTS movie_providers (
  movie_id INTEGER,
  region TEXT,
  provider_id INTEGER,
  provider_name TEXT,
  type TEXT,
  display_priority INTEGER,
  link TEXT
)""")

rows = src.execute("""
  SELECT o.movie_id, o.region, o.provider_id, p.provider,
         o.type, o.display_priority, l.link
  FROM movie_watch_provider_offers o
  JOIN watch_providers p ON p.provider_id = o.provider_id
  LEFT JOIN movie_watch_provider_links l
         ON l.movie_id = o.movie_id AND l.region = o.region
  WHERE EXISTS (
    SELECT 1 FROM movies m WHERE m.id = o.movie_id
    AND m.popularity > 5 AND m.vote_average > 4
  )
""").fetchall()
dst.executemany("INSERT INTO movie_providers VALUES (?,?,?,?,?,?,?)", rows)
print(f'provider offers: {len(rows)}')

# GENRES
dst.execute("""
CREATE TABLE IF NOT EXISTS movie_genres (
  movie_id INTEGER, genre_id INTEGER, genre TEXT
)""")
rows = src.execute("""
  SELECT mg.movie_id, mg.genre_id, g.genre
  FROM movie_genre_map mg
  JOIN genres g ON g.genre_id = mg.genre_id
  JOIN movies m ON m.id = mg.movie_id
  WHERE m.popularity > 5
""").fetchall()
dst.executemany("INSERT INTO movie_genres VALUES (?,?,?)", rows)
print(f'genres: {len(rows)}')

# CAST (top 5 per movie only — display purposes)
dst.execute("""
CREATE TABLE IF NOT EXISTS movie_cast (
  movie_id INTEGER,
  person_id INTEGER,
  name TEXT,
  character_name TEXT,
  cast_order INTEGER
)""")
rows = src.execute("""
  SELECT c.movie_id, c.person_id, p.name, c.character, c."order"
  FROM movie_cast_credits c
  JOIN people p ON p.person_id = c.person_id
  JOIN movies m ON m.id = c.movie_id
  WHERE m.popularity > 5 AND c."order" < 5
""").fetchall()
dst.executemany("INSERT INTO movie_cast VALUES (?,?,?,?,?)", rows)
print(f'cast: {len(rows)}')

# PEOPLE (actors with enough credited movies — for actor pages)
dst.execute("""
CREATE TABLE IF NOT EXISTS people (
  person_id INTEGER PRIMARY KEY,
  name TEXT,
  slug TEXT UNIQUE
)""")
rows = src.execute("""
  SELECT DISTINCT p.person_id, p.name,
    LOWER(REGEXP_REPLACE(p.name, '[^a-zA-Z0-9]+', '-', 'g')) AS slug
  FROM people p
  JOIN movie_cast_credits c ON c.person_id = p.person_id
  JOIN movies m ON m.id = c.movie_id
  WHERE m.popularity > 5
""").fetchall()
dst.executemany("INSERT OR REPLACE INTO people VALUES (?,?,?)", rows)
print(f'people: {len(rows)}')

# CLICK EVENTS (affiliate tracking — starts empty)
dst.execute("""
CREATE TABLE IF NOT EXISTS click_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id INTEGER,
  provider TEXT,
  region TEXT,
  ts INTEGER,
  ua TEXT,
  ref TEXT
)""")

# INDEXES
dst.executescript("""
  CREATE INDEX IF NOT EXISTS idx_mp_movie     ON movie_providers(movie_id);
  CREATE INDEX IF NOT EXISTS idx_mp_region    ON movie_providers(region);
  CREATE INDEX IF NOT EXISTS idx_mp_provider  ON movie_providers(provider_name);
  CREATE INDEX IF NOT EXISTS idx_mp_type      ON movie_providers(type);
  CREATE INDEX IF NOT EXISTS idx_mg_movie     ON movie_genres(movie_id);
  CREATE INDEX IF NOT EXISTS idx_mc_movie     ON movie_cast(movie_id);
  CREATE INDEX IF NOT EXISTS idx_movies_slug  ON movies(slug);
  CREATE INDEX IF NOT EXISTS idx_movies_pop   ON movies(popularity DESC);
  CREATE INDEX IF NOT EXISTS idx_movies_coll  ON movies(collection_id);
  CREATE INDEX IF NOT EXISTS idx_people_slug  ON people(slug);
""")

dst.commit()
dst.close()
src.close()
print('Export complete → tmdb_seo.db')
```

### 1.3 Push SQLite to Cloudflare D1

```bash
# Generate SQL dump from SQLite
sqlite3 tmdb_seo.db .dump > tmdb_seo.sql

# If tmdb_seo.sql > 20MB, split it:
split -b 18m tmdb_seo.sql chunk_

# Push each chunk (local first to verify, then remote)
wrangler d1 execute tmdb-seo --local  --file=tmdb_seo.sql
wrangler d1 execute tmdb-seo --remote --file=tmdb_seo.sql
# For chunks: wrangler d1 execute tmdb-seo --remote --file=chunk_aa
#             wrangler d1 execute tmdb-seo --remote --file=chunk_ab  ... etc.
```

---

## Phase 2 — Framework Setup

### 2.1 Scaffold Astro project

```bash
npm create astro@latest tmdb-seo -- --template minimal --typescript strict
cd tmdb-seo
npx astro add cloudflare
npx astro add partytown
npm install @astrojs/sitemap
```

### 2.2 `astro.config.mjs`

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import partytown from '@astrojs/partytown';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    mode: 'directory',
    functionPerRoute: false,
  }),
  integrations: [
    sitemap(),
    partytown({
      config: { forward: ['dataLayer.push'] },
    }),
  ],
  site: 'https://YOUR_DOMAIN.com',
});
```

### 2.3 `wrangler.toml`

```toml
name = "tmdb-seo"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "./dist"

[[d1_databases]]
binding = "DB"
database_name = "tmdb-seo"
database_id = "PASTE_DATABASE_ID_HERE"

[[kv_namespaces]]
binding = "CACHE"
id = "PASTE_KV_ID_HERE"

[vars]
GA_MEASUREMENT_ID = "G-XXXXXXXXXX"
ADMIN_KEY = "REPLACE_WITH_LONG_RANDOM_SECRET"
AMAZON_AFFILIATE_TAG = "your-tag-20"
```

### 2.4 `src/lib/db.ts` — D1 query helpers

```ts
import type { D1Database } from '@cloudflare/workers-types';

export async function getMovie(db: D1Database, slug: string) {
  return db.prepare(
    `SELECT m.*, GROUP_CONCAT(DISTINCT g.genre) as genres
     FROM movies m
     LEFT JOIN movie_genres g ON g.movie_id = m.id
     WHERE m.slug = ?
     GROUP BY m.id`
  ).bind(slug).first();
}

export async function getMovieProviders(
  db: D1Database,
  movieId: number,
  region = 'US'
) {
  const { results } = await db.prepare(
    `SELECT provider_name, type, link, display_priority
     FROM movie_providers
     WHERE movie_id = ? AND region = ?
     ORDER BY type, display_priority`
  ).bind(movieId, region).all();
  return results;
}

export async function getMovieCast(db: D1Database, movieId: number) {
  const { results } = await db.prepare(
    `SELECT name, character_name, cast_order
     FROM movie_cast
     WHERE movie_id = ?
     ORDER BY cast_order
     LIMIT 6`
  ).bind(movieId).all();
  return results;
}

export async function getProviderMovies(
  db: D1Database,
  providerName: string,
  region: string,
  limit = 200
) {
  const { results } = await db.prepare(
    `SELECT DISTINCT m.id, m.title, m.slug, m.poster_path,
            m.vote_average, m.release_date, mp.type
     FROM movie_providers mp
     JOIN movies m ON m.id = mp.movie_id
     WHERE mp.provider_name = ? AND mp.region = ?
     ORDER BY m.popularity DESC
     LIMIT ?`
  ).bind(providerName, region, limit).all();
  return results;
}

export async function getActorMovies(db: D1Database, actorSlug: string) {
  const { results } = await db.prepare(
    `SELECT m.id, m.title, m.slug, m.poster_path, m.release_date,
            mc.character_name,
            GROUP_CONCAT(DISTINCT mp.provider_name) as providers
     FROM people p
     JOIN movie_cast mc ON mc.person_id = p.person_id
     JOIN movies m ON m.id = mc.movie_id
     LEFT JOIN movie_providers mp
            ON mp.movie_id = m.id AND mp.type = 'flatrate'
     WHERE p.slug = ?
     GROUP BY m.id
     ORDER BY m.release_date DESC`
  ).bind(actorSlug).all();
  return results;
}

export async function getCollectionMovies(db: D1Database, collectionId: number) {
  const { results } = await db.prepare(
    `SELECT m.id, m.title, m.slug, m.poster_path, m.release_date,
            m.vote_average,
            GROUP_CONCAT(DISTINCT mp.provider_name) as providers
     FROM movies m
     LEFT JOIN movie_providers mp
            ON mp.movie_id = m.id AND mp.type = 'flatrate'
     WHERE m.collection_id = ?
     GROUP BY m.id
     ORDER BY m.release_date ASC`
  ).bind(collectionId).all();
  return results;
}
```

### 2.5 `src/lib/affiliate.ts` — affiliate URL builder

```ts
const AMAZON_TAG = import.meta.env.AMAZON_AFFILIATE_TAG || '';

export function buildAffiliateUrl(provider: string, destinationUrl: string): string {
  const p = provider.toLowerCase();

  if (p.includes('amazon') || p.includes('prime')) {
    try {
      const u = new URL(destinationUrl);
      u.searchParams.set('tag', AMAZON_TAG);
      return u.toString();
    } catch {
      return destinationUrl;
    }
  }

  // Apple TV+ — affiliate added at Impact.com level via redirect domain
  if (p.includes('apple')) {
    return `https://apple.co/YOUR_APPLE_AFFILIATE_LINK?dest=${encodeURIComponent(destinationUrl)}`;
  }

  // Default: pass through with no modification
  return destinationUrl;
}
```

### 2.6 `src/layouts/Layout.astro` — base layout with GA4

```astro
---
interface Props {
  title: string;
  description: string;
  jsonLd?: Record<string, unknown>;
  canonical?: string;
}
const { title, description, jsonLd, canonical } = Astro.props;
const GA_ID = import.meta.env.PUBLIC_GA_MEASUREMENT_ID;
const canonicalUrl = canonical ?? Astro.url.href;
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonicalUrl} />

  <!-- Open Graph -->
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:type" content="website" />
  <meta property="og:url" content={canonicalUrl} />

  <!-- GA4 via Partytown (non-blocking — critical for Core Web Vitals) -->
  <script type="text/partytown" src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}></script>
  <script type="text/partytown" define:vars={{ GA_ID }}>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', GA_ID, {
      page_title: document.title,
      page_location: window.location.href,
      send_page_view: true,
    });
  </script>

  <!-- GSC verification meta tag -->
  <meta name="google-site-verification" content="YOUR_GSC_VERIFICATION_CODE" />

  <!-- JSON-LD Structured Data -->
  {jsonLd && (
    <script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />
  )}
</head>
<body>
  <slot />
</body>
</html>
```

---

## Phase 3 — Page Routes

### 3.1 Complete route map

```
src/pages/
  movie/[slug].astro                    ← "where to watch [movie]"
  streaming/[provider]/[region].astro   ← "movies on Netflix IN"
  actor/[slug].astro                    ← "Tom Hanks streaming"
  genre/[genre]/[provider].astro        ← "action on Prime Video"
  collection/[id].astro                 ← franchise pages
  go/[provider].ts                      ← affiliate redirect + click log
  api/stats.ts                          ← admin analytics endpoint
  sitemap-index.xml.ts                  ← sitemap index
  sitemap-movies-1.xml.ts               ← 45K movies chunk 1
  sitemap-movies-2.xml.ts               ← 45K movies chunk 2
  sitemap-actors.xml.ts
  sitemap-providers.xml.ts
  robots.txt.ts
```

### 3.2 Movie page (`src/pages/movie/[slug].astro`)

**Target queries:** "where to watch [title]", "[title] streaming", "[title] online [country]"

**SEO title format:** `Where to Watch [Title] ([Year]) — Streaming, Rent & Buy Guide`

**Meta description format:** `Find out where to stream, rent or buy [Title] ([Year]). Available on [Provider 1], [Provider 2] and more. Updated [Month Year].`

**JSON-LD type:** `schema.org/Movie` with `aggregateRating` (only if `vote_count > 10`) and `potentialAction: WatchAction` for each provider with a link.

**Geo detection:** Read `Astro.request.headers.get('cf-ipcountry')` — Cloudflare injects this header automatically on every request. Default to `'US'` if null. Use this to query `movie_providers` for the correct region.

**Caching:** Set `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` on the response. This caches the rendered page at the Cloudflare edge for 1 hour, then serves stale while refreshing in the background.

**Affiliate links:** All provider links must route through `/go/[provider]?movie=[id]&region=[region]&dest=[encoded_url]` — never link directly to provider URLs. This enables click tracking and affiliate tag injection without redeploying.

**GA4 click event:** Each provider link must fire:
```js
gtag('event', 'affiliate_click', {
  provider: 'Netflix',
  movie_id: '123',
  region: 'IN',
  offer_type: 'flatrate'
});
```

**Full implementation:**

```astro
---
export const prerender = false;
import Layout from '../../layouts/Layout.astro';
import { getMovie, getMovieProviders, getMovieCast } from '../../lib/db';
import { buildAffiliateUrl } from '../../lib/affiliate';

const { slug } = Astro.params;
const env = Astro.locals.runtime.env;
const db = env.DB;

const movie = await getMovie(db, slug);
if (!movie) return Astro.redirect('/404');

const region = Astro.request.headers.get('cf-ipcountry') || 'US';
const providers = await getMovieProviders(db, movie.id as number, region);
const cast = await getMovieCast(db, movie.id as number);

const year = movie.release_date ? String(movie.release_date).slice(0, 4) : '';
const topProviders = providers.slice(0, 3).map((p: any) => p.provider_name).join(', ');

const title = `Where to Watch ${movie.title}${year ? ` (${year})` : ''} — Streaming, Rent & Buy Guide`;
const description = `Find out where to stream, rent or buy ${movie.title}${year ? ` (${year})` : ''}. Available on ${topProviders || 'multiple platforms'} and more. Updated ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.`;

const jsonLd: Record<string, unknown> = {
  '@context': 'https://schema.org',
  '@type': 'Movie',
  name: movie.title,
  description: movie.overview,
  dateCreated: movie.release_date,
  image: movie.poster_path
    ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
    : undefined,
  ...(Number(movie.vote_count) > 10 && {
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: Number(movie.vote_average).toFixed(1),
      ratingCount: movie.vote_count,
      bestRating: '10',
      worstRating: '1',
    },
  }),
  potentialAction: providers
    .filter((p: any) => p.link)
    .map((p: any) => ({
      '@type': 'WatchAction',
      target: { '@type': 'EntryPoint', urlTemplate: p.link },
    })),
};

Astro.response.headers.set(
  'Cache-Control',
  'public, max-age=3600, stale-while-revalidate=86400'
);

const offerTypes = ['flatrate', 'free', 'ads', 'rent', 'buy'];
const offerLabels: Record<string, string> = {
  flatrate: 'Stream with subscription',
  free: 'Watch free',
  ads: 'Watch with ads',
  rent: 'Rent',
  buy: 'Buy',
};
---
<Layout title={title} description={description} jsonLd={jsonLd}>
  <main>
    <h1>Where to Watch {movie.title}</h1>
    {movie.tagline && <p><em>{movie.tagline}</em></p>}
    <p>{movie.overview}</p>

    {movie.poster_path && (
      <img
        src={`https://image.tmdb.org/t/p/w342${movie.poster_path}`}
        alt={`${movie.title} poster`}
        width="342"
        height="513"
        loading="lazy"
      />
    )}

    <section aria-label="Streaming availability">
      <h2>Where to Watch</h2>
      {providers.length === 0 && (
        <p>Not currently available for streaming in your region ({region}).</p>
      )}
      {offerTypes.map(type => {
        const group = (providers as any[]).filter(p => p.type === type);
        if (!group.length) return null;
        return (
          <div>
            <h3>{offerLabels[type]}</h3>
            {group.map((p: any) => {
              const goUrl = `/go/${encodeURIComponent(p.provider_name)}?movie=${movie.id}&region=${region}&dest=${encodeURIComponent(p.link || '')}`;
              const gaEvent = `gtag('event','affiliate_click',{provider:'${p.provider_name}',movie_id:'${movie.id}',region:'${region}',offer_type:'${type}'})`;
              return (
                <a href={goUrl} onclick={gaEvent} rel="noopener">
                  {p.provider_name}
                </a>
              );
            })}
          </div>
        );
      })}
    </section>

    {cast.length > 0 && (
      <section>
        <h2>Cast</h2>
        <ul>
          {(cast as any[]).map(c => (
            <li>
              <a href={`/actor/${c.slug}`}>{c.name}</a>
              {c.character_name && ` as ${c.character_name}`}
            </li>
          ))}
        </ul>
      </section>
    )}

    {movie.vote_count && Number(movie.vote_count) > 10 && (
      <p>Rating: {Number(movie.vote_average).toFixed(1)}/10 ({Number(movie.vote_count).toLocaleString()} votes)</p>
    )}
  </main>
</Layout>
```

### 3.3 Affiliate redirect route (`src/pages/go/[provider].ts`)

This is the most critical route for monetisation. Every outbound streaming link must pass through here.

```ts
export const prerender = false;

import { buildAffiliateUrl } from '../../lib/affiliate';

export async function GET({ params, request, locals }: any) {
  const env = locals.runtime.env;
  const url = new URL(request.url);
  const dest     = url.searchParams.get('dest') || '';
  const movieId  = url.searchParams.get('movie') || '';
  const region   = url.searchParams.get('region') || 'US';
  const provider = decodeURIComponent(params.provider || '');

  if (!dest) return new Response('Bad request', { status: 400 });

  // Non-blocking click log — fire and forget
  env.DB.prepare(
    `INSERT INTO click_events (movie_id, provider, region, ts, ua, ref)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    parseInt(movieId) || null,
    provider,
    region,
    Date.now(),
    (request.headers.get('user-agent') || '').slice(0, 200),
    (request.headers.get('referer') || '').slice(0, 500)
  ).run();

  const affiliateUrl = buildAffiliateUrl(provider, dest);

  return new Response(null, {
    status: 302,
    headers: {
      Location: affiliateUrl,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
```

### 3.4 Platform index page (`src/pages/streaming/[provider]/[region].astro`)

**Target queries:** "movies on Netflix India", "what's on Prime Video US", "new on Disney+ UK"

**SEO title format:** `Movies on [Provider] in [Country Name] — Full List [Year]`

**Caching:** `max-age=43200` (12 hours) — provider catalogues change less frequently than individual movie provider data.

**Implementation:** Query `getProviderMovies(db, provider, region)`. Display as a paginated list with genre filters (client-side JS island). Include `lastmod` in sitemap.

### 3.5 Actor page (`src/pages/actor/[slug].astro`)

**Target queries:** "Tom Hanks movies on Netflix", "where to watch Tom Hanks films"

**SEO title format:** `[Actor Name] — Movies & Streaming Guide`

**Meta description:** `Browse all [Actor Name] movies and find out where to watch them. Stream on [top providers]. Full filmography with streaming links.`

**JSON-LD type:** `schema.org/Person` with `name`, `sameAs` pointing to TMDB person URL.

**Implementation:** Query `getActorMovies(db, actorSlug)`. Group results by "available to stream" vs "not available". Show provider badges on each movie.

### 3.6 Sitemap generation

Google's sitemap limit is 50,000 URLs per file. Use a sitemap index pointing to chunked sub-sitemaps.

```ts
// src/pages/sitemap-index.xml.ts
export const prerender = false;
export async function GET() {
  const base = 'https://YOUR_DOMAIN.com';
  const sitemaps = [
    `${base}/sitemap-movies-1.xml`,
    `${base}/sitemap-movies-2.xml`,
    `${base}/sitemap-actors.xml`,
    `${base}/sitemap-providers.xml`,
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map(s => `  <sitemap><loc>${s}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml' }
  });
}
```

```ts
// src/pages/sitemap-movies-1.xml.ts
export const prerender = false;
export async function GET({ locals }: any) {
  const db = locals.runtime.env.DB;
  const { results } = await db.prepare(
    `SELECT slug, release_date FROM movies ORDER BY popularity DESC LIMIT 45000`
  ).all();

  const today = new Date().toISOString().slice(0, 10);
  const urls = (results as any[]).map(m => `
  <url>
    <loc>https://YOUR_DOMAIN.com/movie/${m.slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`,
    { headers: { 'Content-Type': 'application/xml' } }
  );
}
```

```ts
// src/pages/robots.txt.ts
export async function GET() {
  return new Response(
    `User-agent: *\nAllow: /\nDisallow: /go/\nDisallow: /api/\nSitemap: https://YOUR_DOMAIN.com/sitemap-index.xml`,
    { headers: { 'Content-Type': 'text/plain' } }
  );
}
```

### 3.7 Admin analytics endpoint (`src/pages/api/stats.ts`)

```ts
export const prerender = false;
export async function GET({ request, locals }: any) {
  const env = locals.runtime.env;
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY)
    return new Response('Forbidden', { status: 403 });

  const db = env.DB;
  const [total, topMovies, topProviders, topRegions, daily] = await Promise.all([
    db.prepare('SELECT COUNT(*) as total FROM click_events').first(),
    db.prepare(`SELECT movie_id, COUNT(*) as clicks FROM click_events
                GROUP BY movie_id ORDER BY clicks DESC LIMIT 20`).all(),
    db.prepare(`SELECT provider, COUNT(*) as clicks FROM click_events
                GROUP BY provider ORDER BY clicks DESC LIMIT 10`).all(),
    db.prepare(`SELECT region, COUNT(*) as clicks FROM click_events
                GROUP BY region ORDER BY clicks DESC LIMIT 10`).all(),
    db.prepare(`SELECT DATE(ts/1000,'unixepoch') as day, COUNT(*) as clicks
                FROM click_events
                GROUP BY day ORDER BY day DESC LIMIT 30`).all(),
  ]);

  return Response.json({
    total,
    topMovies: topMovies.results,
    topProviders: topProviders.results,
    topRegions: topRegions.results,
    daily: daily.results,
  });
}
```

Access with: `curl -H "x-admin-key: YOUR_SECRET" https://yoursite.com/api/stats`

---

## Phase 4 — Analytics Setup

### 4.1 Google Analytics 4

1. Go to [analytics.google.com](https://analytics.google.com) → Admin → Create Property
2. Platform: Web. Enter your domain.
3. Copy the Measurement ID (format: `G-XXXXXXXXXX`)
4. Set `PUBLIC_GA_MEASUREMENT_ID = G-XXXXXXXXXX` in Cloudflare Pages environment variables
5. The GA4 script is already embedded in `Layout.astro` via Partytown — no further setup needed in code

**GA4 custom events to configure (mark as conversions in GA4 Admin):**

| Event name | Parameters | Description |
|---|---|---|
| `affiliate_click` | `provider`, `movie_id`, `region`, `offer_type` | Every outbound streaming link click |
| `provider_page_view` | `provider`, `region` | Views of platform index pages |

**Key reports to review weekly:**
- Acquisition → Traffic acquisition → Organic search (volume from Google)
- Engagement → Pages and screens (which movie pages get traffic)
- Events → `affiliate_click` (which providers + movies convert)
- Demographics → Geo → Country (confirm India/US/UK split as expected)

### 4.2 Google Search Console

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Add property → URL prefix → enter `https://YOUR_DOMAIN.com`
3. Verify via HTML meta tag (already in Layout.astro — replace placeholder with actual code)
4. After deployment: Sitemaps → submit `https://YOUR_DOMAIN.com/sitemap-index.xml`
5. Request indexing for the top 100 highest-popularity movie pages manually via URL Inspection

**GSC data to monitor weekly:**

| Report | What to look for |
|---|---|
| Performance → Queries | Queries with impressions but zero clicks = bad title/meta |
| Performance → Queries | Queries ranking position 11–20 = optimise these pages first |
| Performance → Pages | Pages with CTR < 1% = rewrite title tags |
| Coverage | Crawled but not indexed, excluded pages |
| Enhancements → Movies | Confirm Movie rich results are being parsed |
| Core Web Vitals | Any LCP or CLS regressions |

### 4.3 Looker Studio dashboard (free — connect GA4 + GSC)

1. Go to [lookerstudio.google.com](https://lookerstudio.google.com)
2. Create report → Add data source → Google Search Console → select property → use "Site Impression" table
3. Add second data source → Google Analytics 4 → select property
4. Build a single dashboard with:
   - GSC: impressions + clicks + average position over time (line chart)
   - GSC: top queries table with CTR column
   - GA4: sessions from organic search (blended with GSC via date dimension)
   - GA4: affiliate_click events by provider (bar chart)
   - GA4: top pages by session count (table)

---

## Phase 5 — Cloudflare Deployment

### 5.1 First deploy

```bash
# Build
npm run build

# Local test with real D1
npx wrangler pages dev ./dist \
  --d1=DB=tmdb-seo \
  --kv=CACHE \
  --binding=GA_MEASUREMENT_ID=G-TEST \
  --binding=ADMIN_KEY=test-secret

# Push to Cloudflare Pages
git add . && git commit -m "initial deploy"
git push origin main
```

### 5.2 Cloudflare Pages project settings

In the Cloudflare dashboard → Pages → your project → Settings:

| Setting | Value |
|---|---|
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | (leave blank) |
| Node.js version | 20.x |

Under **Functions → D1 database bindings:**
- Variable name: `DB` → D1 database: `tmdb-seo`

Under **Functions → KV namespace bindings:**
- Variable name: `CACHE` → KV namespace: `(your namespace)`

Under **Environment variables → Production:**
```
PUBLIC_GA_MEASUREMENT_ID  =  G-XXXXXXXXXX
ADMIN_KEY                 =  (long random secret)
AMAZON_AFFILIATE_TAG      =  your-tag-20
```

### 5.3 Custom domain

Pages project → Custom domains → Add domain → enter your domain. If domain is on Cloudflare DNS, it auto-configures with SSL and CDN proxying. If on external registrar, update nameservers to Cloudflare's.

### 5.4 Cache headers by route type

| Route | `Cache-Control` value |
|---|---|
| `/movie/[slug]` | `public, max-age=3600, stale-while-revalidate=86400` |
| `/streaming/[provider]/[region]` | `public, max-age=43200, stale-while-revalidate=86400` |
| `/actor/[slug]` | `public, max-age=86400, stale-while-revalidate=604800` |
| `/go/[provider]` | `no-store` |
| `/sitemap*.xml` | `public, max-age=86400` |
| `/robots.txt` | `public, max-age=86400` |

### 5.5 Purge Cloudflare cache after D1 updates

```bash
# After nightly D1 update, purge all cache
curl -X POST "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

---

## Phase 6 — Daily Sync (GitHub Actions)

### 6.1 `.github/workflows/daily-sync.yml`

```yaml
name: Daily TMDB sync

on:
  schedule:
    - cron: '0 2 * * *'    # 2:00 AM UTC daily
  workflow_dispatch:          # allow manual trigger from GitHub UI

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 120

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install Python dependencies
        run: pip install duckdb requests --break-system-packages

      - name: Download new TMDB IDs
        run: python step1_download_ids.py
        env:
          TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}

      - name: Fetch updated movie details
        run: python step2_fetch_details.py
        env:
          TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}

      - name: Export delta to SQLite
        run: python export_delta_to_sqlite.py

      - name: Push delta to D1
        run: |
          npm install -g wrangler
          wrangler d1 execute tmdb-seo --remote --file=delta.sql
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}

      - name: Purge Cloudflare CDN cache
        run: |
          curl -X POST \
            "https://api.cloudflare.com/client/v4/zones/${{ secrets.CF_ZONE_ID }}/purge_cache" \
            -H "Authorization: Bearer ${{ secrets.CF_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            --data '{"purge_everything":true}'
```

### 6.2 Required GitHub secrets

| Secret | Value |
|---|---|
| `TMDB_API_KEY` | TMDB API v3 key |
| `CF_API_TOKEN` | Cloudflare API token with D1 write + Cache purge permissions |
| `CF_ACCOUNT_ID` | Cloudflare account ID (from dashboard URL) |
| `CF_ZONE_ID` | Zone ID of your domain (from Cloudflare domain overview) |

### 6.3 `export_delta_to_sqlite.py` (daily delta — only changed records)

```python
import duckdb, sqlite3
from datetime import datetime, timedelta

src = duckdb.connect('tmdb.duckdb', read_only=True)
dst = sqlite3.connect('delta.db')

# Only export movies updated in last 48 hours (buffer for timezone drift)
cutoff = (datetime.utcnow() - timedelta(hours=48)).strftime('%Y-%m-%d')

rows = src.execute(f"""
  SELECT m.id, m.title, m.original_title, m.overview,
         CAST(m.release_date AS VARCHAR), CAST(m.vote_average AS REAL),
         CAST(m.vote_count AS INTEGER), CAST(m.popularity AS REAL),
         m.poster_path, m.backdrop_path, m.runtime, m.tagline,
         m.collection_id, m.collection_name,
         LOWER(REGEXP_REPLACE(m.title,'[^a-zA-Z0-9]+','-','g'))
           || '-' || YEAR(m.release_date::DATE) AS slug
  FROM movies m
  WHERE m.updated_at >= '{cutoff}'
    AND m.popularity > 5 AND m.vote_average > 4
    AND EXISTS (SELECT 1 FROM movie_watch_provider_offers o WHERE o.movie_id = m.id)
""").fetchall()

# Write as SQL upserts for D1
with open('delta.sql', 'w') as f:
    for r in rows:
        vals = str(r).replace("'", "''")  # basic escaping
        f.write(f"INSERT OR REPLACE INTO movies VALUES {r};\n")
    # Also delete+reinsert provider offers for changed movies
    movie_ids = [str(r[0]) for r in rows]
    if movie_ids:
        ids = ','.join(movie_ids)
        # Add provider deletes + reinserts here following the same pattern

print(f'Delta: {len(rows)} movies updated')
dst.close()
src.close()
```

---

## Monetisation Setup

### Affiliate programs to join (in priority order)

| Program | Platform | Sign-up URL | Commission |
|---|---|---|---|
| Amazon Associates | Amazon Prime Video | affiliate-program.amazon.com | 3–5% on sales |
| Apple Services | Apple TV+ | Search "Apple affiliate program" on Impact.com | Per trial/subscription |
| Rakuten Advertising | Multiple streaming platforms | rakutenadvertising.com | Varies |

### Affiliate tag injection

All affiliate tag injection happens in `src/lib/affiliate.ts` → `buildAffiliateUrl()`. To add a new provider:
1. Add a new `if` block checking `provider.toLowerCase().includes('provider-name')`
2. Return the URL with the affiliate parameter appended
3. No redeployment needed for tag value changes — update the `AMAZON_AFFILIATE_TAG` env var in Cloudflare Pages settings

### Revenue tracking

- **Clicks:** tracked in D1 `click_events`, queryable at `/api/stats`
- **Conversions:** tracked in each affiliate platform's dashboard
- **Correlation:** in Looker Studio, add a manual data source (Google Sheets) where you log monthly commission payouts per provider; join with GA4 click data to calculate effective CPM

---

## SEO Correctness Checklist

These must all be implemented before first deployment. They directly affect indexing speed and ranking.

- [ ] Every page has a unique `<title>` following the specified format
- [ ] Every page has a unique `<meta name="description">` under 160 characters
- [ ] Every page has a `<link rel="canonical">` pointing to its own URL
- [ ] Movie pages include `schema.org/Movie` JSON-LD
- [ ] Actor pages include `schema.org/Person` JSON-LD
- [ ] Platform pages include `schema.org/ItemList` JSON-LD
- [ ] `robots.txt` allows all crawlers, disallows `/go/` and `/api/`
- [ ] Sitemap index submitted to Google Search Console
- [ ] GA4 Measurement ID is correctly wired via Partytown
- [ ] GSC HTML meta verification tag is in `<head>`
- [ ] Affiliate redirect routes (`/go/`) return HTTP 302 (not 301)
- [ ] Affiliate redirect routes set `no-store` and `Referrer-Policy: no-referrer`
- [ ] TMDB attribution is present on all pages (TMDB requires it in their ToS): "This product uses the TMDB API but is not endorsed or certified by TMDB."
- [ ] Image `alt` text on all poster images uses `[Title] poster`
- [ ] `<html lang="en">` is set on every page
- [ ] Core Web Vitals: LCP < 2.5s, CLS < 0.1 (verify in GSC after deployment)

---

## File Structure (complete)

```
tmdb-seo/
├── wrangler.toml
├── astro.config.mjs
├── tsconfig.json
├── package.json
├── .gitignore                       # include: tmdb_seo.db, delta.db, *.sql, node_modules
│
├── export_to_sqlite.py              # one-time DuckDB → SQLite export
├── export_delta_to_sqlite.py        # nightly delta export
│
├── .github/
│   └── workflows/
│       └── daily-sync.yml
│
└── src/
    ├── layouts/
    │   └── Layout.astro             # base HTML, GA4 via Partytown, JSON-LD slot
    │
    ├── lib/
    │   ├── db.ts                    # all D1 query helpers
    │   └── affiliate.ts             # affiliate URL builder per provider
    │
    └── pages/
        ├── movie/
        │   └── [slug].astro
        ├── streaming/
        │   └── [provider]/
        │       └── [region].astro
        ├── actor/
        │   └── [slug].astro
        ├── genre/
        │   └── [genre]/
        │       └── [provider].astro
        ├── collection/
        │   └── [id].astro
        ├── go/
        │   └── [provider].ts        # affiliate redirect + D1 click log
        ├── api/
        │   └── stats.ts             # admin analytics endpoint
        ├── sitemap-index.xml.ts
        ├── sitemap-movies-1.xml.ts  # 45K movies, sorted by popularity DESC
        ├── sitemap-movies-2.xml.ts  # next 45K
        ├── sitemap-actors.xml.ts
        ├── sitemap-providers.xml.ts
        └── robots.txt.ts
```

---

## Cost Summary

| Service | Free tier limit | Expected cost |
|---|---|---|
| Cloudflare Pages | Unlimited requests | Free |
| Cloudflare Workers | 100K req/day free | Free to start |
| Cloudflare D1 | 5GB storage, 25M reads/day | Free |
| Cloudflare KV | 1GB, 100K reads/day | Free |
| Google Analytics 4 | Unlimited | Free |
| Google Search Console | Unlimited | Free |
| Looker Studio | Unlimited | Free |
| GitHub Actions | 2,000 min/month | Free |
| Domain name | — | ~$10/year |
| **Total** | | **~$1/month** |

Costs only scale if you exceed Cloudflare's Workers free tier (100K requests/day). At that point, Cloudflare Workers Paid is $5/month flat for 10M requests — still negligible.

---

## Legal & Compliance

- **TMDB attribution:** Required by TMDB ToS. Display "This product uses the TMDB API but is not endorsed or certified by TMDB." in the site footer with a link to `https://www.themoviedb.org`. Also display the TMDB logo as required.
- **Affiliate disclosure:** Required by FTC (US) and ASA (UK). Display a disclosure on every page that contains affiliate links. Suggested text: "Some links on this page are affiliate links. If you click and subscribe or purchase, we may earn a commission at no extra cost to you."
- **Privacy policy:** Required by GA4 (Google's terms) and by GDPR if serving EU users. Generate a privacy policy covering Google Analytics data collection, cookie usage, and affiliate link tracking. Link from the footer.
- **GDPR / consent:** For EU traffic, GA4 requires a consent banner before firing tracking events. Implement a simple cookie consent banner that conditionally loads GA4 only after consent. For non-EU traffic, GA4 can load unconditionally.
- **Copyright:** Do not store or serve TMDB images from your own servers. Always proxy through `image.tmdb.org` with TMDB's URL format. Movie descriptions and metadata are from TMDB and are covered by their data licence.

---

*End of specification. Implement in phase order: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. Do not skip ahead.*
