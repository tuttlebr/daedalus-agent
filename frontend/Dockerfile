FROM node:18-alpine AS base

# Set timezone to Eastern Time
ENV TZ=America/New_York
RUN apk add --no-cache tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone
# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies with retry logic and extended timeouts
RUN npm config set fetch-retry-mintimeout 60000 && \
    npm config set fetch-retry-maxtimeout 300000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-timeout 600000 && \
    npm install --no-audit --legacy-peer-deps

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

# Build with increased memory limit for Next.js
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

# Bundle WebSocket sidecar into a single JS file (all dependencies included)
RUN npx esbuild ws-server.ts --bundle --platform=node --target=node18 --outfile=./ws-build/ws-server.js

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/next.config.js ./
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

# Copy WebSocket sidecar
COPY --from=builder --chown=nextjs:nodejs /app/ws-build/ws-server.js ./ws-server.js

USER nextjs

EXPOSE 3000 3001

ENV PORT=3000
ENV WS_PORT=3001
# set hostname to localhost
ENV HOSTNAME=0.0.0.0

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
# Start both Next.js and WebSocket sidecar
CMD ["sh", "-c", "node ws-server.js & node server.js"]
