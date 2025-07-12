# 🔧 IB Service Connection Troubleshooting Guide

## 🚨 Quick Fix for Connection Issues

If your IB service connection is failing, follow these steps:

### **Step 1: Automatic Fix (Recommended)**
```bash
# Run the automatic fix script
./fix-ib-connection.sh
```

This script will automatically:
- ✅ Create missing `.env` configuration
- ✅ Rebuild the IB service container  
- ✅ Fix network connectivity issues
- ✅ Test IB Gateway connection
- ✅ Restart backend service
- ✅ Verify all endpoints

### **Step 2: Run Diagnostics**
```bash
# Run comprehensive diagnostics
./diagnose-connection.sh
```

This will help you identify specific issues if the automatic fix doesn't work.

---

## 🔍 Common Issues & Solutions

### **Issue 1: IB Service Not Responding**

**Symptoms:**
- Backend shows "Failed to connect to IB Gateway" errors
- `curl http://localhost:8000/health` returns connection refused
- IB service container is not running

**Solutions:**
```bash
# Quick fix
./fix-ib-connection.sh

# Manual fix
docker-compose restart ib_service
# OR rebuild completely
docker-compose build --no-cache ib_service
docker-compose up -d ib_service
```

### **Issue 2: Network Connectivity Problems**

**Symptoms:**
- Services can't communicate with each other
- Backend can't reach IB service internally
- External access works but internal doesn't

**Solutions:**
```bash
# Reset Docker network
docker-compose down --remove-orphans
docker network prune -f
docker-compose up -d

# Or use the fix script
./fix-ib-connection.sh
```

### **Issue 3: IB Gateway Connection Failed**

**Symptoms:**
- IB service responds but shows "not connected" status
- Connection to IB Gateway times out
- API connection refused errors

**Check List:**
1. **IB Gateway/TWS is running** on the specified host
2. **API access is enabled** in IB Gateway/TWS settings
3. **Correct host and port** in `.env` file (`IB_HOST` and `IB_PORT`)
4. **Firewall allows** connection on IB Gateway port (usually 4002)
5. **Client ID conflicts** - try different `IB_CLIENT_ID` values

**Test Connection:**
```bash
# Test if IB Gateway is reachable
telnet YOUR_IB_HOST 4002

# Test via IB service
curl -X POST http://localhost:8000/connect
```

### **Issue 4: Missing Configuration**

**Symptoms:**
- Services start but use wrong URLs/ports
- CORS errors in browser
- Environment variables not found

**Solution:**
```bash
# Create proper .env file
./fix-ib-connection.sh

# Or manually create from template
cp env.template .env
# Edit .env with your server's IP address
```

### **Issue 5: Docker/Container Issues**

**Symptoms:**
- Containers exit immediately
- Build failures
- Permission errors

**Solutions:**
```bash
# Clean rebuild everything
docker-compose down --remove-orphans
docker system prune -f
docker-compose build --no-cache
docker-compose up -d

# Check logs for specific errors
docker-compose logs ib_service
docker-compose logs backend
```

---

## 🛠️ Manual Troubleshooting Commands

### **Check Service Status**
```bash
# Check all containers
docker ps -a

# Check specific service logs
docker logs tradingapp-ib_service-1 --tail 50
docker logs tradingapp-backend-1 --tail 50

# Check service health
curl http://localhost:8000/health
curl http://localhost:4000/api/ib-status
```

### **Test Network Connectivity**
```bash
# Test internal Docker network
docker exec tradingapp-backend-1 curl http://ib_service:8000/health
docker exec tradingapp-backend-1 ping ib_service

# Test external access
curl http://localhost:3000  # Frontend
curl http://localhost:4000  # Backend
curl http://localhost:8000  # IB Service
```

### **Test IB Gateway Connection**
```bash
# Test raw connection to IB Gateway
telnet YOUR_IB_HOST 4002

# Test via IB service API
curl -X POST http://localhost:8000/connect
curl http://localhost:8000/connection

# Manual connection test in IB service container
docker exec -it tradingapp-ib_service-1 python3 -c "
from ib_insync import IB
ib = IB()
try:
    ib.connect('localhost', 4002, clientId=1)
    print('Connected:', ib.isConnected())
    ib.disconnect()
except Exception as e:
    print('Error:', e)
"
```

---

## 📋 Configuration Checklist

### **Environment Variables (.env file)**
Make sure these are properly set:

```bash
# IB Configuration
IB_HOST=localhost              # IP where IB Gateway is running
IB_PORT=4002                   # IB Gateway API port  
IB_CLIENT_ID=1                 # Unique client ID
IB_SERVICE_PORT=8000           # IB service port

# Network Configuration  
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:4000
CORS_ORIGINS=http://YOUR_SERVER_IP:3000
BACKEND_PORT=4000
FRONTEND_PORT=3000
```

### **IB Gateway/TWS Settings**
1. **Enable API access**: Settings → API → Enable ActiveX and Socket Clients
2. **Set correct port**: Usually 4002 for IB Gateway, 7497 for TWS
3. **Allow connections**: Add your server IP to trusted IPs if needed
4. **Client ID**: Must be unique, different from other connections

### **Server/Firewall Settings**
```bash
# Check if ports are open
sudo ufw status
netstat -tlnp | grep -E ':(3000|4000|8000|4002)'

# Open required ports
sudo ufw allow 3000
sudo ufw allow 4000  
sudo ufw allow 8000
```

---

## 🎯 Step-by-Step Recovery Process

If everything is broken, follow this complete recovery process:

### **1. Stop Everything**
```bash
docker-compose down --remove-orphans
docker system prune -f
```

### **2. Check Configuration**
```bash
# Verify .env file exists and is correct
cat .env
# Update server IP if needed
```

### **3. Rebuild Services**
```bash
docker-compose build --no-cache
docker-compose up -d
```

### **4. Verify Services**
```bash
# Wait for services to start
sleep 30

# Check status
docker ps
curl http://localhost:3000
curl http://localhost:4000/api/ib-status  
curl http://localhost:8000/health
```

### **5. Test IB Connection**
```bash
# Connect to IB Gateway
curl -X POST http://localhost:8000/connect

# Check connection status
curl http://localhost:8000/connection
```

---

## 📞 Getting Help

If issues persist after trying these solutions:

1. **Run full diagnostics**: `./diagnose-connection.sh`
2. **Check logs**: `./deploy-tradingapp.sh logs`
3. **Verify IB Gateway**: Make sure it's running with API enabled
4. **Check network**: Ensure server firewall allows required ports
5. **Review configuration**: Double-check all IPs and ports in `.env`

### **Useful Log Commands**
```bash
# Real-time logs for all services
docker-compose logs -f

# Specific service logs
docker-compose logs -f ib_service
docker-compose logs -f backend  
docker-compose logs -f frontend

# System logs for Docker
sudo journalctl -u docker.service --since "1 hour ago"
```

### **Common Error Messages & Fixes**

| Error Message | Solution |
|---------------|----------|
| "Connection refused" | IB service not running → `./fix-ib-connection.sh` |
| "Cannot reach ib_service" | Network issue → restart Docker network |
| "API connection failed" | IB Gateway not accessible → check IB_HOST/IB_PORT |
| "Client ID already in use" | Change IB_CLIENT_ID in .env |
| "Permission denied" | Docker permissions → `sudo usermod -aG docker $USER` |
| "Port already in use" | Kill conflicting process → `sudo lsof -i :PORT` |

---

## ✅ Success Indicators

When everything is working correctly, you should see:

- ✅ All containers running: `docker ps` shows tradingapp-frontend-1, tradingapp-backend-1, tradingapp-ib_service-1
- ✅ Services respond: All endpoints return 200 OK
- ✅ IB connected: `curl http://localhost:8000/connection` shows `"connected": true`  
- ✅ No errors in logs: `docker-compose logs` shows successful connections
- ✅ Frontend loads: Browser shows TradingView charts at `http://YOUR_SERVER_IP:3000`

Remember: The **automated fix script** resolves 90% of common issues, so always try `./fix-ib-connection.sh` first! 