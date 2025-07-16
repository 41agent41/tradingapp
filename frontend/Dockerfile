# Frontend Dockerfile
FROM node:20-alpine

# Accept build arguments
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NODE_ENV=production

# Set environment variables for build
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=$NODE_ENV

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Build with environment variables available
RUN npm run build

EXPOSE 3000
CMD ["node", ".next/standalone/server.js"] 