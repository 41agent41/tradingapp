#!/bin/bash
# ==============================================
# Trading App Timestamp Configuration Verification Script
# Tests trading application APIs with remote IB Gateway
# ==============================================

echo "=== Trading App Timestamp Verification (Remote IB Gateway) ==="
echo ""
echo "📍 Architecture: IB Gateway (Remote: 10.7.3.21) → Trading App (This Server)"
echo ""

# Function to test timestamp format
test_timestamp_format() {
    local endpoint="$1"
    local description="$2"
    
    echo "🔍 Testing: $description"
    echo "📡 Endpoint: $endpoint"
    
    # Make API request
    response=$(curl -s "$endpoint" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$response" ]; then
        # Check if response contains bars data
        if echo "$response" | grep -q '"bars"'; then
            echo "✅ API Response received"
            
            # Extract first timestamp
            timestamp=$(echo "$response" | grep -o '"timestamp":[0-9]*' | head -1 | cut -d':' -f2)
            
            if [ -n "$timestamp" ]; then
                echo "📊 Raw timestamp: $timestamp"
                
                # Test timestamp interpretations
                echo "📅 Timestamp interpretations:"
                
                # Unix seconds format
                if command -v date >/dev/null 2>&1; then
                    seconds_date=$(date -d "@$timestamp" 2>/dev/null || date -r "$timestamp" 2>/dev/null)
                    echo "   As seconds: $seconds_date"
                    
                    # Unix milliseconds format  
                    milliseconds_timestamp=$((timestamp / 1000))
                    milliseconds_date=$(date -d "@$milliseconds_timestamp" 2>/dev/null || date -r "$milliseconds_timestamp" 2>/dev/null)
                    echo "   As milliseconds: $milliseconds_date"
                fi
                
                # Check if timestamp is reasonable (between 2020-2030)
                current_year=$(date +%Y)
                if [ "$timestamp" -gt 1577836800 ] && [ "$timestamp" -lt 1893456000 ]; then
                    echo "✅ Timestamp appears to be in Unix seconds format (reasonable range)"
                elif [ "$timestamp" -gt 1577836800000 ] && [ "$timestamp" -lt 1893456000000 ]; then
                    echo "⚠️ Timestamp appears to be in Unix milliseconds format"
                else
                    echo "❌ Timestamp out of reasonable range (2020-2030)"
                fi
            else
                echo "❌ No timestamp found in response"
            fi
        else
            echo "❌ No bars data in response"
            echo "Response preview: $(echo "$response" | head -c 200)..."
        fi
    else
        echo "❌ Failed to get API response"
    fi
    
    echo ""
}

# Check trading app environment configuration
echo "🔧 Trading App Configuration:"
echo "   TZ (App Timezone): ${TZ:-'Not set (should be UTC)'}"
echo "   IB_HOST (Remote Gateway): ${IB_HOST:-'Not set (should be 10.7.3.21)'}"
echo "   IB_FORMAT_DATE (Request Format): ${IB_FORMAT_DATE:-'Not set (should be 2 for Unix timestamps)'}"
echo "   EXPECTED_TIMESTAMP_FORMAT: ${EXPECTED_TIMESTAMP_FORMAT:-'Not set'}"
echo ""

# Check trading app server timezone
echo "🌍 Trading App Server Timezone:"
echo "   App server timezone: $(date +%Z)"
echo "   Current UTC time: $(date -u)"
echo "   Note: IB Gateway timezone is configured on remote server (10.7.3.21)"
echo ""

# Test trading app API endpoints
API_BASE="${NEXT_PUBLIC_API_URL:-http://localhost:4000}"
IB_SERVICE_BASE="${IB_SERVICE_URL:-http://localhost:8000}"

echo "📡 Testing Trading App APIs (Remote IB Gateway Data):"
echo ""

# Test main backend endpoint (frontend → backend → IB service → remote IB Gateway)
test_timestamp_format "$API_BASE/api/market-data/history?symbol=MSFT&timeframe=1hour&period=1D" "Main Trading App API (Full Chain)"

# Test IB service directly (IB service → remote IB Gateway)
test_timestamp_format "$IB_SERVICE_BASE/market-data/history?symbol=MSFT&timeframe=1hour&period=1D" "IB Service Direct API"

# Test timezone configuration endpoint
echo "🔧 Testing Configuration Endpoint:"
echo "📡 Endpoint: $IB_SERVICE_BASE/timezone-info"
config_response=$(curl -s "$IB_SERVICE_BASE/timezone-info" 2>/dev/null)
if [ $? -eq 0 ] && [ -n "$config_response" ]; then
    echo "✅ Configuration endpoint accessible"
    echo "📊 Configuration details:"
    echo "$config_response" | grep -E '"(timezone_properly_set|ib_format_configured|timestamp_format_correct)"' 2>/dev/null || echo "   Check full response for details"
else
    echo "❌ Configuration endpoint not accessible"
fi
echo ""

# Debug guidance for remote architecture
echo "🔍 Debug Information:"
echo "   Frontend: Check browser console for timestamp processing logs"
echo "   Trading App: Check IB service logs: './tradingapp.sh logs ib_service'"
echo "   Remote IB Gateway: Check logs on IB Gateway server (10.7.3.21)"
echo "   Configuration: Use /timezone-info endpoint for environment verification"
echo ""

# Current timestamp for reference
current_timestamp=$(date +%s)
echo "📝 Reference Timestamps:"
echo "   Current Unix timestamp (seconds): $current_timestamp"
echo "   Current Unix timestamp (milliseconds): $((current_timestamp * 1000))"
echo "   Current date: $(date -u)"
echo ""

echo "=== Verification Complete ==="
echo ""
echo "💡 Expected Results (Remote IB Gateway → Trading App):"
echo "   ✅ Timestamps should be Unix seconds (10 digits, ~1722000000 range for 2024-2025)"
echo "   ✅ Dates should show 2024-2025 years, not 57554 or other incorrect years"
echo "   ✅ All timestamps should be in UTC timezone"
echo "   ✅ Both API endpoints should return consistent timestamp formats"
echo ""
echo "🚨 If timestamps are still wrong:"
echo "   1. Trading App Side:"
echo "      - Verify IB_FORMAT_DATE=2 in .env file"
echo "      - Check TZ=UTC in docker containers"
echo "      - Restart trading app: './tradingapp.sh restart'"
echo "      - Check IB service logs: './tradingapp.sh logs ib_service'"
echo ""
echo "   2. Remote IB Gateway Side (10.7.3.21):"
echo "      - Verify IB Gateway timezone is set to UTC (you configured this)"
echo "      - Check IB Gateway API format settings"
echo "      - Restart IB Gateway if needed (on remote server)"
echo ""
echo "   3. Test Individual Components:"
echo "      - Test IB service: curl 'http://localhost:8000/timezone-info'"
echo "      - Test backend: curl 'http://localhost:4000/api/market-data/history?symbol=MSFT&timeframe=1hour&period=1D'"
echo "      - Check browser console logs for frontend timestamp processing"