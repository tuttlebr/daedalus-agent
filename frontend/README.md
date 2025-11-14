# Daedalus - UI

This is the frontend user interface for Daedalus, an AI agent system for research and data gathering.

This project was originally forked from [NeMo-Agent-Toolkit-UI](https://github.com/NVIDIA/NeMo-Agent-Toolkit-UI) and builds upon:
- [chatbot-ui](https://github.com/mckaywrigley/chatbot-ui) by Mckay Wrigley
- [chatbot-ollama](https://github.com/ivanfioravanti/chatbot-ollama) by Ivan Fioravanti

## Features
- 🎨 Modern and responsive user interface
- 🔄 Real-time streaming responses
- 🔐 User authentication with Redis
- 🌙 Light/Dark theme
- 🔌 HTTP API integration
- 🐳 Docker support

## Getting Started

### Prerequisites
- Daedalus backend services running
- Node.js (v18 or higher)
- npm or Docker
- Redis (for authentication)

### Installation

Install dependencies:
```bash
cd frontend
npm ci
```

### Running the Application

#### Local Development
```bash
npm run dev
```
The application will be available at `http://localhost:3000`

#### Docker Deployment
```bash
# Build the Docker image
docker build -t daedalus-ui .

# Run the container with environment variables from .env
# Ensure the .env file is present before running this command.
# Skip --env-file .env if no overrides are needed.
docker run --env-file .env -p 3000:3000 daedalus-ui
```

## Configuration

### Environment Variables
**IMPORTANT:** Authentication credentials should be configured using environment variables only. Do not commit plaintext passwords to source control.

Configure the application using environment variables or a `.env` file:

```bash
# Authentication (REQUIRED - Use environment variables, not auth-passwords.json)
# Single user setup:
AUTH_USERNAME=admin
AUTH_PASSWORD=your-secure-password
AUTH_NAME=Administrator

# Multiple users setup:
# AUTH_USER_1_USERNAME=user1
# AUTH_USER_1_PASSWORD=secure-password-1
# AUTH_USER_1_NAME=User One
# AUTH_USER_2_USERNAME=user2
# AUTH_USER_2_PASSWORD=secure-password-2
# AUTH_USER_2_NAME=User Two

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# Backend API
API_URL=http://localhost:8000
```

**Security Note:** The `auth-passwords.json` file is deprecated and should not be used in production. Always use environment variables for authentication credentials. See `env.example` for complete configuration examples.

### HTTP API Connection
Settings can be configured by selecting the `Settings` icon located on the bottom left corner of the home page.

### Settings Options
- `Theme`: Light or Dark theme
- `HTTP URL for Chat Completion`: REST API endpoint
  - `/chat` - Streaming chat completion (recommended)
  - `/chat` - Single response chat completion

## User Management

For detailed information on managing users, see:
- [User Management Guide](docs/USER_MANAGEMENT.md)
- [User Management Quick Reference](docs/USER_MANAGEMENT_QUICK_REFERENCE.md)
