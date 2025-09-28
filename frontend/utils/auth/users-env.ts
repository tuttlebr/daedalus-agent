import bcrypt from 'bcryptjs';
import { getRedis, sessionKey } from '@/pages/api/session/redis';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  createdAt: number;
}

interface AuthUser {
  id: string;
  username: string;
  password: string;
  name: string;
}

// Load authentication configuration from environment variables
function loadAuthConfig(): AuthUser[] {
  const users: AuthUser[] = [];

  // Support multiple users via environment variables
  // Format: AUTH_USER_1_USERNAME, AUTH_USER_1_PASSWORD, AUTH_USER_1_NAME, etc.
  let i = 1;
  while (process.env[`AUTH_USER_${i}_USERNAME`]) {
    users.push({
      id: String(i),
      username: process.env[`AUTH_USER_${i}_USERNAME`] || '',
      password: process.env[`AUTH_USER_${i}_PASSWORD`] || '',
      name: process.env[`AUTH_USER_${i}_NAME`] || `User ${i}`
    });
    i++;
  }

  // Also support a single user via simple env vars for backward compatibility
  if (users.length === 0 && process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
    users.push({
      id: '1',
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
      name: process.env.AUTH_NAME || 'Admin User'
    });
  }

  // If no users configured, log warning
  if (users.length === 0) {
    console.warn('No authentication users configured. Please set AUTH_USERNAME and AUTH_PASSWORD environment variables.');
  }

  return users;
}

// Initialize users in Redis if they don't exist
export async function initializeUsers() {
  const redis = getRedis();
  const users = loadAuthConfig();

  for (const user of users) {
    const userKey = sessionKey(['users', user.username]);
    const exists = await redis.exists(userKey);

    if (!exists) {
      const hashedPassword = await bcrypt.hash(user.password, 10);
      const userData: User = {
        id: user.id,
        username: user.username,
        passwordHash: hashedPassword,
        name: user.name,
        createdAt: Date.now()
      };

      await redis.set(userKey, JSON.stringify(userData));
      console.log(`Initialized user: ${user.username}`);
    }
  }
}

// Get user by username
export async function getUserByUsername(username: string): Promise<User | null> {
  const redis = getRedis();
  const userKey = sessionKey(['users', username]);
  const userData = await redis.get(userKey);

  if (!userData) {
    return null;
  }

  return JSON.parse(userData) as User;
}

// Verify user credentials
export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const user = await getUserByUsername(username);

  if (!user) {
    return null;
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);

  if (!isValid) {
    return null;
  }

  return user;
}

// Create a new user (optional - for admin functionality)
export async function createUser(username: string, password: string, name: string): Promise<User> {
  const redis = getRedis();
  const existingUser = await getUserByUsername(username);

  if (existingUser) {
    throw new Error('User already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user: User = {
    id: Date.now().toString(),
    username,
    passwordHash: hashedPassword,
    name,
    createdAt: Date.now()
  };

  const userKey = sessionKey(['users', username]);
  await redis.set(userKey, JSON.stringify(user));

  return user;
}

// Update user password
export async function updateUserPassword(username: string, newPassword: string): Promise<boolean> {
  const user = await getUserByUsername(username);

  if (!user) {
    return false;
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  user.passwordHash = hashedPassword;

  const redis = getRedis();
  const userKey = sessionKey(['users', username]);
  await redis.set(userKey, JSON.stringify(user));

  return true;
}

// List all users (without password hashes)
export async function listUsers(): Promise<Omit<User, 'passwordHash'>[]> {
  const redis = getRedis();
  const pattern = sessionKey(['users', '*']);
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
