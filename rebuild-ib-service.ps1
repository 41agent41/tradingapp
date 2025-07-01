# 🐳 Auto-Rebuild IB Service with Enhanced Features (PowerShell)
# This script fixes the missing dependencies error and enables all improvements

Write-Host "🚀 Starting IB Service Rebuild Process..." -ForegroundColor Green

# Check if Docker is available
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker is not available. Please install Docker Desktop." -ForegroundColor Red
    exit 1
}

# Step 1: Stop current containers
Write-Host "⏹️  Stopping current containers..." -ForegroundColor Yellow
try {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        docker-compose down
    } else {
        docker compose down
    }
} catch {
    Write-Host "❌ Failed to stop containers: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Step 2: Remove old image to force rebuild
Write-Host "🗑️  Removing old ib_service images..." -ForegroundColor Yellow
docker rmi tradingapp-ib_service 2>$null
docker rmi tradingapp_ib_service 2>$null

# Step 3: Rebuild the ib_service with no cache
Write-Host "🔨 Rebuilding ib_service with new dependencies..." -ForegroundColor Cyan
try {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        docker-compose build --no-cache ib_service
    } else {
        docker compose build --no-cache ib_service
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Docker build failed. Check the error messages above." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ Docker build failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Step 4: Restore enhanced version
Write-Host "⚡ Restoring enhanced main.py version..." -ForegroundColor Magenta
Push-Location ib_service
if (Test-Path "main_enhanced.py") {
    Copy-Item "main_enhanced.py" "main.py" -Force
    Write-Host "✅ Enhanced version restored" -ForegroundColor Green
} else {
    Write-Host "⚠️  main_enhanced.py not found. Enhanced features may not be available." -ForegroundColor Yellow
}
Pop-Location

# Step 5: Start services
Write-Host "🚀 Starting services with enhanced ib_service..." -ForegroundColor Green
try {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        docker-compose up -d
    } else {
        docker compose up -d
    }
} catch {
    Write-Host "❌ Failed to start services: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Step 6: Wait for services to start
Write-Host "⏳ Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Step 7: Verify the fix
Write-Host "🔍 Verifying the enhanced features..." -ForegroundColor Cyan

# Test basic endpoint
Write-Host "Testing basic endpoint..." -ForegroundColor White
try {
    $response = Invoke-RestMethod -Uri "http://localhost:8000/" -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($response) {
        $version = $response.version
        if ($version -eq "2.0.0") {
            Write-Host "✅ Enhanced version (2.0.0) is running!" -ForegroundColor Green
        } else {
            Write-Host "⚠️  Version: $version (expected 2.0.0)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "❌ IB Service is not responding on port 8000" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Failed to test basic endpoint: $($_.Exception.Message)" -ForegroundColor Red
}

# Test enhanced endpoints
Write-Host "Testing enhanced endpoints..." -ForegroundColor White
try {
    $poolStatus = Invoke-RestMethod -Uri "http://localhost:8000/pool-status" -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($poolStatus) {
        Write-Host "✅ Connection pool endpoint working" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Connection pool endpoint not available" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  Connection pool endpoint not available" -ForegroundColor Yellow
}

try {
    $metrics = Invoke-RestMethod -Uri "http://localhost:8000/metrics" -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($metrics) {
        Write-Host "✅ Metrics endpoint working" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Metrics endpoint not available" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  Metrics endpoint not available" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "🎉 Rebuild process completed!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Service Status:" -ForegroundColor Cyan
Write-Host "   Frontend:   http://localhost:3000" -ForegroundColor White
Write-Host "   Backend:    http://localhost:4000" -ForegroundColor White
Write-Host "   IB Service: http://localhost:8000" -ForegroundColor White
Write-Host ""
Write-Host "🔧 Enhanced Features Available:" -ForegroundColor Cyan
Write-Host "   • Connection pooling (5 connections)" -ForegroundColor White
Write-Host "   • Data validation with Pydantic" -ForegroundColor White
Write-Host "   • TTL-based caching" -ForegroundColor White
Write-Host "   • Rate limiting" -ForegroundColor White
Write-Host "   • Structured logging" -ForegroundColor White
Write-Host "   • Prometheus metrics" -ForegroundColor White
Write-Host "   • Health monitoring" -ForegroundColor White
Write-Host ""
Write-Host "📋 Test Commands:" -ForegroundColor Cyan
Write-Host "   Invoke-RestMethod http://localhost:8000/health" -ForegroundColor White
Write-Host "   Invoke-RestMethod http://localhost:8000/pool-status" -ForegroundColor White
Write-Host "   Invoke-RestMethod http://localhost:8000/metrics" -ForegroundColor White
Write-Host ""
Write-Host "📖 For troubleshooting, see: ib_service/DOCKER_REBUILD_INSTRUCTIONS.md" -ForegroundColor Yellow 