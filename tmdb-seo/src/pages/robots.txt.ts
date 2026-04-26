import type { APIContext } from 'astro';
import { getBaseUrl } from '../lib/site';

export async function GET({ request, locals }: APIContext) {
  const base = getBaseUrl(request, locals.runtime.env);

  return new Response(
    `User-agent: *
Allow: /
Disallow: /go/
Disallow: /api/
Sitemap: ${base}/sitemap-index.xml
`,
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    }
  );
}
