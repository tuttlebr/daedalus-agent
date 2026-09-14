import { getAuthConfig, isConfiguredUsername } from './config';

import { getRedis, sessionKey, jsonGet, jsonSet } from '@/server/session/redis';
import bcrypt from 'bcryptjs';

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

// Verify user credentials
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<Omit<User, 'passwordHash'> | null> {
  await initializeUsers();
  if (!isConfiguredUsername(username)) return null;
  const user = await getUserByUsername(username);
  if (!user) return null;

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;

  // Return user without password hash
  const { passwordHash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}
