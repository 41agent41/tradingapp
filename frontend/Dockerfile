# Frontend Dockerfile
FROM node:20-alpine

# Accept build arguments
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NODE_ENV=production

WORKDIR /app
COPY package*.json ./

# Install ALL dependencies (including devDependencies) for build
# Don't set NODE_ENV=production yet so devDependencies are installed
RUN npm install

COPY . .

# Set environment variables for build (but not NODE_ENV yet)
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build with environment variables available
RUN npm run build

# Now set NODE_ENV for runtime
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000
CMD ["node", ".next/standalone/server.js"] 