import { sessionKey, jsonGet, jsonSet } from '@/server/session/redis';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  createdAt: number;
}

interface AuthConfigUser {
  id: string;
  username: string;
  password: string;
  name: string;
}

interface AuthConfig {
  users: AuthConfigUser[];
}

// Load authentication configuration from external file or environment variables
function loadAuthConfig(): AuthConfig {
  // First, check if we have environment variable configuration
  const envUsers: AuthConfigUser[] = [];

  // Support multiple users via environment variables
  let i = 1;
  while (process.env[`AUTH_USER_${i}_USERNAME`]) {
    envUsers.push({
      id: String(i),
      username: process.env[`AUTH_USER_${i}_USERNAME`] || '',
      password: process.env[`AUTH_USER_${i}_PASSWORD`] || '',
      name: process.env[`AUTH_USER_${i}_NAME`] || `User ${i}`,
    });
    i++;
  }

  // Also support a single user via simple env vars
  if (
    envUsers.length === 0 &&
    process.env.AUTH_USERNAME &&
    process.env.AUTH_PASSWORD
  ) {
    envUsers.push({
      id: '1',
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
      name: process.env.AUTH_NAME || 'Admin User',
    });
  }

  // If we have environment users, use them
  if (envUsers.length > 0) {
    console.log(`Loaded ${envUsers.length} users from environment variables`);
    return { users: envUsers };
  }

  // Otherwise, try to load from file (DEPRECATED: Use environment variables instead)
  try {
    const configPath = path.join(
      process.cwd(),
      'frontend',
      'auth-passwords.json',
    );
    const configData = fs.readFileSync(configPath, 'utf-8');
    console.warn(
      'WARNING: Loading authentication from auth-passwords.json is deprecated.',
    );
    console.warn(
      'WARNING: This file contains plaintext passwords and should not be committed to source control.',
    );
    console.warn(
      'WARNING: Please migrate to environment variables (AUTH_USERNAME, AUTH_PASSWORD, etc.)',
    );
    console.log('Loaded authentication configuration from auth-passwords.json');
    return JSON.parse(configData) as AuthConfig;
  } catch (error) {
    console.error('No authentication configuration found.');
    console.error(
      'Please configure authentication using environment variables:',
    );
    console.error('  - Single user: AUTH_USERNAME, AUTH_PASSWORD, AUTH_NAME');
    console.error(
      '  - Multiple users: AUTH_USER_1_USERNAME, AUTH_USER_1_PASSWORD, etc.',
    );
    console.error('See env.example for configuration examples.');
    // Return empty configuration if no auth is configured
    return { users: [] };
  }
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
  const config = loadAuthConfig();

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
  const user = await getUserByUsername(username);
  if (!user) return null;

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;

  // Return user without password hash
  const { passwordHash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}
