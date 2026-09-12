import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/server/session/redis', () => ({
  sessionKey: (parts: string[]) => parts.join(':'),
  jsonGet: async (key: string) => records.get(key) ?? null,
  jsonSet: async (key: string, _path: string, value: unknown) => {
    records.set(key, value);
  },
}));

describe('configured login eligibility across process restarts', () => {
  beforeEach(() => {
    records.clear();
    vi.resetModules();
    vi.stubEnv('AUTH_USER_1_USERNAME', '');
    vi.stubEnv('AUTH_USERNAME', 'current');
    vi.stubEnv('AUTH_PASSWORD', 'current-password');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('checks session eligibility without initializing Redis users and caches configuration until restart', async () => {
    const { isConfiguredUsername } = await import('@/utils/auth/config');
    expect(isConfiguredUsername('current')).toBe(true);
    expect(isConfiguredUsername('removed')).toBe(false);
    expect(isConfiguredUsername(undefined)).toBe(false);
    expect(records.size).toBe(0);
    vi.stubEnv('AUTH_USERNAME', 'replacement');
    expect(isConfiguredUsername('current')).toBe(true);
    expect(isConfiguredUsername('replacement')).toBe(false);
    vi.resetModules();
    const restarted = await import('@/utils/auth/config');
    expect(restarted.isConfiguredUsername('current')).toBe(false);
    expect(restarted.isConfiguredUsername('replacement')).toBe(true);
    expect(records.size).toBe(0);
  });

  it('rejects removed persisted credentials and preserves their historical record', async () => {
    records.set('user:removed', {
      id: 'old',
      username: 'removed',
      name: 'Former user',
      createdAt: 1,
      passwordHash: await bcrypt.hash('old-password', 4),
    });
    const users = await import('@/utils/auth/users');
    await users.initializeUsers();
    expect(await users.verifyCredentials('removed', 'old-password')).toBeNull();
    expect(records.has('user:removed')).toBe(true);
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).toMatchObject({ username: 'current' });
  });

  it('reconciles changed configuration after restart rather than treating persisted users as enabled', async () => {
    let users = await import('@/utils/auth/users');
    await users.initializeUsers();
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).not.toBeNull();
    vi.stubEnv('AUTH_USERNAME', 'replacement');
    vi.stubEnv('AUTH_PASSWORD', 'replacement-password');
    vi.resetModules();
    users = await import('@/utils/auth/users');
    await users.initializeUsers();
    expect(
      await users.verifyCredentials('current', 'current-password'),
    ).toBeNull();
    expect(
      await users.verifyCredentials('replacement', 'replacement-password'),
    ).not.toBeNull();
  });
});
