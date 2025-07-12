# 🔧 TradingApp Troubleshooting Guide

Comprehensive troubleshooting guide for TradingApp deployment and operation issues.

## 📋 Table of Contents

1. [Quick Fix Scripts](#quick-fix-scripts)
2. [Common Issues](#common-issues)
3. [Service-Specific Issues](#service-specific-issues)
4. [Network & Connection Issues](#network--connection-issues)
5. [IB Gateway Connection Issues](#ib-gateway-connection-issues)
6. [Docker & Container Issues](#docker--container-issues)
7. [Development Issues](#development-issues)
8. [Performance Issues](#performance-issues)
9. [Diagnostic Tools](#diagnostic-tools)
10. [Emergency Recovery](#emergency-recovery)

## 🚨 Quick Fix Scripts

### Automatic Fix Script
```bash
# Run automatic connection fix
./fix-ib-connection.sh
```

This script automatically:
- ✅ Creates missing `.env` configuration
- ✅ Rebuilds IB service container
- ✅ Fixes network connectivity issues
- ✅ Tests IB Gateway connection
- ✅ Restarts backend service
- ✅ Verifies all endpoints

### Diagnostic Script
```bash
# Run comprehensive diagnostics
./diagnose-connection.sh
```

This script helps identify:
- Container status and health
- Service connectivity
- IB Gateway connection
- API endpoint availability
- Configuration issues

## 🔍 Common Issues

### Issue 1: Services Won't Start

**Symptoms:**
- Docker containers exit immediately
- Services fail to start up
- Port binding errors

**Solutions:**
```bash
# Check port conflicts
sudo netstat -tlnp | grep -E ':(3000|4000|8000)'

# Stop conflicting services
sudo systemctl stop apache2  # if using Apache
sudo systemctl stop nginx    # if using Nginx

# Clean restart
./deploy-tradingapp.sh stop
./deploy-tradingapp.sh clean
./deploy-tradingapp.sh deploy
```

### Issue 2: Frontend Can't Connect to Backend

**Symptoms:**
- Network errors in browser console
- API calls failing
- CORS errors

**Solutions:**
```bash
# Check environment variables
cat .env | grep -E '(API_URL|CORS_ORIGINS)'

# Verify backend is running
curl http://localhost:4000/health

# Check CORS configuration
grep CORS_ORIGINS .env

# Fix CORS in .env
CORS_ORIGINS=http://your-server-ip:3000,http://localhost:3000
```

### Issue 3: Market Data Search Not Working

**Symptoms:**
- Search returns no results
- API errors when searching
- Contract resolution failures

**Solutions:**
```bash
# Test IB service directly
curl -X POST http://localhost:8000/contract/search \
  -H "Content-Type: application/json" \
  -d '{"symbol":"AAPL","secType":"STK","exchange":"SMART"}'

# Check IB Gateway connection
curl http://localhost:8000/health

# Restart IB service
docker-compose restart ib_service
```

### Issue 4: Charts Not Loading

**Symptoms:**
- Chart components not rendering
- JavaScript errors in console
- TradingView library not loading

**Solutions:**
```bash
# Check frontend logs
docker-compose logs frontend

# Verify TradingView library
# Check browser console for library loading errors

# Restart frontend
docker-compose restart frontend

# Rebuild with no cache
docker-compose build --no-cache frontend
```

## 🏢 Service-Specific Issues

### Frontend Issues

**Issue: Build Failures**
```bash
# Clear npm cache
docker-compose exec frontend npm cache clean --force

# Rebuild with no cache
docker-compose build --no-cache frontend

# Check for TypeScript errors
docker-compose exec frontend npm run build
```

**Issue: Environment Variables Not Loading**
```bash
# Check Next.js environment variable format
grep NEXT_PUBLIC .env

# Ensure variables start with NEXT_PUBLIC_
NEXT_PUBLIC_API_URL=http://your-server-ip:4000

# Restart frontend after env changes
docker-compose restart frontend
```

### Backend Issues

**Issue: API Endpoints Not Responding**
```bash
# Check backend logs
docker-compose logs backend

# Test health endpoint
curl http://localhost:4000/health

# Verify Express server is running
docker-compose exec backend ps aux | grep node

# Check for port conflicts
sudo netstat -tlnp | grep 4000
```

**Issue: Database Connection Errors**
```bash
# Check if database is running
docker-compose ps postgres

# Test database connection
docker-compose exec backend npm run db:test

# Check database environment variables
grep -E '(POSTGRES|DATABASE)' .env
```

### IB Service Issues

**Issue: IB Service Won't Start**
```bash
# Check Python dependencies
docker-compose exec ib_service pip list | grep -E '(fastapi|ib_insync)'

# Rebuild IB service
docker-compose build --no-cache ib_service

# Check for Python errors
docker-compose logs ib_service
```

**Issue: FastAPI Import Errors**
```bash
# Check if FastAPI is installed
docker-compose exec ib_service python -c "import fastapi; print('FastAPI OK')"

# Reinstall dependencies
docker-compose exec ib_service pip install -r requirements.txt

# Check Python path
docker-compose exec ib_service python -c "import sys; print(sys.path)"
```

## 🌐 Network & Connection Issues

### Issue: Services Can't Communicate Internally

**Symptoms:**
- Backend can't reach IB service
- Internal API calls failing
- Docker network issues

**Solutions:**
```bash
# Test internal Docker network
docker-compose exec backend curl http://ib_service:8000/health

# Check Docker network
docker network ls
docker network inspect tradingapp_default

# Recreate network
docker-compose down
docker network prune -f
docker-compose up -d
```

### Issue: External Access Problems

**Symptoms:**
- Can't access application from outside server
- Timeout errors from remote clients
- Firewall blocking connections

**Solutions:**
```bash
# Check firewall status
sudo ufw status

# Open required ports
sudo ufw allow 3000
sudo ufw allow 4000
sudo ufw allow 8000

# Check service binding
netstat -tlnp | grep -E ':(3000|4000|8000)'

# Verify Docker port mapping
docker-compose ps
```

## 🔌 IB Gateway Connection Issues

### Issue: IB Gateway Connection Failed

**Symptoms:**
- IB service shows "not connected" status
- Connection timeout errors
- API connection refused

**Diagnostic Steps:**
```bash
# Test IB Gateway connectivity
telnet your-ib-gateway-ip 4002

# Check IB service logs
docker-compose logs ib_service | grep -i connect

# Verify IB configuration
curl http://localhost:8000/connection
```

**Solutions:**
```bash
# Check .env configuration
grep -E '(IB_HOST|IB_PORT|IB_CLIENT_ID)' .env

# Correct configuration example:
IB_HOST=localhost        # or your IB Gateway IP
IB_PORT=4002            # IB Gateway port
IB_CLIENT_ID=1          # Unique client ID

# Restart IB service
docker-compose restart ib_service

# Run automatic fix
./fix-ib-connection.sh
```

### Issue: IB Gateway API Not Enabled

**Symptoms:**
- Connection attempts fail immediately
- "API not enabled" errors
- No response from IB Gateway

**Solutions:**
1. **Enable API in IB Gateway:**
   - File → Global Configuration → API → Settings
   - Check "Enable ActiveX and Socket Clients"
   - Set port to 4002
   - Click "Apply" and "OK"

2. **Set Trusted IPs:**
   - Add your server IP to trusted IPs
   - For local testing, add 127.0.0.1

3. **Check Client ID:**
   - Ensure unique client ID
   - Try different client IDs (1, 2, 3, etc.)

### Issue: Market Data Permissions

**Symptoms:**
- Connections successful but no market data
- "No market data permissions" errors
- Data requests return empty results

**Solutions:**
1. **Check Market Data Subscriptions:**
   - Verify you have data subscriptions for the assets
   - Check if using paper trading account (limited data)

2. **Test with Different Symbols:**
   - Try major stocks like AAPL, MSFT
   - Use exchanges you have data for

3. **Check Data Permissions:**
   - Account Management → Market Data Subscriptions
   - Verify active subscriptions

## 🐳 Docker & Container Issues

### Issue: Docker Build Failures

**Symptoms:**
- Build process stops with errors
- Package installation failures
- Permission denied errors

**Solutions:**
```bash
# Clear Docker cache
docker system prune -a -f

# Rebuild with no cache
docker-compose build --no-cache

# Check Docker daemon
sudo systemctl status docker

# Increase Docker memory if needed
# Docker Desktop → Settings → Resources → Advanced
```

### Issue: Container Exit Codes

**Common Exit Codes:**
- **Exit Code 0**: Clean exit (normal)
- **Exit Code 1**: General error
- **Exit Code 125**: Docker daemon error
- **Exit Code 126**: Container command not executable
- **Exit Code 127**: Container command not found

**Solutions:**
```bash
# Check exit code
docker-compose ps

# View detailed logs
docker-compose logs service-name

# Check container command
docker-compose exec service-name ps aux

# Verify entrypoint
docker-compose exec service-name which python
```

### Issue: Volume Mount Problems

**Symptoms:**
- Code changes not reflected
- File permission errors
- Volume not found errors

**Solutions:**
```bash
# Check volume mounts
docker-compose config

# Fix permissions
sudo chown -R $USER:$USER ./

# Recreate volumes
docker-compose down -v
docker-compose up -d
```

## 💻 Development Issues

### Issue: TypeScript Errors

**Symptoms:**
- Build fails with TypeScript errors
- Import resolution failures
- Type checking errors

**Solutions:**
```bash
# Check TypeScript configuration
cat frontend/tsconfig.json

# Install missing type definitions
cd frontend
npm install --save-dev @types/node @types/react

# Check for TypeScript errors
npm run type-check
```

### Issue: ESLint/Prettier Conflicts

**Symptoms:**
- Code formatting issues
- Build warnings
- Linting errors

**Solutions:**
```bash
# Fix linting issues
cd frontend
npm run lint:fix

# Format code
npm run format

# Check configuration
cat .eslintrc.json
cat .prettierrc
```

### Issue: Hot Reload Not Working

**Symptoms:**
- Changes not reflected immediately
- Need to restart for changes
- Development server issues

**Solutions:**
```bash
# Check if running in development mode
grep NODE_ENV .env

# Restart development server
docker-compose restart frontend

# Check file watchers
docker-compose exec frontend npm run dev
```

## 🚀 Performance Issues

### Issue: Slow Chart Loading

**Symptoms:**
- Charts take long time to load
- Laggy interactions
- Memory usage issues

**Solutions:**
```bash
# Check memory usage
docker stats

# Optimize chart data
# Reduce historical data range
# Implement data pagination

# Check network latency
curl -w "@curl-format.txt" -o /dev/null http://localhost:8000/health
```

### Issue: High CPU Usage

**Symptoms:**
- System becomes unresponsive
- High CPU usage by containers
- Slow API responses

**Solutions:**
```bash
# Monitor resource usage
htop
docker stats

# Check for infinite loops in logs
docker-compose logs | grep -i error

# Restart problematic services
docker-compose restart service-name
```

### Issue: Memory Leaks

**Symptoms:**
- Memory usage constantly increasing
- Out of memory errors
- System becomes unstable

**Solutions:**
```bash
# Monitor memory usage over time
watch -n 1 'docker stats --no-stream'

# Check for memory leaks in code
# Implement proper cleanup
# Use memory profiling tools

# Restart services periodically
# Set up memory limits in docker-compose.yml
```

## 🔧 Diagnostic Tools

### Health Check Commands

```bash
# Check all services
./deploy-tradingapp.sh status

# Test all connections
./deploy-tradingapp.sh test

# View comprehensive logs
./deploy-tradingapp.sh logs

# Check specific service
docker-compose logs service-name
```

### Network Diagnostics

```bash
# Test internal connectivity
docker-compose exec backend ping ib_service
docker-compose exec frontend ping backend

# Test external connectivity
curl -I http://localhost:3000
curl -I http://localhost:4000
curl -I http://localhost:8000

# Check DNS resolution
nslookup your-domain.com
```

### Database Diagnostics

```bash
# Check database connection
docker-compose exec postgres psql -U tradingapp -d tradingapp -c "SELECT version();"

# Check database logs
docker-compose logs postgres

# Backup database
docker-compose exec postgres pg_dump -U tradingapp tradingapp > backup.sql
```

## 🚨 Emergency Recovery

### Complete System Reset

```bash
# Stop all services
./deploy-tradingapp.sh stop

# Clean everything
./deploy-tradingapp.sh clean

# Remove all Docker data
docker system prune -a -f
docker volume prune -f

# Rebuild from scratch
./deploy-tradingapp.sh deploy
```

### Backup and Restore

```bash
# Create backup
tar -czf tradingapp_backup_$(date +%Y%m%d).tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  .

# Restore from backup
tar -xzf tradingapp_backup_YYYYMMDD.tar.gz
cd tradingapp
./deploy-tradingapp.sh deploy
```

### Configuration Recovery

```bash
# Restore configuration from template
cp env.template .env

# Edit with your specific values
nano .env

# Test configuration
./deploy-tradingapp.sh test
```

## 📞 Getting Help

### Before Asking for Help

1. **Check logs first:**
   ```bash
   ./deploy-tradingapp.sh logs
   ```

2. **Run diagnostics:**
   ```bash
   ./diagnose-connection.sh
   ```

3. **Try automatic fixes:**
   ```bash
   ./fix-ib-connection.sh
   ```

4. **Check documentation:**
   - README.md
   - DEPLOYMENT.md
   - This troubleshooting guide

### When Reporting Issues

Include this information:
- Operating system and version
- Docker and Docker Compose versions
- Complete error messages
- Steps to reproduce the issue
- Output of diagnostic commands
- Configuration files (with sensitive data removed)

### Log Collection

```bash
# Collect comprehensive logs
./deploy-tradingapp.sh logs > logs.txt 2>&1

# Collect system information
docker version >> logs.txt
docker-compose version >> logs.txt
uname -a >> logs.txt
df -h >> logs.txt
free -h >> logs.txt
```

## 📝 Common Error Messages

### "Connection refused"
- Service not running
- Port not accessible
- Firewall blocking connection

### "No such file or directory"
- Missing files
- Incorrect paths
- Permission issues

### "Permission denied"
- File permissions wrong
- Docker permissions not set
- User not in docker group

### "Port already in use"
- Another service using the port
- Previous container not stopped
- Port conflict in configuration

### "Module not found"
- Missing dependencies
- Python path issues
- Package installation failed

### "CORS error"
- CORS origins not configured
- Frontend/backend URL mismatch
- Missing CORS headers

---

**🔧 If you're still having issues, run the diagnostic script and check the logs for specific error messages.** 