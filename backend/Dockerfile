# Backend Dockerfile
# Node.js 24 LTS. Dependencies come from package-lock.json exactly (npm ci).
#
# Three stages, so the image that runs holds the compiled code and its
# production dependencies only: no compiler, no test tools, no sources.

# Compiles the TypeScript, which needs the dev tools.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The production dependencies alone.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read-only to the app: it runs as `node` (uid 1000) and
# writes nothing here.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The schema and migrations, which the backend applies at startup.
COPY --from=build /app/src/database ./src/database
COPY package.json ./
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
