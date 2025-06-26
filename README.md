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

## Getting Started

### 1. Clone the repository
```sh
git clone <your-repo-url>
cd tradingapp
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in the required values.

### 3. Build & Run with Docker Compose
```sh
docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:4000
- IB Service: http://localhost:8000
- PostgreSQL: localhost:5432
- Redis: localhost:6379

### 4. Development
You can run each service locally for development. See each folder's README or package.json for scripts.

### 5. Deployment
Push to GitHub. The included GitHub Actions workflow will build and test your app. Deploy to Railway, Render, or your preferred cloud provider.

## IB Integration
- **Python (ib_async)**: Provided in `ib_service/`.
- **Node.js (node-ib)**: Install and use in `backend/` if preferred.

## License
MIT 