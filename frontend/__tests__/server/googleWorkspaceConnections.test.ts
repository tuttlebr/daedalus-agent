import {
  getGoogleWorkspaceConnections,
  googleWorkspaceTokenKey,
} from '@/server/googleWorkspaceConnections';
import { beforeEach, describe, expect, it } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  pipeline: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: () => ({ pipeline: mocks.pipeline }),
}));

describe('Google Workspace connection state', () => {
  beforeEach(() => {
    mocks.exec.mockReset();
    mocks.pipeline.mockReset().mockReturnValue({ exec: mocks.exec });
  });

  it('uses the same stable NAT user hash and an isolated service bucket', () => {
    expect(googleWorkspaceTokenKey('gmail', 'alice')).toBe(
      'nat/object_store/gmail-mcp-oauth/tokens/' +
        '23269a2db51e19e93d493d3ebd2353e5c05953fca9e08e1d1f781585c7db1d60',
    );
    expect(googleWorkspaceTokenKey('docs', 'alice')).toBe(
      'nat/object_store/docs-mcp-oauth/tokens/' +
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
          'nat/object_store/docs-mcp-oauth/tokens/' +
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
});
