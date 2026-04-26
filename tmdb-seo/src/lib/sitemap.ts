import type { APIContext } from 'astro';
import { getMovieSitemap } from './db';
import { escapeXml, getBaseUrl } from './site';

export const MOVIE_SITEMAP_CHUNK_SIZE = 45_000;

export async function movieSitemapResponse(context: APIContext, chunkNumber: number) {
  const base = getBaseUrl(context.request, context.locals.runtime.env);
  const offset = (chunkNumber - 1) * MOVIE_SITEMAP_CHUNK_SIZE;
  const movies = await getMovieSitemap(
    context.locals.runtime.env.DB,
    MOVIE_SITEMAP_CHUNK_SIZE,
    offset
  );
  const today = new Date().toISOString().slice(0, 10);
  const priority = chunkNumber === 1 ? '0.8' : '0.7';
  const urls = movies
    .map(
      (movie) => `
  <url>
    <loc>${escapeXml(`${base}/movie/${movie.slug}`)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
  </url>`
    )
    .join('');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`,
    {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    }
  );
}
