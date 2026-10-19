import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { PHASE_PRODUCTION_SERVER } = require('next/constants');
const nextConfig = require('../next.config.js')(PHASE_PRODUCTION_SERVER) as {
  headers: () => Promise<
    Array<{
      source: string;
      headers: Array<{ key: string; value: string }>;
    }>
  >;
};

describe('Next.js image optimizer', () => {
  it('does not fetch remote hosts on behalf of unauthenticated requests', () => {
    // /_next/image is public. The application renders no remote next/image
    // sources, so any allowed remote pattern only turns the optimizer into a
    // proxy (a port-less localhost pattern matches every loopback port).
    const {
      hasRemoteMatch,
    } = require('next/dist/shared/lib/match-remote-pattern');
    const images = (nextConfig as unknown as { images?: Record<string, any> })
      .images;

    for (const url of [
      'http://localhost:3001/health',
      'http://localhost:6379/',
      'https://images.nvidia.com/a.png',
    ]) {
      expect(
        hasRemoteMatch(
          images?.domains ?? [],
          images?.remotePatterns ?? [],
          new URL(url),
        ),
        url,
      ).toBe(false);
    }
    expect(images?.dangerouslyAllowSVG).not.toBe(true);
  });
});

describe('Next.js security headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it('allows only the pinned NYT origin for Cheltenham webfonts', async () => {
    const routes = await nextConfig.headers();
    const applicationRoute = routes.find((route) => route.source === '/:path*');
    const policy = applicationRoute?.headers.find(
      (header) => header.key === 'Content-Security-Policy',
    )?.value;
    const directives = policy?.split(';').map((directive) => directive.trim());

    expect(
      directives
        ?.find((directive) => directive.startsWith('style-src '))
        ?.split(/\s+/),
    ).toEqual(['style-src', "'self'", "'unsafe-inline'", 'https://g1.nyt.com']);
    expect(
      directives
        ?.find((directive) => directive.startsWith('font-src '))
        ?.split(/\s+/),
    ).toEqual(['font-src', "'self'", 'data:', 'https://g1.nyt.com']);
  });

  it('disables eval and declares sensitive resource directives in production', async () => {
    // Vitest runs with NODE_ENV=test; evaluate the production policy itself.
    vi.stubEnv('NODE_ENV', 'production');
    const routes = await nextConfig.headers();
    const applicationRoute = routes.find((route) => route.source === '/:path*');
    const policy = applicationRoute?.headers.find(
      (header) => header.key === 'Content-Security-Policy',
    )?.value;

    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).not.toContain(' ws:');
  });
});
