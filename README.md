# TradingApp

A web-based trading platform integrating with Interactive Brokers, built with Next.js, Express, PostgreSQL, Redis, and Python FastAPI.

## Features
- Centralized settings page
- Real-time trading data
- Interactive Brokers integration (Python or Node.js)
- PostgreSQL & Redis support
- Fully containerized for remote deployment

## Project Structure
- `frontend/` — Next.js 14 + TypeScript + Tailwind CSS
- `backend/` — Node.js + Express + TypeScript
- `ib_service/` — Python FastAPI microservice (ib_async)
- `docker-compose.yml` — Orchestrates all services

## Remote Server Deployment

### Prerequisites
- Docker and Docker Compose installed on your server
- Server with at least 2GB RAM and 10GB storage
- Ports 3000, 4000, 8000, 5432, 6379 available

### Quick Deployment
1. **Clone the repository on your server:**
```sh
git clone <your-repo-url>
cd tradingapp
```

2. **Run the deployment script:**
```sh
chmod +x deploy.sh
./deploy.sh
```

3. **Update the API URL in .env:**
```sh
# Edit .env file and update NEXT_PUBLIC_API_URL to your server's domain
nano .env
```

### Manual Deployment
1. **Create environment file:**
```sh
cp .env.example .env
# Edit .env with your server's configuration
```

2. **Build and start services:**
```sh
docker-compose up --build -d
```

3. **Access the application:**
- Frontend: `http://your-server-ip:3000`
- Backend: `http://your-server-ip:4000`
- IB Service: `http://your-server-ip:8000`

### Environment Configuration
Create a `.env` file with these variables:
```env
# Database Configuration
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=tradingapp

# Frontend Configuration (IMPORTANT for settings page)
NEXT_PUBLIC_API_URL=http://your-server-domain.com:4000

# Other configurations...
```

## Development Setup

### Local Development
```sh
# Backend
cd backend
npm install
npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

### Docker Development
```sh
docker-compose up --build
```

## Troubleshooting

### Settings Page Not Working
1. **Check API URL**: Ensure `NEXT_PUBLIC_API_URL` in `.env` points to your server's backend
2. **Check CORS**: Backend has CORS enabled for cross-origin requests
3. **Check Backend**: Verify backend is running on port 4000
4. **Check Network**: Ensure ports are accessible from your client

### Common Issues
- **Port conflicts**: Change ports in `docker-compose.yml` if needed
- **Memory issues**: Increase server RAM or reduce container resources
- **Database connection**: Check PostgreSQL credentials in `.env`

## IB Integration
- **Python (ib_async)**: Provided in `ib_service/`.
- **Node.js (node-ib)**: Install and use in `backend/` if preferred.

## License
MIT 