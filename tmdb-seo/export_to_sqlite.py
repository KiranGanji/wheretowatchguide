import argparse
import sqlite3
from pathlib import Path

import duckdb


PROJECT_ROOT = Path(__file__).resolve().parent
SOURCE_CANDIDATES = [
    PROJECT_ROOT / "tmdb.duckdb",
    PROJECT_ROOT.parent / "tmdb.duckdb",
]
SOURCE_DB = next((path for path in SOURCE_CANDIDATES if path.exists()), None)
TARGET_DB = PROJECT_ROOT / "tmdb_seo.db"

if SOURCE_DB is None:
    raise SystemExit(
        "Could not find tmdb.duckdb in the project root or its parent directory."
    )

SLUG_SQL = """
REGEXP_REPLACE(
  LOWER(REGEXP_REPLACE(COALESCE({value}, ''), '[^a-zA-Z0-9]+', '-', 'g')),
  '(^-+|-+$)',
  '',
  'g'
)
"""


def slug_expr(value: str) -> str:
    return SLUG_SQL.format(value=value)


def copy_query(
    src: duckdb.DuckDBPyConnection,
    dst: sqlite3.Connection,
    label: str,
    query: str,
    insert_sql: str,
    chunk_size: int = 50_000,
) -> int:
    cursor = src.execute(query)
    total = 0
    while True:
        rows = cursor.fetchmany(chunk_size)
        if not rows:
            break
        dst.executemany(insert_sql, rows)
        total += len(rows)
        print(f"{label}: {total}")
    return total


def table_exists(tables: set[str], name: str) -> bool:
    return name in tables


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export the local TMDB DuckDB into a D1-compatible SQLite database."
    )
    parser.add_argument(
        "--seo-filter",
        action="store_true",
        help=(
            "Apply the original Phase 1 SEO filter "
            "(popularity > 5, vote_average > 4, overview, provider)."
        ),
    )
    parser.add_argument(
        "--target",
        default=str(TARGET_DB),
        help="SQLite output path. Defaults to tmdb_seo.db in this project.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    target_db = Path(args.target).expanduser()
    if not target_db.is_absolute():
        target_db = PROJECT_ROOT / target_db

    print(f"Source: {SOURCE_DB}")
    print(f"Target: {target_db}")
    print(f"Mode: {'SEO filter' if args.seo_filter else 'full migration'}")

    src = duckdb.connect(str(SOURCE_DB), read_only=True)
    dst = sqlite3.connect(str(target_db))

    dst.execute("PRAGMA journal_mode=WAL")
    dst.execute("PRAGMA synchronous=NORMAL")
    dst.execute("PRAGMA temp_store=MEMORY")
    dst.execute("PRAGMA foreign_keys=OFF")

    tables = {row[0] for row in src.execute("SHOW TABLES").fetchall()}
    has_simplified_schema = table_exists(tables, "movie_providers")

    dst.executescript(
        """
        DROP TABLE IF EXISTS movies;
        DROP TABLE IF EXISTS movie_providers;
        DROP TABLE IF EXISTS movie_genres;
        DROP TABLE IF EXISTS movie_cast;
        DROP TABLE IF EXISTS people;
        DROP TABLE IF EXISTS collections;
        DROP TABLE IF EXISTS genre_platform_index;
        DROP TABLE IF EXISTS click_events;

        CREATE TABLE movies (
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
        );

        CREATE TABLE movie_providers (
          movie_id INTEGER,
          region TEXT,
          provider_id INTEGER,
          provider_name TEXT,
          provider_slug TEXT,
          provider_logo_path TEXT,
          type TEXT,
          display_priority INTEGER,
          link TEXT
        );

        CREATE TABLE movie_genres (
          movie_id INTEGER,
          genre_id INTEGER,
          genre TEXT,
          genre_slug TEXT
        );

        CREATE TABLE movie_cast (
          movie_id INTEGER,
          person_id INTEGER,
          name TEXT,
          person_slug TEXT,
          character_name TEXT,
          cast_order INTEGER
        );

        CREATE TABLE people (
          person_id INTEGER PRIMARY KEY,
          name TEXT,
          slug TEXT UNIQUE
        );

        CREATE TABLE collections (
          collection_id INTEGER PRIMARY KEY,
          collection_name TEXT,
          slug TEXT,
          movie_count INTEGER,
          first_year INTEGER,
          last_year INTEGER,
          total_runtime INTEGER
        );

        CREATE TABLE genre_platform_index (
          genre TEXT,
          provider_name TEXT,
          region TEXT,
          movie_count INTEGER,
          genre_slug TEXT,
          provider_slug TEXT
        );

        CREATE TABLE click_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          movie_id INTEGER,
          provider TEXT,
          region TEXT,
          ts INTEGER,
          ua TEXT,
          ref TEXT
        );
        """
    )

    offer_table = "movie_providers" if has_simplified_schema else "movie_watch_provider_offers"
    movie_where = (
        f"""
        m.popularity > 5
          AND m.vote_average > 4
          AND m.overview IS NOT NULL
          AND TRIM(m.overview) != ''
          AND EXISTS (
            SELECT 1 FROM {offer_table} o WHERE o.movie_id = m.id
          )
        """
        if args.seo_filter
        else "1 = 1"
    )

    joined_movie_where = (
        """
        m.popularity > 5
          AND m.vote_average > 4
          AND m.overview IS NOT NULL
          AND TRIM(m.overview) != ''
        """
        if args.seo_filter
        else "1 = 1"
    )

    cast_where = "AND c.cast_order < 5" if args.seo_filter else ""
    raw_cast_where = 'AND c."order" < 5' if args.seo_filter else ""

    movie_slug = (
        "NULLIF(m.slug, '')"
        if has_simplified_schema
        else f"{slug_expr('m.title')} || '-' || COALESCE(CAST(YEAR(m.release_date) AS VARCHAR), CAST(m.id AS VARCHAR))"
    )

    copy_query(
        src,
        dst,
        "movies",
        f"""
        SELECT m.id,
               m.title,
               m.original_title,
               m.overview,
               CAST(m.release_date AS VARCHAR),
               CAST(m.vote_average AS REAL),
               CAST(m.vote_count AS INTEGER),
               CAST(m.popularity AS REAL),
               m.poster_path,
               m.backdrop_path,
               m.runtime,
               m.tagline,
               m.collection_id,
               m.collection_name,
               COALESCE({movie_slug},
                        {slug_expr('m.title')} || '-' || CAST(m.id AS VARCHAR)) AS slug
        FROM movies m
        WHERE {movie_where}
        """,
        """
        INSERT OR REPLACE INTO movies VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
    )

    if has_simplified_schema:
        copy_query(
            src,
            dst,
            "provider offers",
            f"""
            SELECT o.movie_id,
                   o.region,
                   NULL AS provider_id,
                   o.provider_name,
                   {slug_expr('o.provider_name')} AS provider_slug,
                   o.provider_logo_path,
                   o.offer_type AS type,
                   o.display_priority,
                   o.tmdb_url AS link
            FROM movie_providers o
            JOIN movies m ON m.id = o.movie_id
            WHERE {joined_movie_where}
            """,
            """
            INSERT INTO movie_providers VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
        )

        copy_query(
            src,
            dst,
            "genres",
            f"""
            SELECT g.movie_id,
                   NULL AS genre_id,
                   g.genre,
                   {slug_expr('g.genre')} AS genre_slug
            FROM movie_genres g
            JOIN movies m ON m.id = g.movie_id
            WHERE {joined_movie_where}
            """,
            "INSERT INTO movie_genres VALUES (?, ?, ?, ?)",
        )

        copy_query(
            src,
            dst,
            "cast",
            f"""
            SELECT c.movie_id,
                   c.person_id,
                   c.name,
                   p.slug AS person_slug,
                   c.character_name,
                   CAST(c.cast_order AS INTEGER)
            FROM movie_cast c
            JOIN people p ON p.person_id = c.person_id
            JOIN movies m ON m.id = c.movie_id
            WHERE {joined_movie_where}
              {cast_where}
            """,
            "INSERT INTO movie_cast VALUES (?, ?, ?, ?, ?, ?)",
        )

        if args.seo_filter:
            copy_query(
                src,
                dst,
                "people",
                f"""
                SELECT DISTINCT p.person_id, p.name, p.slug
                FROM people p
                JOIN movie_cast c ON c.person_id = p.person_id
                JOIN movies m ON m.id = c.movie_id
                WHERE {joined_movie_where}
                """,
                "INSERT OR REPLACE INTO people VALUES (?, ?, ?)",
            )
        else:
            copy_query(
                src,
                dst,
                "people",
                """
                SELECT p.person_id, p.name, p.slug
                FROM people p
                """,
                "INSERT OR REPLACE INTO people VALUES (?, ?, ?)",
            )
    else:
        copy_query(
            src,
            dst,
            "provider offers",
            f"""
            SELECT o.movie_id,
                   o.region,
                   o.provider_id,
                   p.provider AS provider_name,
                   {slug_expr('p.provider')} AS provider_slug,
                   NULL AS provider_logo_path,
                   o.type,
                   o.display_priority,
                   l.link
            FROM movie_watch_provider_offers o
            JOIN watch_providers p ON p.provider_id = o.provider_id
            LEFT JOIN movie_watch_provider_links l
                   ON l.movie_id = o.movie_id AND l.region = o.region
            JOIN movies m ON m.id = o.movie_id
            WHERE {joined_movie_where}
            """,
            """
            INSERT INTO movie_providers VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
        )

        copy_query(
            src,
            dst,
            "genres",
            f"""
            SELECT mg.movie_id,
                   mg.genre_id,
                   g.genre,
                   {slug_expr('g.genre')} AS genre_slug
            FROM movie_genre_map mg
            JOIN genres g ON g.genre_id = mg.genre_id
            JOIN movies m ON m.id = mg.movie_id
            WHERE {joined_movie_where}
            """,
            "INSERT INTO movie_genres VALUES (?, ?, ?, ?)",
        )

        copy_query(
            src,
            dst,
            "cast",
            f"""
            SELECT c.movie_id,
                   c.person_id,
                   p.name,
                   {slug_expr('p.name')} AS person_slug,
                   c.character AS character_name,
                   CAST(c."order" AS INTEGER)
            FROM movie_cast_credits c
            JOIN people p ON p.person_id = c.person_id
            JOIN movies m ON m.id = c.movie_id
            WHERE {joined_movie_where}
              {raw_cast_where}
            """,
            "INSERT INTO movie_cast VALUES (?, ?, ?, ?, ?, ?)",
        )

        if args.seo_filter:
            copy_query(
                src,
                dst,
                "people",
                f"""
                SELECT DISTINCT p.person_id, p.name, {slug_expr('p.name')} AS slug
                FROM people p
                JOIN movie_cast_credits c ON c.person_id = p.person_id
                JOIN movies m ON m.id = c.movie_id
                WHERE {joined_movie_where}
                """,
                "INSERT OR REPLACE INTO people VALUES (?, ?, ?)",
            )
        else:
            copy_query(
                src,
                dst,
                "people",
                f"""
                SELECT p.person_id, p.name, {slug_expr('p.name')} AS slug
                FROM people p
                """,
                "INSERT OR REPLACE INTO people VALUES (?, ?, ?)",
            )

    if table_exists(tables, "collections"):
        collection_where = (
            """
                AND m.popularity > 5
                AND m.vote_average > 4
                AND m.overview IS NOT NULL
                AND TRIM(m.overview) != ''
            """
            if args.seo_filter
            else ""
        )
        copy_query(
            src,
            dst,
            "collections",
            f"""
            SELECT c.collection_id,
                   c.collection_name,
                   c.slug,
                   CAST(c.movie_count AS INTEGER),
                   c.first_year,
                   c.last_year,
                   CAST(c.total_runtime AS INTEGER)
            FROM collections c
            WHERE EXISTS (
              SELECT 1
              FROM movies m
              WHERE m.collection_id = c.collection_id
                {collection_where}
            )
            """,
            "INSERT OR REPLACE INTO collections VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
    else:
        dst.execute(
            """
            INSERT OR REPLACE INTO collections
            SELECT collection_id,
                   collection_name,
                   NULL AS slug,
                   COUNT(*) AS movie_count,
                   MIN(CAST(substr(release_date, 1, 4) AS INTEGER)) AS first_year,
                   MAX(CAST(substr(release_date, 1, 4) AS INTEGER)) AS last_year,
                   SUM(runtime) AS total_runtime
            FROM movies
            WHERE collection_id IS NOT NULL
            GROUP BY collection_id, collection_name
            """
        )
        print(f"collections: {dst.execute('SELECT COUNT(*) FROM collections').fetchone()[0]}")

    if table_exists(tables, "genre_platform_index") and not args.seo_filter:
        dst.execute("DELETE FROM genre_platform_index")
        copy_query(
            src,
            dst,
            "genre/platform index",
            """
            SELECT genre,
                   provider_name,
                   region,
                   CAST(movie_count AS INTEGER),
                   genre_slug,
                   provider_slug
            FROM genre_platform_index
            """,
            "INSERT INTO genre_platform_index VALUES (?, ?, ?, ?, ?, ?)",
        )
    else:
        dst.execute(
            """
            INSERT INTO genre_platform_index
            SELECT g.genre,
                   mp.provider_name,
                   mp.region,
                   COUNT(DISTINCT mp.movie_id) AS movie_count,
                   g.genre_slug,
                   mp.provider_slug
            FROM movie_genres g
            JOIN movie_providers mp ON mp.movie_id = g.movie_id
            GROUP BY g.genre, mp.provider_name, mp.region, g.genre_slug, mp.provider_slug
            """
        )
    print(
        "genre/platform index: "
        f"{dst.execute('SELECT COUNT(*) FROM genre_platform_index').fetchone()[0]}"
    )

    dst.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_mp_movie     ON movie_providers(movie_id);
        CREATE INDEX IF NOT EXISTS idx_mp_region    ON movie_providers(region);
        CREATE INDEX IF NOT EXISTS idx_mp_provider  ON movie_providers(provider_slug, region);
        CREATE INDEX IF NOT EXISTS idx_mp_type      ON movie_providers(type);
        CREATE INDEX IF NOT EXISTS idx_mg_movie     ON movie_genres(movie_id);
        CREATE INDEX IF NOT EXISTS idx_mg_genre     ON movie_genres(genre_slug);
        CREATE INDEX IF NOT EXISTS idx_mc_movie     ON movie_cast(movie_id);
        CREATE INDEX IF NOT EXISTS idx_mc_person    ON movie_cast(person_id);
        CREATE INDEX IF NOT EXISTS idx_movies_slug  ON movies(slug);
        CREATE INDEX IF NOT EXISTS idx_movies_pop   ON movies(popularity DESC);
        CREATE INDEX IF NOT EXISTS idx_movies_coll  ON movies(collection_id);
        CREATE INDEX IF NOT EXISTS idx_people_slug  ON people(slug);
        CREATE INDEX IF NOT EXISTS idx_gpi_lookup   ON genre_platform_index(genre_slug, provider_slug, region);
        CREATE INDEX IF NOT EXISTS idx_click_ts     ON click_events(ts);
        """
    )

    dst.commit()
    dst.execute("VACUUM")
    dst.close()
    src.close()
    print(f"Export complete -> {target_db}")


if __name__ == "__main__":
    main()
