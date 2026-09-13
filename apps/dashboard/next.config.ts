import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  agentRules: false,
  output: 'standalone',
  outputFileTracingRoot: path.resolve('.'),
  outputFileTracingExcludes: { '/*': ['./.local/**/*', './.env*', './test-results/**/*'] },
  poweredByHeader: false,
  turbopack: { root: path.resolve('.') },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      // Native form POSTs retain their Origin; external links receive no referrer.
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'" }
    ] }];
  }
};
export default config;
