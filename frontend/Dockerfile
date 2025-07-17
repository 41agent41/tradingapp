# Frontend Dockerfile
FROM node:20-alpine

# Accept build arguments
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NODE_ENV=production

WORKDIR /app
COPY package*.json ./

# Force install ALL dependencies including devDependencies
# Use --include=dev to ensure devDependencies are installed regardless of NODE_ENV
RUN npm install --include=dev

COPY . .

# Set environment variables for build
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build with environment variables available
RUN npm run build

# Copy static assets for standalone mode
RUN cp -r .next/static .next/standalone/.next/
RUN mkdir -p .next/standalone/public && cp -r public/* .next/standalone/public/ || true

# Now set NODE_ENV for runtime
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000
WORKDIR /app/.next/standalone
CMD ["node", "server.js"] 