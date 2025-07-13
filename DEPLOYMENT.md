# 🚀 TradingApp Deployment Guide

Complete guide for deploying TradingApp with market data filtering and TradingView charts on remote servers.

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Single Command Deployment](#single-command-deployment)
3. [Manual Deployment](#manual-deployment)
4. [Environment Configuration](#environment-configuration)
5. [Service Verification](#service-verification)
6. [Common Issues & Solutions](#common-issues--solutions)
7. [Production Setup](#production-setup)
8. [Monitoring & Maintenance](#monitoring--maintenance)

## 🎯 Prerequisites

### System Requirements
- **OS**: Linux (Ubuntu 20.04+ recommended) or macOS
- **RAM**: Minimum 2GB, recommended 4GB+
- **Storage**: 10GB+ free space
- **Network**: Stable internet connection
- **Ports**: 3000, 4000, 8000 available

### Software Requirements
- **Docker**: Version 20.10+
- **Docker Compose**: Version 2.0+
- **Git**: For repository cloning

### Interactive Brokers Requirements
- **IB Gateway** or **TWS** running
- **API access enabled** in IB Gateway/TWS settings
- **Market data subscriptions** for assets you want to trade
- **Paper trading account** (recommended for testing)

## 🚀 Single Command Deployment

# as root - Local user creation
sudo adduser <username>
sudo usermod -aG sudo <username>

# as root - install git
apt install git

### Quick Start (Recommended)
## all commands below to be executed as the tradingapp user which has sudo priviledges

```bash
# 1. Clone repository
git clone https://github.com/your-username/tradingapp.git
cd tradingapp

chmod +x *.sh

# Set IB Gateway details in .env file
./fix-ib-config.sh

# 2. Install dependencies (first time only)
./deploy-tradingapp.sh install

# 3. Deploy application
./deploy-tradingapp.sh deploy

# 4. Verify deployment
./deploy-tradingapp.sh status
```

### Available Commands

| Command | Description | Use Case |
|---------|-------------|----------|
| `./deploy-tradingapp.sh install` | Install Docker & dependencies | First time server setup |
| `./deploy-tradingapp.sh deploy` | Deploy full application | Initial deployment |
| `./deploy-tradingapp.sh rebuild` | Rebuild all services | Major updates |
| `./deploy-tradingapp.sh ib-rebuild` | Rebuild IB service only | IB-specific fixes |
| `./deploy-tradingapp.sh status` | Check service health | Monitoring |
| `./deploy-tradingapp.sh test` | Test all connections | Troubleshooting |
| `./deploy-tradingapp.sh logs` | Show service logs | Debugging |
| `./deploy-tradingapp.sh restart` | Restart services | Quick restart |
| `./deploy-tradingapp.sh stop` | Stop all services | Maintenance |
| `./deploy-tradingapp.sh clean` | Clean up containers | Reset environment |
| `./deploy-tradingapp.sh env-setup` | Setup environment file | Configuration |

## 🔧 Manual Deployment

### Step 1: System Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y curl wget git

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Logout and login again for group changes to take effect
```

### Step 2: Repository Setup

```bash
# Clone repository
git clone https://github.com/your-username/tradingapp.git
cd tradingapp

# Make scripts executable
chmod +x deploy-tradingapp.sh
chmod +x diagnose-connection.sh
chmod +x fix-ib-connection.sh
```

### Step 3: Environment Configuration

```bash
# Create environment file from template
cp env.template .env

# Edit environment file with your settings
nano .env
```

### Step 4: Build and Deploy

```bash
# Build all services
docker-compose build

# Start all services
docker-compose up -d

# Check service status
docker-compose ps
```

## ⚙️ Environment Configuration

### Required Environment Variables

Create a `.env` file in the project root:

```bash
# Server Configuration
SERVER_IP=your.server.ip.address
ENVIRONMENT=production

# Frontend Configuration
NEXT_PUBLIC_API_URL=http://your.server.ip.address:4000
FRONTEND_PORT=3000

# Backend Configuration
BACKEND_PORT=4000
CORS_ORIGINS=http://your.server.ip.address:3000

# IB Service Configuration
IB_SERVICE_PORT=8000
IB_HOST=your.ib.gateway.ip
IB_PORT=4002
IB_CLIENT_ID=1
IB_TIMEOUT=30

# Database Configuration (if using)
POSTGRES_PASSWORD=your_secure_password
POSTGRES_USER=tradingapp
POSTGRES_DB=tradingapp
POSTGRES_PORT=5432

# Redis Configuration (if using)
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Security
JWT_SECRET=your_jwt_secret_key
SESSION_SECRET=your_session_secret_key
```

### IB Gateway Configuration

Configure IB Gateway settings:

1. **Enable API Access**:
   - Open IB Gateway/TWS
   - Go to `File → Global Configuration → API → Settings`
   - Check "Enable ActiveX and Socket Clients"
   - Set port to 4002 (or your preferred port)

2. **Set Trusted IPs**:
   - Add your server IP to trusted IP addresses
   - Allow connections from localhost if running locally

3. **Paper Trading** (recommended for testing):
   - Use paper trading account for initial testing
   - Switch to live account only after thorough testing

## 🌐 Service Verification

### Check Service Status

```bash
# Using deployment script
./deploy-tradingapp.sh status

# Using Docker directly
docker-compose ps
docker-compose logs
```

### Test Service Endpoints

```bash
# Frontend
curl -I http://your-server-ip:3000

# Backend API
curl http://your-server-ip:4000/health

# IB Service
curl http://your-server-ip:8000/health

# Test market data search
curl -X POST http://your-server-ip:4000/api/market-data/search \
  -H "Content-Type: application/json" \
  -d '{"symbol":"AAPL","secType":"STK","exchange":"NASDAQ"}'
```

### Access Application

- **Frontend**: `http://your-server-ip:3000`
- **Backend**: `http://your-server-ip:4000`
- **IB Service**: `http://your-server-ip:8000`

## 🔍 Common Issues & Solutions

### Issue 1: Docker Build Failures

**Symptoms**: Build fails with package installation errors

**Solutions**:
```bash
# Clean rebuild
./deploy-tradingapp.sh clean
./deploy-tradingapp.sh rebuild

# Clear Docker cache
docker system prune -a -f
docker-compose build --no-cache
```

### Issue 2: IB Service Connection Issues

**Symptoms**: IB service can't connect to IB Gateway

**Solutions**:
```bash
# Check IB Gateway connectivity
telnet your-ib-gateway-ip 4002

# Run automatic fix
./fix-ib-connection.sh

# Manually restart IB service
docker-compose restart ib_service
```

### Issue 3: Frontend Can't Connect to Backend

**Symptoms**: Frontend shows connection errors

**Solutions**:
```bash
# Check environment variables
cat .env | grep API_URL

# Verify backend is running
curl http://your-server-ip:4000/health

# Check CORS settings
grep CORS_ORIGINS .env
```

### Issue 4: Port Conflicts

**Symptoms**: Services fail to start due to port conflicts

**Solutions**:
```bash
# Check port usage
sudo netstat -tlnp | grep -E ':(3000|4000|8000)'

# Modify ports in .env file
nano .env

# Update docker-compose.yml if needed
nano docker-compose.yml
```

### Issue 5: Permission Errors

**Symptoms**: Permission denied errors in containers

**Solutions**:
```bash
# Fix file permissions
sudo chown -R $USER:$USER .
chmod +x deploy-tradingapp.sh

# Fix Docker permissions
sudo usermod -aG docker $USER
# Logout and login again
```

## 🏭 Production Setup

### 1. Domain and SSL Setup

```bash
# Install nginx
sudo apt install -y nginx certbot python3-certbot-nginx

# Configure nginx reverse proxy
sudo nano /etc/nginx/sites-available/tradingapp

# Example nginx configuration
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ib {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

### 2. Firewall Configuration

```bash
# Configure UFW firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw allow 3000
sudo ufw allow 4000
sudo ufw allow 8000
sudo ufw enable
```

### 3. Process Management

```bash
# Create systemd service for auto-start
sudo nano /etc/systemd/system/tradingapp.service

[Unit]
Description=TradingApp
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/path/to/tradingapp
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
User=your-user

[Install]
WantedBy=multi-user.target

# Enable service
sudo systemctl daemon-reload
sudo systemctl enable tradingapp
sudo systemctl start tradingapp
```

### 4. Database Backup (if using)

```bash
# Create backup script
nano backup-db.sh

#!/bin/bash
BACKUP_DIR="/backups/tradingapp"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup PostgreSQL
docker exec tradingapp_postgres_1 pg_dump -U tradingapp tradingapp > $BACKUP_DIR/db_backup_$DATE.sql

# Keep only last 7 days
find $BACKUP_DIR -name "db_backup_*.sql" -mtime +7 -delete

# Make executable and setup cron
chmod +x backup-db.sh
crontab -e
# Add: 0 2 * * * /path/to/backup-db.sh
```

## 📊 Monitoring & Maintenance

### 1. Service Monitoring

```bash
# Check service health
./deploy-tradingapp.sh status

# Monitor resource usage
docker stats

# Check logs
./deploy-tradingapp.sh logs

# Monitor specific service
docker-compose logs -f ib_service
```

### 2. Performance Monitoring

```bash
# System resources
htop
df -h
free -h

# Docker resources
docker system df
docker system events
```

### 3. Log Management

```bash
# Rotate logs
sudo nano /etc/logrotate.d/docker-container

/var/lib/docker/containers/*/*.log {
    rotate 7
    daily
    compress
    size=10M
    missingok
    delaycompress
    copytruncate
}
```

### 4. Update Process

```bash
# Update application
cd /path/to/tradingapp
git pull origin master
./deploy-tradingapp.sh rebuild

# Update system
sudo apt update && sudo apt upgrade -y
```

### 5. Backup Strategy

```bash
# Application backup
tar -czf tradingapp_backup_$(date +%Y%m%d).tar.gz tradingapp/

# Configuration backup
cp .env .env.backup
cp docker-compose.yml docker-compose.yml.backup
```

## 📞 Support & Troubleshooting

### Getting Help

1. **Check logs first**:
   ```bash
   ./deploy-tradingapp.sh logs
   ```

2. **Run diagnostics**:
   ```bash
   ./diagnose-connection.sh
   ```

3. **Try automatic fixes**:
   ```bash
   ./fix-ib-connection.sh
   ```

### Emergency Recovery

```bash
# Complete reset
./deploy-tradingapp.sh stop
./deploy-tradingapp.sh clean
./deploy-tradingapp.sh deploy

# Restore from backup
tar -xzf tradingapp_backup_YYYYMMDD.tar.gz
cd tradingapp
./deploy-tradingapp.sh deploy
```

## 🎉 Deployment Checklist

- [ ] Server meets minimum requirements
- [ ] Docker and Docker Compose installed
- [ ] Repository cloned and configured
- [ ] Environment variables set in `.env`
- [ ] IB Gateway/TWS running and configured
- [ ] Firewall rules configured
- [ ] All services deployed and healthy
- [ ] Frontend accessible from browser
- [ ] Backend API responding
- [ ] IB service connecting to gateway
- [ ] Market data search working
- [ ] Charts displaying correctly
- [ ] SSL certificate installed (production)
- [ ] Monitoring setup
- [ ] Backup strategy implemented

---

**🚀 Your TradingApp is now ready for professional market data exploration!** 