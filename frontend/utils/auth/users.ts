import { getAuthConfig, isConfiguredUsername } from './config';

import { sessionKey, jsonGet, jsonSet } from '@/server/session/redis';
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
// Memoized so it runs at most once per process. Previously this ran on EVERY
// login attempt, which re-ran a bcrypt.compare per configured user before the
// real credential check (login-cost amplification / DoS surface — F-014). On
// failure the cache is cleared so the next login can retry.
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
    const existing = (await jsonGet(userKey)) as User | null;

    if (!existing) {
      const passwordHash = await bcrypt.hash(configUser.password, 10);

      const fullUser: User = {
        id: configUser.id,
        username: configUser.username,
        name: configUser.name,
        passwordHash,
        createdAt: Date.now(),
      };

      await jsonSet(userKey, '.', fullUser);
      console.log(`Created default user: ${configUser.username}`);
      continue;
    }

    const passwordMatches = await bcrypt.compare(
      configUser.password,
      existing.passwordHash,
    );
    const needsUpdate =
      !passwordMatches ||
      existing.name !== configUser.name ||
      existing.id !== configUser.id;

    if (needsUpdate) {
      const updatedUser: User = {
        ...existing,
        id: configUser.id,
        username: configUser.username,
        name: configUser.name,
        passwordHash: passwordMatches
          ? existing.passwordHash
          : await bcrypt.hash(configUser.password, 10),
      };
      await jsonSet(userKey, '.', updatedUser);
      console.log(`Updated configured user: ${configUser.username}`);
    }
  }
}

// Get user by username
async function getUserByUsername(username: string): Promise<User | null> {
  const userKey = sessionKey(['user', username]);
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
