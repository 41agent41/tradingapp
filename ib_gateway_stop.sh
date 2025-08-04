#!/bin/bash
# ==============================================
# IB Gateway Stop Script
# Safely stops IB Gateway process
# ==============================================

echo "=== Stopping IB Gateway ==="

# Check for PID file
PID_FILE="/var/run/ibgateway.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    echo "Found PID file with PID: $PID"
    
    # Check if process is running
    if ps -p $PID > /dev/null; then
        echo "Stopping IB Gateway process (PID: $PID)..."
        kill $PID
        
        # Wait for graceful shutdown
        sleep 5
        
        # Force kill if still running
        if ps -p $PID > /dev/null; then
            echo "Force stopping IB Gateway..."
            kill -9 $PID
        fi
        
        echo "✅ IB Gateway stopped successfully"
    else
        echo "⚠️ Process not running (stale PID file)"
    fi
    
    # Remove PID file
    rm -f "$PID_FILE"
else
    echo "No PID file found, checking for running processes..."
    
    # Find and kill any ibgateway processes
    PIDS=$(pgrep -f "ibgateway")
    
    if [ -n "$PIDS" ]; then
        echo "Found IB Gateway processes: $PIDS"
        echo "Stopping all IB Gateway processes..."
        pkill -f "ibgateway"
        sleep 3
        pkill -9 -f "ibgateway" 2>/dev/null
        echo "✅ All IB Gateway processes stopped"
    else
        echo "ℹ️ No IB Gateway processes found"
    fi
fi

echo "==========================="