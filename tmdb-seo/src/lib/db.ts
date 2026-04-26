import type { D1Database } from '@cloudflare/workers-types';
import { slugify } from './site';

export interface Movie {
  id: number;
  title: string;
  original_title: string | null;
  overview: string;
  release_date: string | null;
  vote_average: number | null;
  vote_count: number | null;
  popularity: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  runtime: number | null;
  tagline: string | null;
  collection_id: number | null;
  collection_name: string | null;
  slug: string;
  genres?: string | null;
}

export interface MovieProvider {
  provider_name: string;
  provider_slug: string | null;
  provider_logo_path: string | null;
  type: string;
  link: string | null;
  display_priority: number | null;
}

export interface CastMember {
  person_id: number;
  name: string;
  person_slug: string;
  character_name: string | null;
  cast_order: number | null;
}

export interface Person {
  person_id: number;
  name: string;
  slug: string;
}

export interface MovieListItem {
  id: number;
  title: string;
  slug: string;
  poster_path: string | null;
  vote_average: number | null;
  release_date: string | null;
  type?: string | null;
  genres?: string | null;
  providers?: string | null;
  character_name?: string | null;
}

export interface Collection {
  collection_id: number;
  collection_name: string;
  slug: string | null;
  movie_count: number | null;
  first_year: number | null;
  last_year: number | null;
  total_runtime: number | null;
}

async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return (result.results ?? []) as T[];
}

function nextPrefix(value: string): string {
  const lastIndex = value.length - 1;
  const lastCode = value.charCodeAt(lastIndex);
  return `${value.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function getMovie(db: D1Database, slug: string): Promise<Movie | null> {
  return await db
    .prepare(
      `SELECT m.*, GROUP_CONCAT(DISTINCT g.genre) as genres
       FROM movies m
       LEFT JOIN movie_genres g ON g.movie_id = m.id
       WHERE m.slug = ?
       GROUP BY m.id`
    )
    .bind(slug)
    .first<Movie>();
}

export async function getMovieProviders(
  db: D1Database,
  movieId: number,
  region = 'US'
): Promise<MovieProvider[]> {
  return await all<MovieProvider>(
    db
      .prepare(
        `SELECT provider_name, provider_slug, provider_logo_path, type, link, display_priority
         FROM movie_providers
         WHERE movie_id = ? AND region = ?
         ORDER BY
           CASE type
             WHEN 'flatrate' THEN 1
             WHEN 'free' THEN 2
             WHEN 'ads' THEN 3
             WHEN 'rent' THEN 4
             WHEN 'buy' THEN 5
             ELSE 9
           END,
           display_priority`
      )
      .bind(movieId, region)
  );
}

export async function getMovieCast(
  db: D1Database,
  movieId: number,
  limit = 6
): Promise<CastMember[]> {
  return await all<CastMember>(
    db
      .prepare(
        `SELECT c.person_id,
                c.name,
                COALESCE(c.person_slug, p.slug) AS person_slug,
                c.character_name,
                c.cast_order
         FROM movie_cast c
         LEFT JOIN people p ON p.person_id = c.person_id
         WHERE c.movie_id = ?
         ORDER BY c.cast_order
         LIMIT ?`
      )
      .bind(movieId, limit)
  );
}

export async function getProviderMovies(
  db: D1Database,
  providerSlug: string,
  region: string,
  limit = 200,
  offset = 0
): Promise<MovieListItem[]> {
  return await all<MovieListItem>(
    db
      .prepare(
        `SELECT m.id,
                m.title,
                m.slug,
                m.poster_path,
                m.vote_average,
                m.release_date,
                MIN(mp.type) as type,
                GROUP_CONCAT(DISTINCT g.genre) as genres
         FROM movie_providers mp
         JOIN movies m ON m.id = mp.movie_id
         LEFT JOIN movie_genres g ON g.movie_id = m.id
         WHERE mp.provider_slug = ? AND mp.region = ?
         GROUP BY m.id
         ORDER BY m.popularity DESC
         LIMIT ? OFFSET ?`
      )
      .bind(providerSlug, region, limit, offset)
  );
}

export async function getTopMovies(
  db: D1Database,
  limit = 60
): Promise<MovieListItem[]> {
  return await all<MovieListItem>(
    db
      .prepare(
        `SELECT m.id,
                m.title,
                m.slug,
                m.poster_path,
                m.vote_average,
                m.release_date,
                GROUP_CONCAT(DISTINCT g.genre) as genres
         FROM movies m
         LEFT JOIN movie_genres g ON g.movie_id = m.id
         GROUP BY m.id
         ORDER BY m.popularity DESC
         LIMIT ?`
      )
      .bind(limit)
  );
}

export async function searchMovies(
  db: D1Database,
  query: string,
  limit = 10
): Promise<MovieListItem[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const slugPrefix = slugify(normalizedQuery);
  const boundedLimit = Math.min(Math.max(limit, 1), 60);

  if (slugPrefix.length < 3) return [];

  const prefixMatches = await all<MovieListItem>(
    db
      .prepare(
        `SELECT id,
                title,
                slug,
                poster_path,
                vote_average,
                release_date
         FROM movies
         WHERE slug >= ? AND slug < ?
         ORDER BY popularity DESC
         LIMIT ?`
      )
      .bind(slugPrefix, nextPrefix(slugPrefix), boundedLimit)
  );

  if (prefixMatches.length >= boundedLimit) return prefixMatches;

  const fallbackMatches = await all<MovieListItem>(
    db
      .prepare(
        `SELECT id,
                title,
                slug,
                poster_path,
                vote_average,
                release_date
         FROM movies
         WHERE LOWER(title) LIKE ? ESCAPE '\\'
         ORDER BY popularity DESC
         LIMIT ?`
      )
      .bind(`%${escapeLike(normalizedQuery.toLowerCase())}%`, boundedLimit)
  );

  const seen = new Set<number>();
  return [...prefixMatches, ...fallbackMatches]
    .filter((movie) => {
      if (seen.has(movie.id)) return false;
      seen.add(movie.id);
      return true;
    })
    .slice(0, boundedLimit);
}

export async function getProviderMovieCount(
  db: D1Database,
  providerSlug: string,
  region: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT movie_id) as total
       FROM movie_providers
       WHERE provider_slug = ? AND region = ?`
    )
    .bind(providerSlug, region)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getProviderName(
  db: D1Database,
  providerSlug: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT provider_name
       FROM movie_providers
       WHERE provider_slug = ?
       GROUP BY provider_name
       ORDER BY COUNT(*) DESC
       LIMIT 1`
    )
    .bind(providerSlug)
    .first<{ provider_name: string }>();
  return row?.provider_name ?? null;
}

export async function getActor(db: D1Database, actorSlug: string): Promise<Person | null> {
  return await db
    .prepare(`SELECT person_id, name, slug FROM people WHERE slug = ?`)
    .bind(actorSlug)
    .first<Person>();
}

export async function getActorMovies(
  db: D1Database,
  personId: number,
  limit = 160
): Promise<MovieListItem[]> {
  return await all<MovieListItem>(
    db
      .prepare(
        `SELECT m.id,
                m.title,
                m.slug,
                m.poster_path,
                m.release_date,
                m.vote_average,
                mc.character_name
         FROM movie_cast mc
         JOIN movies m ON m.id = mc.movie_id
         WHERE mc.person_id = ?
         GROUP BY m.id
         ORDER BY COALESCE(m.release_date, '0000-00-00') DESC,
                  COALESCE(m.popularity, 0) DESC
         LIMIT ?`
      )
      .bind(personId, Math.min(Math.max(limit, 1), 240))
  );
}

export async function getCollection(
  db: D1Database,
  collectionId: number
): Promise<Collection | null> {
  const collection = await db
    .prepare(
      `SELECT collection_id,
              collection_name,
              slug,
              movie_count,
              first_year,
              last_year,
              total_runtime
       FROM collections
       WHERE collection_id = ?`
    )
    .bind(collectionId)
    .first<Collection>();

  if (collection) return collection;

  return await db
    .prepare(
      `SELECT collection_id,
              collection_name,
              NULL as slug,
              COUNT(*) as movie_count,
              MIN(CAST(substr(release_date, 1, 4) AS INTEGER)) as first_year,
              MAX(CAST(substr(release_date, 1, 4) AS INTEGER)) as last_year,
              SUM(runtime) as total_runtime
       FROM movies
       WHERE collection_id = ?
       GROUP BY collection_id, collection_name`
    )
    .bind(collectionId)
    .first<Collection>();
}

export async function getCollectionMovies(
  db: D1Database,
  collectionId: number,
  region = 'US'
): Promise<MovieListItem[]> {
  return await all<MovieListItem>(
    db
      .prepare(
        `SELECT m.id,
                m.title,
                m.slug,
                m.poster_path,
                m.release_date,
                m.vote_average,
                GROUP_CONCAT(DISTINCT mp.provider_name) as providers
         FROM movies m
         LEFT JOIN movie_providers mp
                ON mp.movie_id = m.id
               AND mp.region = ?
               AND mp.type IN ('flatrate', 'free', 'ads')
         WHERE m.collection_id = ?
         GROUP BY m.id
         ORDER BY COALESCE(m.release_date, '9999-12-31') ASC`
      )
      .bind(region, collectionId)
  );
}

export async function getGenreProviderMeta(
  db: D1Database,
  genreSlug: string,
  providerSlug: string,
  region: string
): Promise<{ genre: string; provider_name: string; movie_count: number } | null> {
  return await db
    .prepare(
      `SELECT genre, provider_name, movie_count
       FROM genre_platform_index
       WHERE genre_slug = ? AND provider_slug = ? AND region = ?
       LIMIT 1`
    )
    .bind(genreSlug, providerSlug, region)
    .first<{ genre: string; provider_name: string; movie_count: number }>();
}

export async function getGenreProviderMovies(
  db: D1Database,
  genreSlug: string,
  providerSlug: string,
  region: string,
  limit = 200
): Promise<MovieListItem[]> {
  return await all<MovieListItem>(
    db
      .prepare(
        `SELECT DISTINCT m.id,
                m.title,
                m.slug,
                m.poster_path,
                m.vote_average,
                m.release_date,
                mp.type
         FROM movie_genres g
         JOIN movies m ON m.id = g.movie_id
         JOIN movie_providers mp ON mp.movie_id = m.id
         WHERE g.genre_slug = ?
           AND mp.provider_slug = ?
           AND mp.region = ?
         ORDER BY m.popularity DESC
         LIMIT ?`
      )
      .bind(genreSlug, providerSlug, region, limit)
  );
}

export async function getMovieSitemap(
  db: D1Database,
  limit: number,
  offset: number
): Promise<Array<{ slug: string }>> {
  return await all<{ slug: string }>(
    db
      .prepare(
        `SELECT slug
         FROM movies
         ORDER BY popularity DESC
         LIMIT ? OFFSET ?`
      )
      .bind(limit, offset)
  );
}

export async function getMovieCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as total FROM movies`).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getActorSitemap(
  db: D1Database
): Promise<Array<{ slug: string }>> {
  return await all<{ slug: string }>(
    db.prepare(
      `SELECT p.slug
       FROM people p
       WHERE EXISTS (SELECT 1 FROM movie_cast c WHERE c.person_id = p.person_id)
       ORDER BY p.name
       LIMIT 50000`
    )
  );
}

export async function getProviderSitemap(
  db: D1Database
): Promise<Array<{ provider_slug: string; region: string }>> {
  return await all<{ provider_slug: string; region: string }>(
    db.prepare(
      `SELECT DISTINCT provider_slug, region
       FROM genre_platform_index
       WHERE provider_slug IS NOT NULL AND region IS NOT NULL
       ORDER BY provider_slug, region
       LIMIT 50000`
    )
  );
}
