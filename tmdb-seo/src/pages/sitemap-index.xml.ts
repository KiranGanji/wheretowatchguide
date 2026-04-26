export const prerender = false;

import type { APIContext } from 'astro';
import { getMovieCount } from '../lib/db';
import { MOVIE_SITEMAP_CHUNK_SIZE } from '../lib/sitemap';
import { escapeXml, getBaseUrl } from '../lib/site';

export async function GET({ request, locals }: APIContext) {
  const base = getBaseUrl(request, locals.runtime.env);
  const movieCount = await getMovieCount(locals.runtime.env.DB);
  const movieSitemapCount = Math.max(
    1,
    Math.ceil(movieCount / MOVIE_SITEMAP_CHUNK_SIZE)
  );
  const sitemaps = [
    ...Array.from(
      { length: movieSitemapCount },
      (_, index) => `${base}/sitemap-movies-${index + 1}.xml`
    ),
    `${base}/sitemap-actors.xml`,
    `${base}/sitemap-providers.xml`,
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map((sitemap) => `  <sitemap><loc>${escapeXml(sitemap)}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
