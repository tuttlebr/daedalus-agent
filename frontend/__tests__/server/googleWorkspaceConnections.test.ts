import type { GoogleWorkspaceServiceId } from '@/utils/app/googleWorkspace';

import {
  getGoogleWorkspaceConnections,
  googleWorkspaceTokenKey,
  resetGoogleWorkspaceConnection,
} from '@/server/googleWorkspaceConnections';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  pipeline: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: () => ({ pipeline: mocks.pipeline }),
}));

describe('Google Workspace connection state', () => {
  it('agrees with the frozen Python-to-Rust grant key vectors', () => {
    const fixtures = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../builder/runtime/tests/fixtures/authorization.json',
        ),
        'utf8',
      ),
    );
    const vectors = fixtures.cases.filter(
      (item: any) => item.operation === 'oauth-key',
    );
    // An empty selection would make this cross-language contract vacuous.
    expect(vectors.length).toBeGreaterThan(0);
    for (const fixture of vectors) {
      expect(
        googleWorkspaceTokenKey(
          fixture.input.service as GoogleWorkspaceServiceId,
          fixture.input.user,
        ),
      ).toBe(
        typeof fixture.expected === 'string'
          ? fixture.expected
          : fixture.expected.$string_parts.join(''),
      );
    }
  });
  beforeEach(() => {
    mocks.exec.mockReset();
    mocks.pipeline.mockReset().mockReturnValue({ exec: mocks.exec });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the same stable NAT user hash and an isolated service bucket', () => {
    expect(googleWorkspaceTokenKey('gmail', 'alice')).toBe(
      'nat/object_store/gmail-mcp-oauth-ro/tokens/' +
        '23269a2db51e19e93d493d3ebd2353e5c05953fca9e08e1d1f781585c7db1d60',
    );
    expect(googleWorkspaceTokenKey('docs', 'alice')).toBe(
      'nat/object_store/docs-mcp-oauth-drive/tokens/' +
        '23269a2db51e19e93d493d3ebd2353e5c05953fca9e08e1d1f781585c7db1d60',
    );
    expect(googleWorkspaceTokenKey('calendar', 'alice')).toBe(
      'nat/object_store/calendar-mcp-oauth-rw/tokens/' +
        '23269a2db51e19e93d493d3ebd2353e5c05953fca9e08e1d1f781585c7db1d60',
    );
    expect(googleWorkspaceTokenKey('gmail', 'bob')).not.toBe(
      googleWorkspaceTokenKey('gmail', 'alice'),
    );
  });

  it('reports only presence state for all active service tokens', async () => {
    mocks.exec.mockResolvedValue([
      [null, 1],
      [null, 0],
      [null, 1],
    ]);

    const connections = await getGoogleWorkspaceConnections('alice');

    expect(mocks.pipeline).toHaveBeenCalledWith(
      expect.arrayContaining([
        [
          'exists',
          'nat/object_store/docs-mcp-oauth-drive/tokens/' +
            '23269a2db51e19e93d493d3ebd2353e5c05953fca9e08e1d1f781585c7db1d60',
        ],
      ]),
    );
    expect(connections).toHaveLength(3);
    expect(
      connections.map(({ id, authorizationSaved }) => ({
        id,
        authorizationSaved,
      })),
    ).toEqual([
      { id: 'gmail', authorizationSaved: true },
      { id: 'calendar', authorizationSaved: false },
      { id: 'docs', authorizationSaved: true },
    ]);
  });

  it('bounds a reset request when the backend never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    try {
      const reset = resetGoogleWorkspaceConnection('gmail', 'alice');
      const outcome = reset.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(
        'rejected',
      );
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('resets through the trusted backend using the stable NAT identity', async () => {
    vi.stubEnv('DAEDALUS_INTERNAL_API_TOKEN', 'internal-test-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          service: 'docs',
          authorizationCleared: true,
          savedTokenDeleted: true,
          cachedWorkflowsInvalidated: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resetGoogleWorkspaceConnection('docs', 'alice');

    expect(result.cachedWorkflowsInvalidated).toBe(2);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/google-workspace/connections/docs');
    expect(options.method).toBe('DELETE');
    expect(options.headers['x-user-id']).toBe('alice');
    expect(options.headers['x-daedalus-internal-token']).toBe(
      'internal-test-token',
    );
    expect(options.headers.Cookie).toBe(
      'nat-session=daedalus-user-2bd806c97f0e00af1a1fc3328fa763a9',
    );
  });
});
