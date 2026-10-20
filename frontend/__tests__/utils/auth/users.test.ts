import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/server/session/redis', () => ({
  sessionKey: (parts: string[]) => parts.join(':'),
  getRedis: () => ({
    del: async (key: string) => (records.delete(key) ? 1 : 0),
  }),
  jsonGet: async (key: string) => records.get(key) ?? null,
  jsonSet: async (key: string, _path: string, value: unknown) => {
    records.set(key, value);
  },
}));

describe('credential verification timing', () => {
  beforeEach(() => {
    records.clear();
    vi.resetModules();
    vi.stubEnv('AUTH_USER_1_USERNAME', '');
    vi.stubEnv('AUTH_USERNAME', 'current');
    vi.stubEnv('AUTH_PASSWORD_HASH', bcrypt.hashSync('current-password', 12));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('spends the same bcrypt work on an unknown username as on a wrong password', async () => {
    const users = await import('@/utils/auth/users');
    const compare = vi.spyOn(bcrypt, 'compare');

    expect(await users.verifyCredentials('nobody', 'guess')).toBeNull();
    expect(await users.verifyCredentials('current', 'guess')).toBeNull();
    expect(await users.verifyCredentials('nobody', 'guess-2')).toBeNull();

    expect(compare).toHaveBeenCalledTimes(3);
    const [unknown, known, repeated] = compare.mock.calls.map(
      ([, hash]) => hash as string,
    );
    // The decoy has the configured cost and stays fixed for the process.
    expect(bcrypt.getRounds(unknown)).toBe(bcrypt.getRounds(known));
    expect(unknown).not.toBe(known);
    expect(repeated).toBe(unknown);
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).toMatchObject({ username: 'current' });
  });

  it('recreates a configured account whose Redis record was lost', async () => {
    const users = await import('@/utils/auth/users');
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).toMatchObject({ username: 'current' });

    // A restore, flush or new volume removes the records this process
    // initialized once; the next login must not fail until a restart.
    records.clear();
    expect(await users.verifyCredentials('current', 'wrong')).toBeNull();
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).toMatchObject({ username: 'current' });
    expect(records.get('auth-user:current')).toMatchObject({
      username: 'current',
    });
  });

  it('never accepts an unknown username, even with the decoy password', async () => {
    const users = await import('@/utils/auth/users');
    const compare = vi.spyOn(bcrypt, 'compare');
    compare.mockImplementation(async () => true);

    expect(await users.verifyCredentials('nobody', 'anything')).toBeNull();
    expect(compare).toHaveBeenCalledOnce();
  });

  it('matches the highest configured cost', async () => {
    vi.stubEnv('AUTH_USERNAME', '');
    vi.stubEnv('AUTH_USER_1_USERNAME', 'one');
    vi.stubEnv('AUTH_USER_1_PASSWORD_HASH', bcrypt.hashSync('one', 12));
    vi.stubEnv('AUTH_USER_2_USERNAME', 'two');
    vi.stubEnv('AUTH_USER_2_PASSWORD_HASH', bcrypt.hashSync('two', 13));
    const users = await import('@/utils/auth/users');
    const compare = vi.spyOn(bcrypt, 'compare');

    expect(await users.verifyCredentials('nobody', 'guess')).toBeNull();

    expect(bcrypt.getRounds(compare.mock.calls[0][1] as string)).toBe(13);
  });
});
