# Backend Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Create a default .env file if none exists
RUN test -f .env || echo "# Default environment file" > .env
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"] 