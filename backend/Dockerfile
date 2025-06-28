# Backend Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Handle .env file - copy if exists, create default if not
RUN if [ -f .env ]; then echo ".env file found"; else echo "# Default environment file" > .env; fi
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"] 