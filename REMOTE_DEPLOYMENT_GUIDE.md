# 🚀 Remote Server Deployment Guide

## 📋 **Prerequisites**

### **Server Requirements:**
- **OS**: Ubuntu 20.04+ / CentOS 8+ / Amazon Linux 2
- **CPU**: 2+ cores
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 20GB+ free space
- **Network**: Public IP address, ports 3000, 4000, 8000 open

### **Software Requirements:**
- Docker 24.0+
- Docker Compose 2.0+
- Git

## 🛠️ **Step 1: Server Setup**

### **Install Docker (Ubuntu/Debian):**
```bash
# Update package index
sudo apt update

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Logout and login again for group changes
```

### **Install Docker (CentOS/RHEL):**
```bash
# Install Docker
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

## 📥 **Step 2: Deploy Application**

### **Clone Repository:**
```bash
git clone https://github.com/41agent41/tradingapp.git
cd tradingapp
```

### **Create Environment File:**
```bash
# Copy the template
cp env.template .env

# Edit with your server's details
nano .env
```

### **Configure .env for Your Server:**
```bash
# ==============================================
# TradingApp Environment Configuration
# ==============================================

# ===== DEPLOYMENT CONFIGURATION =====
NODE_ENV=production
DEPLOYMENT_TYPE=remote
SERVER_HOST=0.0.0.0

# ===== FRONTEND CONFIGURATION =====
# Replace YOUR_SERVER_IP with your actual server IP
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:4000
FRONTEND_PORT=3000

# ===== BACKEND CONFIGURATION =====
BACKEND_PORT=4000
# Replace YOUR_SERVER_IP with your actual server IP
CORS_ORIGINS=http://YOUR_SERVER_IP:3000

# ===== IB SERVICE CONFIGURATION =====
IB_SERVICE_PORT=8000
# Replace with your Interactive Brokers Gateway IP
IB_HOST=YOUR_IB_GATEWAY_IP
IB_PORT=4002
IB_CLIENT_ID=1
IB_LOG_LEVEL=INFO

# ===== DATABASE CONFIGURATION =====
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=your_secure_password_here
POSTGRES_DB=tradingapp

# ===== REDIS CONFIGURATION =====
REDIS_HOST=redis
REDIS_PORT=6379

# ===== SECURITY =====
JWT_SECRET=your_random_jwt_secret_key_here
SESSION_SECRET=your_random_session_secret_here
```

## 🐳 **Step 3: Deploy with Docker**

### **Option 1: Quick Deploy (Recommended)**
```bash
# Make the rebuild script executable
chmod +x rebuild-ib-service.sh

# Run the automated deployment
./rebuild-ib-service.sh
```

### **Option 2: Manual Deploy**
```bash
# Build all services
docker-compose build --no-cache

# Start all services
docker-compose up -d

# Check status
docker-compose ps
```

## 🔍 **Step 4: Verify Deployment**

### **Check Service Health:**
```bash
# Check all containers are running
docker-compose ps

# Check logs for any errors
docker-compose logs

# Test individual services
curl http://localhost:3000  # Frontend
curl http://localhost:4000  # Backend  
curl http://localhost:8000/health  # IB Service
```

### **Test from External IP:**
```bash
# Replace YOUR_SERVER_IP with actual IP
curl http://YOUR_SERVER_IP:3000
curl http://YOUR_SERVER_IP:4000
curl http://YOUR_SERVER_IP:8000/health
```

## 🌐 **Step 5: Configure Firewall**

### **Ubuntu/Debian (ufw):**
```bash
# Enable firewall
sudo ufw enable

# Allow necessary ports
sudo ufw allow 22    # SSH
sudo ufw allow 3000  # Frontend
sudo ufw allow 4000  # Backend
sudo ufw allow 8000  # IB Service

# Check status
sudo ufw status
```

### **CentOS/RHEL (firewalld):**
```bash
# Start firewall
sudo systemctl start firewalld
sudo systemctl enable firewalld

# Allow ports
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=4000/tcp
sudo firewall-cmd --permanent --add-port=8000/tcp
sudo firewall-cmd --reload
```

## 🔧 **Step 6: Configure Domain (Optional)**

### **If using a domain name:**
```bash
# Update .env file
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
CORS_ORIGINS=https://yourdomain.com

# Set up reverse proxy (nginx example)
sudo apt install nginx

# Create nginx config
sudo nano /etc/nginx/sites-available/tradingapp
```

### **Nginx Configuration:**
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 80;
    server_name api.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 📊 **Step 7: Monitoring & Maintenance**

### **View Logs:**
```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f ib_service
docker-compose logs -f backend
docker-compose logs -f frontend
```

### **Update Application:**
```bash
# Pull latest changes
git pull origin master

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### **Backup Database:**
```bash
# Create database backup
docker-compose exec postgres pg_dump -U tradingapp tradingapp > backup_$(date +%Y%m%d).sql

# Restore database
docker-compose exec -T postgres psql -U tradingapp tradingapp < backup_20240101.sql
```

## 🚨 **Troubleshooting**

### **Common Issues:**

#### **1. Services won't start:**
```bash
# Check Docker daemon
sudo systemctl status docker

# Check disk space
df -h

# Check memory
free -h

# Restart Docker
sudo systemctl restart docker
```

#### **2. IB Service connection fails:**
```bash
# Check IB Gateway connectivity
telnet YOUR_IB_GATEWAY_IP 4002

# Check IB service logs
docker-compose logs ib_service

# Verify environment variables
docker-compose exec ib_service env | grep IB_
```

#### **3. Frontend can't connect to backend:**
```bash
# Verify CORS configuration
docker-compose exec backend env | grep CORS

# Check network connectivity
docker-compose exec frontend curl http://backend:4000/health
```

#### **4. Database connection issues:**
```bash
# Check PostgreSQL status
docker-compose exec postgres pg_isready

# Reset database
docker-compose down
docker volume rm tradingapp_pgdata
docker-compose up -d
```

## 🔐 **Security Recommendations**

### **Production Security:**
1. **Change default passwords** in .env file
2. **Use SSL/TLS certificates** (Let's Encrypt)
3. **Configure fail2ban** to prevent brute force attacks
4. **Regular security updates**:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```
5. **Limit SSH access** to specific IPs
6. **Use environment-specific secrets** management

### **Docker Security:**
```bash
# Run Docker security scan
docker scout quickview

# Update base images regularly
docker-compose pull
docker-compose build --no-cache
```

## 📈 **Performance Tuning**

### **For High-Load Environments:**
```yaml
# docker-compose.override.yml
version: '3.8'
services:
  backend:
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 512M
          
  ib_service:
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 1G
```

## 📞 **Support**

### **Health Check Endpoints:**
- Frontend: `http://YOUR_SERVER_IP:3000`
- Backend: `http://YOUR_SERVER_IP:4000/health`
- IB Service: `http://YOUR_SERVER_IP:8000/health`

### **Service URLs:**
- **Frontend**: `http://YOUR_SERVER_IP:3000`
- **Backend API**: `http://YOUR_SERVER_IP:4000`
- **IB Service**: `http://YOUR_SERVER_IP:8000`

### **Quick Commands:**
```bash
# Restart all services
docker-compose restart

# View resource usage
docker stats

# Clean up unused resources
docker system prune -a

# Update and restart
git pull && docker-compose up -d --build
```

---

## 🎉 **Success!**

Your TradingApp should now be running on your remote server! 

Access your application at: `http://YOUR_SERVER_IP:3000`

For any issues, check the troubleshooting section or review the logs using `docker-compose logs`. 