# Frontend Dockerfile
FROM node:20-alpine

ARG NODE_ENV=production

WORKDIR /app
COPY package*.json ./

# Force install ALL dependencies including devDependencies
# Use --include=dev to ensure devDependencies are installed regardless of NODE_ENV
RUN npm install --include=dev

COPY . .

# Nothing about the deployment is baked into the build: the page calls the
# API on its own address, and server.js forwards /api and /socket.io to
# BACKEND_INTERNAL_URL, read when the container starts.
RUN npm run build

# Now set NODE_ENV for runtime
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000

# server.js runs Next.js and the /api forwarding (see proxy.js).
CMD ["npm", "start"]
