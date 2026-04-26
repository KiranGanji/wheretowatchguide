import { defineMiddleware } from 'astro:middleware';

function normalizedPathname(request: Request): string {
  let pathname = new URL(request.url).pathname;
  for (let i = 0; i < 2; i += 1) {
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      break;
    }
  }
  return pathname.replace(/\/+$/, '') || '/';
}

export const onRequest = defineMiddleware((context, next) => {
  if (normalizedPathname(context.request) === '/_image') {
    return new Response('Not found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  return next();
});
