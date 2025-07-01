# 🐳 Docker Rebuild Instructions - Fix Missing Dependencies

## 🚨 **Current Issue**
The IB Service is failing with `ModuleNotFoundError: No module named 'structlog'` because the Docker image was built before the new dependencies were added.

## ✅ **Immediate Fix Applied**
I've temporarily replaced `main.py` with a fallback version (`main_fallback.py`) that works with existing dependencies. This allows the service to start while you rebuild the image.

## 🔧 **Steps to Rebuild with Full Features**

### **Step 1: Stop Current Containers**
```bash
# Stop all services
docker-compose down

# Alternative if docker-compose doesn't work:
docker compose down
```

### **Step 2: Remove Old Images (Optional but Recommended)**
```bash
# Remove the old ib_service image to force rebuild
docker rmi tradingapp-ib_service

# Or remove all unused images
docker image prune -a
```

### **Step 3: Rebuild with New Dependencies**
```bash
# Rebuild only the ib_service with no cache
docker-compose build --no-cache ib_service

# Alternative syntax:
docker compose build --no-cache ib_service

# Or rebuild all services:
docker-compose build --no-cache
```

### **Step 4: Restore Enhanced Version**
```bash
# Navigate to ib_service directory
cd ib_service

# Restore the enhanced main.py
cp main_enhanced.py main.py

# Verify the file was replaced
head -5 main.py
# Should show: "Improved IB Service with connection pooling..."
```

### **Step 5: Start Services with New Image**
```bash
# Start all services
docker-compose up -d

# Or start with logs visible:
docker-compose up
```

### **Step 6: Verify the Fix**
```bash
# Check if ib_service is running with enhanced features
curl http://localhost:8000/

# Should return version "2.0.0" instead of "1.5.0-fallback"

# Check health with new features
curl http://localhost:8000/health

# Check connection pool status (new endpoint)
curl http://localhost:8000/pool-status
```

## 🔍 **Alternative: Manual Docker Build**

If docker-compose isn't working, build manually:

```bash
# Navigate to ib_service directory
cd ib_service

# Build the image manually
docker build -t tradingapp-ib_service:latest .

# Run the container manually
docker run -d \
  --name ib_service \
  -p 8000:8000 \
  -e IB_HOST=10.7.3.21 \
  -e IB_PORT=4002 \
  -e IB_CLIENT_ID=1 \
  --network tradingapp_tradingapp-network \
  tradingapp-ib_service:latest
```

## 📋 **File Versions Available**

- `main.py` - Currently the fallback version (basic functionality)
- `main_enhanced.py` - Full enhanced version with all improvements
- `main_fallback.py` - Fallback version (works with old dependencies)
- `main_original.py` - Original version before improvements
- `main_improved.py` - Same as main_enhanced.py

## ✅ **Expected Results After Rebuild**

### **Before (Fallback):**
```json
{
  "service": "TradingApp IB Service",
  "version": "1.5.0-fallback",
  "description": "Fallback version running with basic dependencies",
  "note": "Rebuild Docker image to use enhanced version with full features"
}
```

### **After (Enhanced):**
```json
{
  "service": "TradingApp IB Service", 
  "version": "2.0.0",
  "status": "running",
  "features": [
    "Connection pooling",
    "Data validation with Pydantic", 
    "Caching with TTL",
    "Rate limiting",
    "Structured logging",
    "Prometheus metrics",
    "Data quality monitoring"
  ]
}
```

## 🚨 **Troubleshooting**

### **If Docker Commands Don't Work:**
1. Make sure Docker Desktop is running
2. Try using `docker compose` instead of `docker-compose`
3. Run PowerShell as Administrator
4. Restart Docker Desktop

### **If Build Fails:**
1. Check internet connection (downloads dependencies)
2. Clear Docker cache: `docker system prune -a`
3. Check requirements.txt exists in ib_service/
4. Verify Dockerfile syntax

### **If Still Getting Import Errors:**
1. Verify you replaced main.py with main_enhanced.py after rebuild
2. Check Docker logs: `docker-compose logs ib_service`
3. Rebuild with verbose output: `docker-compose build --no-cache --progress=plain ib_service`

## 🎯 **Quick Test Commands**

After rebuild, test these endpoints:

```bash
# Basic health (should work in both versions)
curl http://localhost:8000/health

# Enhanced features (only in rebuilt version)
curl http://localhost:8000/pool-status
curl http://localhost:8000/metrics

# Market data with caching
curl "http://localhost:8000/market-data/history?symbol=MSFT&timeframe=1hour&period=1M"
```

## 📝 **Summary**

1. ✅ **Immediate Fix**: Fallback version is running (basic functionality)
2. 🔄 **Next Step**: Rebuild Docker image with new dependencies  
3. 🚀 **Final Step**: Restore enhanced version for full features

The enhanced version includes:
- Connection pooling (5 concurrent connections)
- Data validation and quality scoring
- TTL-based caching
- Structured logging
- Prometheus metrics
- Health monitoring
- Rate limiting

All these features will be available after rebuilding the Docker image! 🎉 