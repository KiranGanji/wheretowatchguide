import type { APIContext } from 'astro';

export function GET(context: APIContext) {
  return Response.redirect(new URL('/sitemap-movies/3.xml', context.request.url), 301);
}
