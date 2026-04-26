export const prerender = false;

import type { APIContext } from 'astro';
import { searchMovies } from '../../lib/db';
import { posterUrl } from '../../lib/site';

export async function GET({ url, locals }: APIContext) {
  const query = url.searchParams.get('q')?.trim() ?? '';

  if (query.length < 3) {
    return Response.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': 'public, max-age=60',
        },
      }
    );
  }

  const movies = await searchMovies(locals.runtime.env.DB, query, 8);

  return Response.json(
    {
      results: movies.map((movie) => ({
        id: movie.id,
        title: movie.title,
        slug: movie.slug,
        year: movie.release_date ? String(movie.release_date).slice(0, 4) : null,
        rating: movie.vote_average ? Number(movie.vote_average).toFixed(1) : null,
        poster: posterUrl(movie.poster_path, 'w92'),
      })),
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      },
    }
  );
}
