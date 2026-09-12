import fs from 'fs';
import path from 'path';

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

// Authentication configuration is a process snapshot. Restart every frontend
// and WebSocket process when changing enabled accounts or credentials.
let configuredAuth: AuthConfig | null = null;
let configuredUsernames: Set<string> | null = null;

export function getAuthConfig(): AuthConfig {
  if (!configuredAuth) configuredAuth = loadAuthConfig();
  return configuredAuth;
}

// Session reads must not initialize users, perform bcrypt work, or consult
// historical Redis user records to decide whether an account remains enabled.
export function isConfiguredUsername(username: unknown): boolean {
  if (typeof username !== 'string' || !username) return false;
  if (!configuredUsernames) {
    configuredUsernames = new Set(
      getAuthConfig().users.map((user) => user.username),
    );
  }
  return configuredUsernames.has(username);
}
