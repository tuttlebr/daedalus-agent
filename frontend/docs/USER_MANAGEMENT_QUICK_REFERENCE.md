# User Management Quick Reference

## Redis CLI Commands

### View Users
```bash
# List all users
KEYS session:user:*

# View specific user
JSON.GET session:user:admin

# Pretty print user data
JSON.GET session:user:admin INDENT "\t" NEWLINE "\n" SPACE " "
```

### Create User (requires bcrypt hash)
```bash
JSON.SET session:user:newuser . '{
  "id": "1234567890",
  "username": "newuser",
  "passwordHash": "$2a$10$...",
  "name": "New User",
  "createdAt": 1234567890000
}'
```

### Update User
```bash
# Update name
JSON.SET session:user:john .name '"John Smith"'

# Update password (requires new bcrypt hash)
JSON.SET session:user:john .passwordHash '"$2a$10$..."'
```

### Delete User
```bash
DEL session:user:username
```

## API Endpoints (Admin Only)

### List Users
```bash
GET /api/auth/users
```

### Create User
```bash
POST /api/auth/users
{
  "username": "newuser",
  "password": "password",
  "name": "New User"
}
```

### Update Password
```bash
PATCH /api/auth/users
{
  "username": "existinguser",
  "newPassword": "newpassword"
}
```

## Environment Variables

### Single User
```bash
AUTH_USERNAME=admin
AUTH_PASSWORD=secure-password
AUTH_NAME=Administrator
```

### Multiple Users
```bash
AUTH_USER_1_USERNAME=admin
AUTH_USER_1_PASSWORD=admin-pass
AUTH_USER_1_NAME=Admin

AUTH_USER_2_USERNAME=user
AUTH_USER_2_PASSWORD=user-pass
AUTH_USER_2_NAME=User
```

## Generate Password Hash (Node.js)

```javascript
const bcrypt = require('bcryptjs');
bcrypt.hash('password', 10).then(hash => console.log(hash));
```

## Session Management

### View Active Sessions
```bash
KEYS session:auth-session:*
```

### Delete Session (Force Logout)
```bash
DEL session:auth-session:session-id
```

### Session Expiry
- Default: 24 hours
- Updated on each activity

## Key Patterns

- Users: `session:user:{username}`
- Sessions: `session:auth-session:{sessionId}`
- Session expiry: 86400 seconds (24 hours)
