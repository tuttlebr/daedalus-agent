import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiDir = path.join(process.cwd(), 'pages', 'api');
const blockedApiRoutePatterns = [
  /(?:^|\/)home(?:\/|$)/,
  /(?:^|\/)session\/(?:_utils|redis|sanitize|dns-cache)\.(?:ts|tsx)$/,
];

function collectApiSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectApiSourceFiles(fullPath);
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
      return [];
    }
    return [fullPath];
  });
}

describe('pages/api route inventory', () => {
  it('keeps non-route helpers out of the routable API tree', () => {
    const relativeRoutes = collectApiSourceFiles(apiDir)
      .map((file) => path.relative(apiDir, file).split(path.sep).join('/'));

    for (const pattern of blockedApiRoutePatterns) {
      expect(relativeRoutes).not.toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('only contains files that intentionally export an API route handler', () => {
    for (const file of collectApiSourceFiles(apiDir)) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, path.relative(process.cwd(), file)).toMatch(/export\s+default/);
    }
  });
});
