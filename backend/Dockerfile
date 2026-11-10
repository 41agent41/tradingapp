# Backend Dockerfile
# Node.js 24 LTS. Dependencies come from package-lock.json exactly (npm ci).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Handle .env file - copy if exists, create default if not
RUN if [ -f .env ]; then echo ".env file found"; else echo "# Default environment file" > .env; fi
# Build with the dev tools, then drop them from the image.
RUN npm run build && npm prune --omit=dev
EXPOSE 4000
CMD ["npm", "start"]
