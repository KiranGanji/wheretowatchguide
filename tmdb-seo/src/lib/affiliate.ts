type AffiliateEnv = Pick<Env, 'AMAZON_AFFILIATE_TAG' | 'APPLE_AFFILIATE_URL'>;

const DEFAULT_AMAZON_AFFILIATE_TAG = 'wheretowatch9-21';

const AMAZON_DOMAINS: Record<string, string> = {
  US: 'amazon.com',
  IN: 'amazon.in',
  GB: 'amazon.co.uk',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  ES: 'amazon.es',
  JP: 'amazon.co.jp',
  CA: 'amazon.ca',
  AU: 'amazon.com.au',
  BR: 'amazon.com.br',
  MX: 'amazon.com.mx',
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isAmazonPrimeProvider(provider: string): boolean {
  const normalizedProvider = provider.toLowerCase().replace(/\s+/g, ' ');
  return (
    normalizedProvider.includes('amazon') ||
    normalizedProvider.includes('prime video') ||
    normalizedProvider.includes('primevideo')
  );
}

function getAmazonAffiliateTag(env?: AffiliateEnv): string {
  return (
    env?.AMAZON_AFFILIATE_TAG ||
    import.meta.env.AMAZON_AFFILIATE_TAG ||
    DEFAULT_AMAZON_AFFILIATE_TAG
  );
}

export function buildAmazonUrl(movieTitle: string, region: string, tag: string): string {
  const normalizedRegion = /^[A-Z]{2}$/i.test(region) ? region.toUpperCase() : 'US';
  const domain = AMAZON_DOMAINS[normalizedRegion] || AMAZON_DOMAINS.US;
  const url = new URL(`https://www.${domain}/s`);
  url.searchParams.set('k', movieTitle);
  url.searchParams.set('i', 'prime-video');
  url.searchParams.set('tag', tag);
  return url.toString();
}

export function buildAffiliateUrl(
  provider: string,
  destinationUrl: string,
  env?: AffiliateEnv,
  options: { movieTitle?: string; region?: string } = {}
): string {
  if (isAmazonPrimeProvider(provider) && options.movieTitle) {
    return buildAmazonUrl(
      options.movieTitle,
      options.region || 'US',
      getAmazonAffiliateTag(env)
    );
  }

  if (!isHttpUrl(destinationUrl)) return destinationUrl;

  const normalizedProvider = provider.toLowerCase();

  if (normalizedProvider.includes('apple')) {
    const affiliateUrl =
      env?.APPLE_AFFILIATE_URL || import.meta.env.APPLE_AFFILIATE_URL || '';

    if (!affiliateUrl) return destinationUrl;

    const url = new URL(affiliateUrl);
    url.searchParams.set('dest', destinationUrl);
    return url.toString();
  }

  return destinationUrl;
}

export function isSafeDestination(value: string): boolean {
  return isHttpUrl(value);
}
