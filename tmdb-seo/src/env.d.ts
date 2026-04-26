/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type D1Database = import('@cloudflare/workers-types').D1Database;
type KVNamespace = import('@cloudflare/workers-types').KVNamespace;
type ExecutionContext = import('@cloudflare/workers-types').ExecutionContext;
type IncomingRequestCfProperties =
  import('@cloudflare/workers-types').IncomingRequestCfProperties;

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SITE_URL?: string;
  PUBLIC_GA_MEASUREMENT_ID?: string;
  ADMIN_KEY?: string;
  AMAZON_AFFILIATE_TAG?: string;
  APPLE_AFFILIATE_URL?: string;
}

declare namespace App {
  interface Locals {
    runtime: {
      env: Env;
      ctx: ExecutionContext;
      cf?: IncomingRequestCfProperties;
    };
  }
}
