export const prerender = false;

import type { APIContext } from 'astro';
import { movieSitemapResponse } from '../../lib/sitemap';

export async function GET(context: APIContext) {
  const rawChunk = context.params.chunk ?? '';
  const chunkNumber = Number.parseInt(rawChunk, 10);

  if (!Number.isInteger(chunkNumber) || chunkNumber < 1) {
    return new Response('Not found', { status: 404 });
  }

  return movieSitemapResponse(context, chunkNumber);
}
