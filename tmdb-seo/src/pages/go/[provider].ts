export const prerender = false;

import type { APIContext } from 'astro';
import { buildAffiliateUrl, isAmazonPrimeProvider, isSafeDestination } from '../../lib/affiliate';

export async function GET({ params, request, locals }: APIContext) {
  const env = locals.runtime.env;
  const url = new URL(request.url);
  const dest = url.searchParams.get('dest') || '';
  const movieId = url.searchParams.get('movie') || '';
  const movieTitle = url.searchParams.get('title') || '';
  const region = url.searchParams.get('region') || 'US';
  const provider = url.searchParams.get('provider') || decodeURIComponent(params.provider || '');
  const canBuildAmazonDestination = isAmazonPrimeProvider(provider) && movieTitle.length > 0;

  if (!canBuildAmazonDestination && (!dest || !isSafeDestination(dest))) {
    return new Response('Bad request', { status: 400 });
  }

  const redirectUrl = buildAffiliateUrl(provider, dest, env, {
    movieTitle,
    region,
  });

  if (!isSafeDestination(redirectUrl)) {
    return new Response('Bad request', { status: 400 });
  }

  const logClick = env.DB.prepare(
    `INSERT INTO click_events (movie_id, provider, region, ts, ua, ref)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      Number.parseInt(movieId, 10) || null,
      provider,
      region,
      Date.now(),
      (request.headers.get('user-agent') || '').slice(0, 200),
      (request.headers.get('referer') || '').slice(0, 500)
    )
    .run();

  locals.runtime.ctx.waitUntil(logClick);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
