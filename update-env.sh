#!/bin/bash

# Update .env file with missing variables
echo "🔧 Updating .env file with missing variables..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    exit 1
fi

# Add missing variables if they don't exist
add_if_missing() {
    local var_name="$1"
    local var_value="$2"
    
    if ! grep -q "^${var_name}=" .env; then
        echo "${var_name}=${var_value}" >> .env
        echo "✅ Added ${var_name}"
    else
        echo "ℹ️  ${var_name} already exists"
    fi
}

# Add missing variables
echo ""
echo "Adding missing environment variables..."

add_if_missing "IB_CORS_ORIGINS" "http://\${SERVER_IP:-10.7.3.246}:3000"
add_if_missing "REDIS_PASSWORD" ""
add_if_missing "JWT_SECRET" "your_jwt_secret_$(openssl rand -hex 16 2>/dev/null || echo 'changeme123')"
add_if_missing "SESSION_SECRET" "your_session_secret_$(openssl rand -hex 16 2>/dev/null || echo 'changeme456')"

# Also add other useful variables if missing
add_if_missing "FRONTEND_HOST" "0.0.0.0"
add_if_missing "BACKEND_HOST" "0.0.0.0"
add_if_missing "IB_SERVICE_HOST" "0.0.0.0"
add_if_missing "POSTGRES_HOST" "postgres"
add_if_missing "POSTGRES_PORT" "5432"

echo ""
echo "✅ Environment file updated successfully!"
echo ""
echo "📋 Current .env file:"
echo "===================="
cat .env 