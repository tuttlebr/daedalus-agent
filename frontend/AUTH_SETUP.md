# Authentication Setup Guide

This application supports flexible authentication configuration through environment variables, avoiding the need to include sensitive password files in Docker images.

## Quick Start

### Option 1: Using Docker Compose (Recommended)

1. Copy the example environment file:
   ```bash
   cp env.example .env
   ```

2. Edit `.env` and set your authentication credentials:
   ```env
   AUTH_USERNAME=admin
   AUTH_PASSWORD=your-secure-password-here
   AUTH_NAME=Administrator
   ```

3. Run with Docker Compose:
   ```bash
   docker-compose up -d
   ```

### Option 2: Using Docker Run

```bash
docker run -d \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=your-secure-password \
  -e AUTH_NAME="Admin User" \
  -e REDIS_URL=redis://your-redis-host:6379 \
  your-image-name
```

### Option 3: Local Development

For local development, you can either:

1. **Use environment variables:**
   ```bash
   export AUTH_USERNAME=admin
   export AUTH_PASSWORD=password123
   export AUTH_NAME="Local Admin"
   npm run dev
   ```

2. **Use the auth-passwords.json file:**
   ```bash
   cp auth-passwords.json.template frontend/auth-passwords.json
   # Edit frontend/auth-passwords.json with your credentials
   npm run dev
   ```

## Configuration Options

### Single User Setup

The simplest configuration for a single admin user:

```env
AUTH_USERNAME=admin
AUTH_PASSWORD=secure-password-here
AUTH_NAME=Administrator
```

### Multiple Users Setup

For multiple users, use numbered environment variables:

```env
# User 1
AUTH_USER_1_USERNAME=admin
AUTH_USER_1_PASSWORD=admin-password
AUTH_USER_1_NAME=Administrator

# User 2
AUTH_USER_2_USERNAME=user1
AUTH_USER_2_PASSWORD=user1-password
AUTH_USER_2_NAME=Regular User

# User 3
AUTH_USER_3_USERNAME=viewer
AUTH_USER_3_PASSWORD=viewer-password
AUTH_USER_3_NAME=Read-Only User
```

## Security Best Practices

1. **Never commit credentials**: The `.env` file is in `.gitignore` and should never be committed to version control.

2. **Use strong passwords**: Generate secure passwords using tools like:
   ```bash
   openssl rand -base64 32
   ```

3. **Use secrets management**: In production, consider using:
   - Docker Secrets
   - Kubernetes Secrets
   - AWS Secrets Manager
   - HashiCorp Vault
   - Azure Key Vault

4. **Rotate passwords regularly**: Update passwords periodically and restart the application.

## Kubernetes Deployment

For Kubernetes, use secrets:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: auth-credentials
type: Opaque
data:
  AUTH_USERNAME: YWRtaW4=  # base64 encoded
  AUTH_PASSWORD: cGFzc3dvcmQ=  # base64 encoded

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
spec:
  template:
    spec:
      containers:
      - name: app
        image: your-image
        envFrom:
        - secretRef:
            name: auth-credentials
```

## Troubleshooting

### No users can log in

Check that environment variables are properly set:
- In Docker: `docker exec <container> env | grep AUTH`
- In Docker Compose: Check your `.env` file exists and is properly formatted
- Ensure Redis is running and accessible

### Authentication works but redirects back to login page

This is usually caused by cookie configuration issues:
- If running on HTTP (not HTTPS), ensure `FORCE_SECURE_COOKIES=false` is set
- Check browser developer tools → Application → Cookies to see if the `sid` cookie is being set
- If behind a proxy, ensure the proxy forwards the correct headers

### Password changes not taking effect

Users are initialized in Redis on first startup. To change passwords:
1. Clear Redis data or use a Redis client to delete user keys
2. Restart the application with new credentials

### Development vs Production

- Development: Can use `auth-passwords.json` file for convenience
- Production: Always use environment variables or secrets management

## Migration from auth-passwords.json

If you're migrating from the file-based approach:

1. Extract your current users from `auth-passwords.json`
2. Convert them to environment variables in your `.env` file
3. Remove `auth-passwords.json` from your deployment
4. Restart your application

The application will automatically prefer environment variables over the JSON file when both are present.
