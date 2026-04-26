import type { APIContext } from 'astro';
import { getMovieSitemap } from './db';
import { escapeXml, getBaseUrl } from './site';

export const MOVIE_SITEMAP_CHUNK_SIZE = 10_000;
export const SITEMAP_CACHE_TTL = 86_400;
const SITEMAP_CACHE_VERSION = 'v2';

const SITEMAP_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': `public, max-age=${SITEMAP_CACHE_TTL}`,
};

export function xmlSitemapResponse(xml: string): Response {
  return new Response(xml, {
    headers: SITEMAP_HEADERS,
  });
}

export async function cachedSitemapResponse(
  context: APIContext,
  cacheKey: string,
  buildXml: () => Promise<string> | string
): Promise<Response> {
  const { CACHE } = context.locals.runtime.env;
  const versionedCacheKey = `${SITEMAP_CACHE_VERSION}:${cacheKey}`;

  try {
    const cached = await CACHE.get(versionedCacheKey);
    if (cached) return xmlSitemapResponse(cached);
  } catch (error) {
    console.error(`Failed to read sitemap KV cache for ${versionedCacheKey}`, error);
  }

  const xml = await buildXml();
  context.locals.runtime.ctx.waitUntil(
    CACHE.put(versionedCacheKey, xml, { expirationTtl: SITEMAP_CACHE_TTL }).catch((error) => {
      console.error(`Failed to write sitemap KV cache for ${versionedCacheKey}`, error);
    })
  );

  return xmlSitemapResponse(xml);
}

export async function movieSitemapResponse(context: APIContext, chunkNumber: number) {
  return cachedSitemapResponse(context, `sitemap-movies-${chunkNumber}`, async () => {
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

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`;
  });
}
