export const prerender = false;

import type { APIContext } from 'astro';
import { getActorSitemap } from '../lib/db';
import { cachedSitemapResponse } from '../lib/sitemap';
import { escapeXml, getBaseUrl } from '../lib/site';

export async function GET(context: APIContext) {
  const { request, locals } = context;

  return cachedSitemapResponse(context, 'sitemap-actors', async () => {
    const base = getBaseUrl(request, locals.runtime.env);
    const actors = await getActorSitemap(locals.runtime.env.DB);
    const today = new Date().toISOString().slice(0, 10);
    const urls = actors
      .map(
        (actor) => `
  <url>
    <loc>${escapeXml(`${base}/actor/${actor.slug}`)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`;
  });
}
