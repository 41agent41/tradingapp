#!/bin/bash
# ==============================================
# Timestamp Configuration Verification Script
# Tests IB Gateway timezone and timestamp configuration
# ==============================================

echo "=== IB Gateway Timestamp Configuration Verification ==="
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

# Check environment variables
echo "🔧 Environment Configuration:"
echo "   TZ: ${TZ:-'Not set'}"
echo "   IB_TIMEZONE: ${IB_TIMEZONE:-'Not set'}"
echo "   EXPECTED_TIMESTAMP_FORMAT: ${EXPECTED_TIMESTAMP_FORMAT:-'Not set'}"
echo "   IB_FORMAT_DATE: ${IB_FORMAT_DATE:-'Not set'}"
echo ""

# Check system timezone
echo "🌍 System Timezone Information:"
if command -v timedatectl >/dev/null 2>&1; then
    echo "   System timezone: $(timedatectl show --property=Timezone --value)"
else
    echo "   System timezone: $(date +%Z)"
fi
echo "   Current UTC time: $(date -u)"
echo "   Current local time: $(date)"
echo ""

# Test API endpoints
API_BASE="${NEXT_PUBLIC_API_URL:-http://localhost:4000}"
IB_SERVICE_BASE="${IB_SERVICE_URL:-http://localhost:8000}"

echo "📡 Testing API Endpoints:"
echo ""

# Test backend endpoint
test_timestamp_format "$API_BASE/api/market-data/history?symbol=MSFT&timeframe=1hour&period=1D" "Backend Historical Data API"

# Test IB service directly
test_timestamp_format "$IB_SERVICE_BASE/market-data/history?symbol=MSFT&timeframe=1hour&period=1D" "IB Service Direct API"

# Test with debug logging
echo "🔍 Debug Information:"
echo "   Check browser console for detailed timestamp logs"
echo "   Check IB service logs for timestamp processing details"
echo "   Check IB Gateway logs for request format confirmation"
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
echo "💡 Expected Results:"
echo "   ✅ Timestamps should be Unix seconds (10 digits, ~1722000000 range for 2024)"
echo "   ✅ Dates should show 2024-2025 years, not 57554"
echo "   ✅ All timestamps should be in UTC timezone"
echo ""
echo "🚨 If timestamps are wrong:"
echo "   1. Check IB Gateway timezone settings (should be UTC)"
echo "   2. Verify IB_FORMAT_DATE=2 in environment"
echo "   3. Restart IB Gateway and application containers"
echo "   4. Check IB Gateway logs for format confirmation"