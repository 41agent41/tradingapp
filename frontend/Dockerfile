# Frontend Dockerfile
# Node.js 24 LTS. Dependencies come from package-lock.json exactly (npm ci).
FROM node:24-alpine

ARG NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./

# All dependencies, including the dev tools the build needs, whatever NODE_ENV is.
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Nothing about the deployment is baked into the build: the page calls the
# API on its own address, and server.js forwards /api and /socket.io to
# BACKEND_INTERNAL_URL, read when the container starts.
RUN npm run build && npm prune --omit=dev

# Now set NODE_ENV for runtime
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000

# server.js runs Next.js and the /api forwarding (see backendProxy.js).
CMD ["npm", "start"]
