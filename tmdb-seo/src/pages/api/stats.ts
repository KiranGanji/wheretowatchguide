export const prerender = false;

import type { APIContext } from 'astro';

export async function GET({ request, locals }: APIContext) {
  const env = locals.runtime.env;

  if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return new Response('Forbidden', { status: 403 });
  }

  const db = env.DB;
  const [total, topMovies, topProviders, topRegions, daily] = await Promise.all([
    db.prepare('SELECT COUNT(*) as total FROM click_events').first(),
    db
      .prepare(
        `SELECT movie_id, COUNT(*) as clicks
         FROM click_events
         GROUP BY movie_id
         ORDER BY clicks DESC
         LIMIT 20`
      )
      .all(),
    db
      .prepare(
        `SELECT provider, COUNT(*) as clicks
         FROM click_events
         GROUP BY provider
         ORDER BY clicks DESC
         LIMIT 10`
      )
      .all(),
    db
      .prepare(
        `SELECT region, COUNT(*) as clicks
         FROM click_events
         GROUP BY region
         ORDER BY clicks DESC
         LIMIT 10`
      )
      .all(),
    db
      .prepare(
        `SELECT DATE(ts / 1000, 'unixepoch') as day, COUNT(*) as clicks
         FROM click_events
         GROUP BY day
         ORDER BY day DESC
         LIMIT 30`
      )
      .all(),
  ]);

  return Response.json(
    {
      total,
      topMovies: topMovies.results ?? [],
      topProviders: topProviders.results ?? [],
      topRegions: topRegions.results ?? [],
      daily: daily.results ?? [],
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
