# Stage 1: Build client and server
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace root package files first for layer caching
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/shared/package.json packages/shared/

# Install ALL dependencies (dev needed for build)
RUN npm ci

# Copy all source code
COPY . .

# Build client (Vite) then server (NestJS SWC)
RUN npm run build:client && npm run build

# Stage 2: Minimal production image
FROM node:22-alpine AS production
WORKDIR /app

# The installer performs every app-store repo mutation over git (the provider's
# REST contents API has no DELETE route, so file removal is impossible there —
# see issue #182). git only: the app-store remote is an http(s) URL, and the ssh
# transport is deliberately not shipped in this release (design §3), so
# openssh-client would be unused attack surface.
RUN apk add --no-cache git

# Copy workspace root package files
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/shared/package.json packages/shared/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built server artifacts
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# Copy built client artifacts
COPY --from=builder /app/packages/client/dist ./packages/client/dist

# Copy shared package source (required at runtime -- @librepod/shared has "main": "src/types.ts")
COPY --from=builder /app/packages/shared/src ./packages/shared/src

# Configure via env vars (D-13)
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "packages/server/dist/main.js"]
