export const TMDB_ATTRIBUTION =
  'This product uses the TMDB API but is not endorsed or certified by TMDB.';

export const TMDB_BASE_URL = 'https://www.themoviedb.org';
export const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

export function getEnv(locals: App.Locals): Env {
  return locals.runtime.env;
}

export function getBaseUrl(request: Request, env?: Pick<Env, 'SITE_URL'>): string {
  const configured = env?.SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(request.url).origin;
}

export function getCanonicalUrl(
  request: Request,
  pathname: string,
  env?: Pick<Env, 'SITE_URL'>
): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${getBaseUrl(request, env)}${path}`;
}

export function toTitleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function truncateMeta(value: string, maxLength = 158): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  const sliced = compact.slice(0, maxLength - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, lastSpace > 80 ? lastSpace : sliced.length).trim()}…`;
}

export function formatRegion(region: string): string {
  const normalized = region.toUpperCase();
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

export function getCurrentRegion(request: Request): string {
  const region = request.headers.get('cf-ipcountry') || 'US';
  return /^[A-Z]{2}$/i.test(region) ? region.toUpperCase() : 'US';
}

export function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function posterUrl(path: string | null | undefined, size = 'w342'): string | null {
  return path ? `${IMAGE_BASE_URL}/${size}${path}` : null;
}

export function providerLogoUrl(path: string | null | undefined, size = 'w92'): string | null {
  return path ? `${IMAGE_BASE_URL}/${size}${path}` : null;
}
