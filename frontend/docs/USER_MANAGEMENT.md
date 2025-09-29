# User Management Guide

This guide explains how to manage users (add, edit, delete) in the Daedalus application, which stores user data in Redis.

## Table of Contents
- [Overview](#overview)
- [User Data Structure](#user-data-structure)
- [Initial User Setup](#initial-user-setup)
- [Managing Users via API](#managing-users-via-api)
- [Managing Users via Redis CLI](#managing-users-via-redis-cli)
- [Managing Users Programmatically](#managing-users-programmatically)

## Overview

The application uses Redis to store user authentication data. Users are stored with the key pattern: `session:user:{username}` and passwords are hashed using bcrypt for security.

## User Data Structure

Each user in Redis has the following structure:

```json
{
  "id": "string",
  "username": "string",
  "passwordHash": "string (bcrypt hash)",
  "name": "string",
  "createdAt": "number (timestamp)"
}
```

## Initial User Setup

There are two ways to configure initial users:

### Method 1: Environment Variables

Set environment variables in your `.env` file:

```bash
# Single user configuration
AUTH_USERNAME=admin
AUTH_PASSWORD=your-secure-password
AUTH_NAME=Administrator

# OR Multiple users configuration
AUTH_USER_1_USERNAME=admin
AUTH_USER_1_PASSWORD=admin-password
AUTH_USER_1_NAME=Administrator

AUTH_USER_2_USERNAME=john
AUTH_USER_2_PASSWORD=johns-password
AUTH_USER_2_NAME=John Doe

AUTH_USER_3_USERNAME=jane
AUTH_USER_3_PASSWORD=janes-password
AUTH_USER_3_NAME=Jane Smith
```

### Method 2: Configuration File

Create `frontend/auth-passwords.json`:

```json
{
  "users": [
    {
      "id": "1",
      "username": "admin",
      "password": "admin-password",
      "name": "Administrator"
    },
    {
      "id": "2",
      "username": "john",
      "password": "johns-password",
      "name": "John Doe"
    }
  ]
}
```

**Note**: Initial users are created automatically when the application starts. The passwords in the configuration are plain text but are hashed before storing in Redis.

## Managing Users via API

The application provides REST API endpoints for user management. **Note**: These endpoints require admin authentication.

### List All Users
```bash
curl -X GET http://localhost:3000/api/auth/users \
  -H "Cookie: your-session-cookie"
```

### Create a New User
```bash
curl -X POST http://localhost:3000/api/auth/users \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "username": "newuser",
    "password": "secure-password",
    "name": "New User"
  }'
```

### Update User Password
```bash
curl -X PATCH http://localhost:3000/api/auth/users \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "username": "existinguser",
    "newPassword": "new-secure-password"
  }'
```

**Important**: Only users with username "admin" can access these endpoints.

## Managing Users via Redis CLI

You can manage users directly through Redis CLI or any Redis client.

### Connect to Redis
```bash
redis-cli -h localhost -p 6379
```

### List All Users
```bash
KEYS session:user:*
```

### View a Specific User
```bash
JSON.GET session:user:admin
```

### Create a New User

First, you need to hash the password using bcrypt. Here's a Node.js script to generate the hash:

```javascript
// hash-password.js
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.log('Usage: node hash-password.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 10).then(hash => {
  console.log('Password hash:', hash);
});
```

Then insert the user into Redis:

```bash
JSON.SET session:user:newuser . '{
  "id": "1234567890",
  "username": "newuser",
  "passwordHash": "$2a$10$...",
  "name": "New User",
  "createdAt": 1234567890000
}'
```

### Update User Data
```bash
# Update user's name
JSON.SET session:user:john .name '"John Smith"'

# Update password hash (after generating new hash)
JSON.SET session:user:john .passwordHash '"$2a$10$..."'
```

### Delete a User
```bash
DEL session:user:username
```

### View All User Sessions
```bash
# List all active sessions
KEYS session:auth-session:*

# View a specific session
JSON.GET session:auth-session:session-id
```

## Managing Users Programmatically

You can also manage users using the provided utility functions in your code:

```typescript
import {
  createUser,
  getUserByUsername,
  updateUserPassword,
  listUsers
} from '@/utils/auth/users';

// Create a new user
const newUser = await createUser('username', 'password', 'Full Name');

// Get user by username
const user = await getUserByUsername('username');

// Update user password
const success = await updateUserPassword('username', 'new-password');

// List all users (without password hashes)
const users = await listUsers();
```

## Security Considerations

1. **Password Storage**: All passwords are hashed using bcrypt with a salt factor of 10
2. **Session Management**: Sessions expire after 24 hours of inactivity
3. **Admin Access**: Only users with username "admin" can manage other users via API
4. **Environment Variables**: Keep your `.env` file secure and never commit it to version control
5. **Redis Security**: Ensure your Redis instance is properly secured and not publicly accessible

## Troubleshooting

### User not found after creation
- Check the Redis key pattern: `session:user:{username}`
- Ensure Redis connection is working: `redis-cli ping`

### Cannot login with correct password
- Verify the password hash is correctly stored
- Check if the user exists: `JSON.GET session:user:username`
- Ensure initial users are loaded: Check application startup logs

### Session expires too quickly
- Sessions expire after 24 hours (configured in `SESSION_EXPIRY`)
- Check `lastActivity` timestamp in session data

### API returns 403 Forbidden
- Ensure you're logged in as an admin user (username: "admin")
- Check your session cookie is being sent with requests

## Examples

### Complete User Management Script

```javascript
// user-management.js
const Redis = require('ioredis');
const bcrypt = require('bcryptjs');

const redis = new Redis();

async function createUser(username, password, name) {
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(),
    username,
    passwordHash,
    name,
    createdAt: Date.now()
  };

  await redis.call('JSON.SET', `session:user:${username}`, '.', JSON.stringify(user));
  console.log(`User ${username} created successfully`);
}

async function deleteUser(username) {
  await redis.del(`session:user:${username}`);
  console.log(`User ${username} deleted`);
}

async function listAllUsers() {
  const keys = await redis.keys('session:user:*');
  for (const key of keys) {
    const user = JSON.parse(await redis.call('JSON.GET', key));
    console.log(`Username: ${user.username}, Name: ${user.name}`);
  }
}

// Usage
(async () => {
  await createUser('testuser', 'password123', 'Test User');
  await listAllUsers();
  await deleteUser('testuser');
})();
```

## Best Practices

1. Always use strong passwords
2. Regularly rotate passwords for sensitive accounts
3. Monitor failed login attempts
4. Implement rate limiting on authentication endpoints
5. Use HTTPS in production to protect session cookies
6. Regularly backup your Redis data
7. Consider implementing two-factor authentication for admin users
