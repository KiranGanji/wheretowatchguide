import { defineConfig, passthroughImageService } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import partytown from '@astrojs/partytown';

const site = process.env.SITE_URL ?? 'https://wheretowatch.guide';

export default defineConfig({
  site,
  output: 'server',
  image: {
    service: passthroughImageService(),
  },
  adapter: cloudflare({
    mode: 'directory',
    functionPerRoute: false,
  }),
  integrations: [
    partytown({
      config: {
        forward: ['dataLayer.push'],
      },
    }),
  ],
});
