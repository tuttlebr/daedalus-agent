import bcrypt from 'bcryptjs';
import { getRedis, sessionKey } from '@/pages/api/session/redis';
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
      name: process.env[`AUTH_USER_${i}_NAME`] || `User ${i}`
    });
    i++;
  }

  // Also support a single user via simple env vars
  if (envUsers.length === 0 && process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
    envUsers.push({
      id: '1',
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
      name: process.env.AUTH_NAME || 'Admin User'
    });
  }

  // If we have environment users, use them
  if (envUsers.length > 0) {
    console.log(`Loaded ${envUsers.length} users from environment variables`);
    return { users: envUsers };
  }

  // Otherwise, try to load from file
  try {
    const configPath = path.join(process.cwd(), 'frontend', 'auth-passwords.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    console.log('Loaded authentication configuration from auth-passwords.json');
    return JSON.parse(configData) as AuthConfig;
  } catch (error) {
    console.error('No authentication configuration found.');
    console.error('Please either:');
    console.error('1. Set AUTH_USERNAME and AUTH_PASSWORD environment variables, or');
    console.error('2. Create frontend/auth-passwords.json from the template file');
    // Return empty configuration if no auth is configured
    return { users: [] };
  }
}


// Initialize users in Redis if they don't exist
export async function initializeUsers() {
  const redis = getRedis();
  const config = loadAuthConfig();

  for (const configUser of config.users) {
    const userKey = sessionKey(['user', configUser.username]);
    const exists = await redis.exists(userKey);

    if (!exists) {
      const passwordHash = await bcrypt.hash(configUser.password, 10);

      const fullUser: User = {
        id: configUser.id,
        username: configUser.username,
        name: configUser.name,
        passwordHash,
        createdAt: Date.now(),
      };

      await redis.set(userKey, JSON.stringify(fullUser));
      console.log(`Created default user: ${configUser.username}`);
    }
  }
}

// Get user by username
export async function getUserByUsername(username: string): Promise<User | null> {
  const redis = getRedis();
  const userKey = sessionKey(['user', username]);

  const userData = await redis.get(userKey);
  if (!userData) return null;

  return JSON.parse(userData) as User;
}

// Verify user credentials
export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user) return null;

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;

  // Return user without password hash
  const { passwordHash, ...userWithoutPassword } = user;
  return user;
}

// Create a new user (admin function)
export async function createUser(username: string, password: string, name: string): Promise<User> {
  const redis = getRedis();
  const userKey = sessionKey(['user', username]);

  // Check if user already exists
  const exists = await redis.exists(userKey);
  if (exists) {
    throw new Error('User already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user: User = {
    id: Date.now().toString(),
    username,
    passwordHash,
    name,
    createdAt: Date.now(),
  };

  await redis.set(userKey, JSON.stringify(user));
  return user;
}

// Update user password
export async function updateUserPassword(username: string, newPassword: string): Promise<boolean> {
  const user = await getUserByUsername(username);
  if (!user) return false;

  const redis = getRedis();
  const userKey = sessionKey(['user', username]);

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await redis.set(userKey, JSON.stringify(user));

  return true;
}

// List all users (admin function)
export async function listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
  const redis = getRedis();
  const pattern = sessionKey(['user', '*']);

  const keys = await redis.keys(pattern);
  const users: Omit<User, 'passwordHash'>[] = [];

  for (const key of keys) {
    const userData = await redis.get(key);
    if (userData) {
      const user = JSON.parse(userData) as User;
      const { passwordHash, ...userWithoutPassword } = user;
      users.push(userWithoutPassword);
    }
  }

  return users;
}
