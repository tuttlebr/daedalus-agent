interface AuthConfigUser {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
}

interface AuthConfig {
  users: AuthConfigUser[];
}

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const MINIMUM_BCRYPT_ROUNDS = 12;

function validatePasswordHash(username: string, passwordHash: string): string {
  const match = passwordHash.match(BCRYPT_HASH_PATTERN);
  const rounds = match ? Number(match[1]) : 0;
  if (rounds < MINIMUM_BCRYPT_ROUNDS) {
    throw new Error(
      `Authentication hash for ${username} must be a bcrypt hash with cost ${MINIMUM_BCRYPT_ROUNDS} or greater`,
    );
  }
  return passwordHash;
}

// Load authentication configuration from precomputed password hashes. Plaintext
// passwords are intentionally not accepted into the long-lived process.
function loadAuthConfig(): AuthConfig {
  const envUsers: AuthConfigUser[] = [];

  // Support multiple users via environment variables
  let i = 1;
  while (process.env[`AUTH_USER_${i}_USERNAME`]) {
    envUsers.push({
      id: String(i),
      username: process.env[`AUTH_USER_${i}_USERNAME`] || '',
      passwordHash: validatePasswordHash(
        process.env[`AUTH_USER_${i}_USERNAME`] || `user ${i}`,
        process.env[`AUTH_USER_${i}_PASSWORD_HASH`] || '',
      ),
      name: process.env[`AUTH_USER_${i}_NAME`] || `User ${i}`,
    });
    i++;
  }

  // Also support a single user via simple env vars
  if (
    envUsers.length === 0 &&
    process.env.AUTH_USERNAME &&
    process.env.AUTH_PASSWORD_HASH
  ) {
    envUsers.push({
      id: '1',
      username: process.env.AUTH_USERNAME,
      passwordHash: validatePasswordHash(
        process.env.AUTH_USERNAME,
        process.env.AUTH_PASSWORD_HASH,
      ),
      name: process.env.AUTH_NAME || 'Admin User',
    });
  }

  if (envUsers.length > 0) {
    console.log(`Loaded ${envUsers.length} users from environment variables`);
    return { users: envUsers };
  }

  if (process.env.AUTH_PASSWORD || process.env.AUTH_USER_1_PASSWORD) {
    throw new Error(
      'Plaintext AUTH_PASSWORD variables are not supported; configure AUTH_PASSWORD_HASH values instead',
    );
  }

  console.error('No authentication configuration found.');
  console.error(
    'Configure AUTH_USERNAME with AUTH_PASSWORD_HASH, or numbered AUTH_USER_* entries.',
  );
  return { users: [] };
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
