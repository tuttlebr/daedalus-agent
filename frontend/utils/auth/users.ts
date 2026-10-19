import { getAuthConfig, isConfiguredUsername } from './config';

import { getRedis, sessionKey, jsonGet, jsonSet } from '@/server/session/redis';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

// Configured hashes must use at least this cost (see config.ts).
const MINIMUM_DECOY_ROUNDS = 12;

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  createdAt: number;
}

// Initialize users in Redis if they don't exist.
//
// Memoized so it runs at most once per process. Configured hashes are copied
// directly; plaintext credentials never enter this reconciliation path.
let initializeUsersPromise: Promise<void> | null = null;

export function initializeUsers(): Promise<void> {
  if (!initializeUsersPromise) {
    initializeUsersPromise = runInitializeUsers().catch((error) => {
      initializeUsersPromise = null;
      throw error;
    });
  }
  return initializeUsersPromise;
}

async function runInitializeUsers(): Promise<void> {
  const config = getAuthConfig();

  for (const configUser of config.users) {
    const userKey = sessionKey(['user', configUser.username]);
    const authUserKey = sessionKey(['auth-user', configUser.username]);
    const existing = (await jsonGet(authUserKey)) as User | null;

    if (!existing) {
      const fullUser: User = {
        id: configUser.id,
        username: configUser.username,
        name: configUser.name,
        passwordHash: configUser.passwordHash,
        createdAt: Date.now(),
      };

      await jsonSet(authUserKey, '.', fullUser);
      await getRedis().del(userKey);
      console.log(`Created default user: ${configUser.username}`);
      continue;
    }

    const needsUpdate =
      existing.passwordHash !== configUser.passwordHash ||
      existing.name !== configUser.name ||
      existing.id !== configUser.id;

    if (needsUpdate) {
      const updatedUser: User = {
        ...existing,
        id: configUser.id,
        username: configUser.username,
        name: configUser.name,
        passwordHash: configUser.passwordHash,
      };
      await jsonSet(authUserKey, '.', updatedUser);
      console.log(`Updated configured user: ${configUser.username}`);
    }
    await getRedis().del(userKey);
  }
}

// Get user by username
async function getUserByUsername(username: string): Promise<User | null> {
  const userKey = sessionKey(['auth-user', username]);
  return (await jsonGet(userKey)) as User | null;
}

// An unknown username must cost the same bcrypt work as a wrong password.
// Returning early answered in about 1 ms instead of about 250 ms, revealing
// which accounts exist and so which ones to lock out. The decoy is fixed for
// the process, at the highest configured cost, and matches no real password.
let decoyPasswordHash: Promise<string> | null = null;

function getDecoyPasswordHash(): Promise<string> {
  if (!decoyPasswordHash) {
    const rounds = Math.max(
      MINIMUM_DECOY_ROUNDS,
      ...getAuthConfig().users.map((user) =>
        bcrypt.getRounds(user.passwordHash),
      ),
    );
    decoyPasswordHash = bcrypt
      .hash(randomBytes(32).toString('hex'), rounds)
      .catch((error) => {
        decoyPasswordHash = null;
        throw error;
      });
  }
  return decoyPasswordHash;
}

// Verify user credentials
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<Omit<User, 'passwordHash'> | null> {
  await initializeUsers();
  const decoyHash = await getDecoyPasswordHash();
  const user = isConfiguredUsername(username)
    ? await getUserByUsername(username)
    : null;

  const isValid = await bcrypt.compare(
    password,
    user?.passwordHash ?? decoyHash,
  );
  if (!user || !isValid) return null;

  // Return user without password hash
  const { passwordHash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}
