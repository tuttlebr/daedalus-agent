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
        '4811d14abce5ba76c031dbca898a701ef72508a6ad87c755c8ff896d665847ad',
    );
    expect(googleWorkspaceTokenKey('sheets', 'alice')).toBe(
      'nat/object_store/sheets-mcp-oauth/tokens/' +
        '4811d14abce5ba76c031dbca898a701ef72508a6ad87c755c8ff896d665847ad',
    );
    expect(googleWorkspaceTokenKey('gmail', 'bob')).not.toBe(
      googleWorkspaceTokenKey('gmail', 'alice'),
    );
  });

  it('reports only presence state for all six service tokens', async () => {
    mocks.exec.mockResolvedValue([
      [null, 1],
      [null, 0],
      [null, 1],
      [null, 0],
      [null, 1],
      [null, 0],
    ]);

    const connections = await getGoogleWorkspaceConnections('alice');

    expect(mocks.pipeline).toHaveBeenCalledWith(
      expect.arrayContaining([
        [
          'exists',
          'nat/object_store/docs-mcp-oauth/tokens/' +
            '4811d14abce5ba76c031dbca898a701ef72508a6ad87c755c8ff896d665847ad',
        ],
      ]),
    );
    expect(connections).toHaveLength(6);
    expect(
      connections.map(({ id, authorizationSaved }) => ({
        id,
        authorizationSaved,
      })),
    ).toEqual([
      { id: 'gmail', authorizationSaved: true },
      { id: 'calendar', authorizationSaved: false },
      { id: 'drive', authorizationSaved: true },
      { id: 'docs', authorizationSaved: false },
      { id: 'sheets', authorizationSaved: true },
      { id: 'slides', authorizationSaved: false },
    ]);
  });
});
