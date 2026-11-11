# Frontend Dockerfile
# Node.js 24 LTS. Dependencies come from package-lock.json exactly (npm ci).
#
# Three stages, so the image that runs holds the built pages, the server and
# its production dependencies only: no build tools, no sources.

# Builds the pages, which needs the dev tools whatever NODE_ENV is.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
# Nothing about the deployment is baked into the build: the page calls the
# API on its own address, and server.js forwards /api and /socket.io to
# BACKEND_INTERNAL_URL, read when the container starts.
RUN npm run build && rm -rf .next/cache

# The production dependencies alone.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
WORKDIR /app
# Owned by root and read-only to the app, which runs as `node` (uid 1000).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.js server.js backendProxy.js ./
# The one place Next.js writes while it runs.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
# server.js runs Next.js and the /api forwarding (see backendProxy.js).
CMD ["node", "server.js"]
