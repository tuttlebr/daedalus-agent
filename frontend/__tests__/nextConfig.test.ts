import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const nextConfig = require('../next.config.js') as {
  headers: () => Promise<
    Array<{
      source: string;
      headers: Array<{ key: string; value: string }>;
    }>
  >;
};

describe('Next.js security headers', () => {
  it('allows HTTPS source images used by sandboxed HTML previews', async () => {
    const routes = await nextConfig.headers();
    const applicationRoute = routes.find((route) => route.source === '/:path*');
    const policy = applicationRoute?.headers.find(
      (header) => header.key === 'Content-Security-Policy',
    )?.value;

    expect(policy).toBeDefined();

    const imageDirective = policy
      ?.split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('img-src '));

    expect(imageDirective?.split(/\s+/)).toEqual([
      'img-src',
      "'self'",
      'data:',
      'blob:',
      'https:',
    ]);
  });
});
