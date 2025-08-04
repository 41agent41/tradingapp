#!/bin/bash
# ==============================================
# IB Gateway Startup Script with Timezone Configuration
# Ensures IB Gateway runs with UTC timezone settings
# ==============================================

# Set timezone to UTC
export TZ=UTC

# Print timezone information for verification
echo "=== IB Gateway Startup Configuration ==="
echo "Current timezone: $TZ"
echo "Current UTC time: $(date -u)"
echo "System timezone: $(timedatectl show --property=Timezone --value 2>/dev/null || echo 'N/A')"
echo "=========================================="

# IB Gateway Configuration Variables
IB_GATEWAY_DIR="${IB_GATEWAY_DIR:-/opt/ibgateway}"
IB_GATEWAY_VERSION="${IB_GATEWAY_VERSION:-stable}"
IB_JAVA_OPTS="${IB_JAVA_OPTS:--Xmx1024m}"

# Timezone-specific Java options
TIMEZONE_OPTS="-Duser.timezone=UTC -Djava.util.TimeZone=UTC"

# Logging configuration
LOG_DIR="${LOG_DIR:-/var/log/ibgateway}"
mkdir -p "$LOG_DIR"

# Check if IB Gateway is already running
if pgrep -f "ibgateway" > /dev/null; then
    echo "WARNING: IB Gateway process already running!"
    echo "Use './ib_gateway_stop.sh' to stop existing process first"
    exit 1
fi

# Start IB Gateway with proper timezone configuration
echo "Starting IB Gateway with UTC timezone..."

# For TWS API version
if [ -f "$IB_GATEWAY_DIR/ibgateway" ]; then
    nohup env TZ=UTC \
        java $IB_JAVA_OPTS $TIMEZONE_OPTS \
        -jar "$IB_GATEWAY_DIR/ibgateway.jar" \
        > "$LOG_DIR/ibgateway.log" 2>&1 &
    
    GATEWAY_PID=$!
    echo "IB Gateway started with PID: $GATEWAY_PID"
    echo "$GATEWAY_PID" > /var/run/ibgateway.pid

# For standalone installation
elif [ -f "$IB_GATEWAY_DIR/bin/ibgateway" ]; then
    nohup env TZ=UTC \
        "$IB_GATEWAY_DIR/bin/ibgateway" \
        --timezone=UTC \
        --date-format=YYYYMMDD \
        --time-format=HHMMSS \
        > "$LOG_DIR/ibgateway.log" 2>&1 &
    
    GATEWAY_PID=$!
    echo "IB Gateway started with PID: $GATEWAY_PID"
    echo "$GATEWAY_PID" > /var/run/ibgateway.pid

else
    echo "ERROR: IB Gateway not found at $IB_GATEWAY_DIR"
    echo "Please install IB Gateway or update IB_GATEWAY_DIR variable"
    exit 1
fi

# Wait for startup
echo "Waiting for IB Gateway to start..."
sleep 10

# Verify process is running
if ps -p $GATEWAY_PID > /dev/null; then
    echo "✅ IB Gateway started successfully!"
    echo "📋 Log file: $LOG_DIR/ibgateway.log"
    echo "🔧 Configuration: UTC timezone, YYYYMMDD date format"
else
    echo "❌ IB Gateway failed to start!"
    echo "📋 Check log file: $LOG_DIR/ibgateway.log"
    exit 1
fi

# Display connection information
echo ""
echo "=== Connection Information ==="
echo "Gateway Host: localhost"
echo "Socket Port: 4002 (Paper Trading)"
echo "Socket Port: 4001 (Live Trading)"
echo "Client ID: 1 (default)"
echo "Timezone: UTC"
echo "============================="