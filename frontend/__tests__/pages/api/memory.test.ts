import { resolveMemoryRoute } from '@/pages/api/memory/[...path]';

import { describe, expect, it } from 'vitest';

describe('Memory Center API route allowlist', () => {
  it('maps only fixed identity-bound backend routes', () => {
    expect(resolveMemoryRoute(['memories'])).toEqual({
      methods: ['GET'],
      backendPath: '/v1/memories',
    });
    expect(resolveMemoryRoute(['memories', 'fact-1', 'invalidate'])).toEqual({
      methods: ['POST'],
      backendPath: '/v1/memories/fact-1/invalidate',
    });
    expect(resolveMemoryRoute(['sources', 'source-1'])).toEqual({
      methods: ['GET', 'DELETE'],
      backendPath: '/v1/memory-sources/source-1',
    });
  });

  it('rejects bank paths and unsafe resource identifiers', () => {
    expect(resolveMemoryRoute(['banks', 'someone-else'])).toBeNull();
    expect(resolveMemoryRoute(['sources', '../someone-else'])).toBeNull();
    expect(resolveMemoryRoute(['memories', 'fact/1'])).toBeNull();
    expect(resolveMemoryRoute(['retain-turn'])).toBeNull();
  });
});
