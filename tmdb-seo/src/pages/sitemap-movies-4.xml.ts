export const prerender = false;

import type { APIContext } from 'astro';
import { movieSitemapResponse } from '../lib/sitemap';

export async function GET(context: APIContext) {
  return movieSitemapResponse(context, 4);
}
