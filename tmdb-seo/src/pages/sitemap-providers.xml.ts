export const prerender = false;

import type { APIContext } from 'astro';
import { getProviderSitemap } from '../lib/db';
import { escapeXml, getBaseUrl } from '../lib/site';

export async function GET({ request, locals }: APIContext) {
  const base = getBaseUrl(request, locals.runtime.env);
  const providers = await getProviderSitemap(locals.runtime.env.DB);
  const today = new Date().toISOString().slice(0, 10);
  const urls = providers
    .map(
      (provider) => `
  <url>
    <loc>${escapeXml(`${base}/streaming/${provider.provider_slug}/${provider.region}`)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
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
