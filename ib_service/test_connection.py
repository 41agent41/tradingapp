#!/usr/bin/env python3
"""
Simple connection test script that can run without ib_insync locally
"""

import socket
import time
import sys
import os

def test_tcp_connection(host, port, timeout=10):
    """Test basic TCP connectivity to IB Gateway"""
    print(f"Testing TCP connection to {host}:{port}...")
    
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        
        start_time = time.time()
        result = sock.connect_ex((host, port))
        end_time = time.time()
        
        sock.close()
        
        if result == 0:
            print(f"✅ TCP connection successful! Time: {end_time - start_time:.2f}s")
            return True
        else:
            print(f"❌ TCP connection failed with error code: {result}")
            return False
            
    except Exception as e:
        print(f"❌ TCP connection error: {e}")
        return False

def test_ib_service_endpoint():
    """Test IB Service endpoint"""
    import requests
    
    try:
        print("Testing IB Service endpoint...")
        response = requests.get("http://localhost:8000/health", timeout=5)
        
        if response.status_code == 200:
            print("✅ IB Service is responding")
            data = response.json()
            print(f"   Status: {data.get('status', 'unknown')}")
            print(f"   Services: {data.get('services', {})}")
            return True
        else:
            print(f"❌ IB Service returned status code: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ IB Service test failed: {e}")
        return False

def test_ib_gateway_config():
    """Test IB Gateway configuration"""
    print("Testing IB Gateway configuration...")
    
    # Check environment variables
    ib_host = os.environ.get('IB_HOST', 'localhost')
    ib_port = int(os.environ.get('IB_PORT', '4002'))
    
    print(f"   IB_HOST: {ib_host}")
    print(f"   IB_PORT: {ib_port}")
    
    # Test connectivity
    if test_tcp_connection(ib_host, ib_port):
        print("✅ IB Gateway appears to be accessible")
        return True
    else:
        print("❌ IB Gateway is not accessible")
        return False

def main():
    """Main test function"""
    print("🔍 IB Gateway Connection Test")
    print("=" * 40)
    
    # Test 1: Basic TCP connectivity
    ib_host = os.environ.get('IB_HOST', 'localhost')
    ib_port = int(os.environ.get('IB_PORT', '4002'))
    
    tcp_success = test_tcp_connection(ib_host, ib_port)
    
    # Test 2: IB Service endpoint (if available)
    try:
        import requests
        service_success = test_ib_service_endpoint()
    except ImportError:
        print("⚠️  requests module not available, skipping IB Service test")
        service_success = False
    
    # Test 3: Configuration
    config_success = test_ib_gateway_config()
    
    print("\n" + "=" * 40)
    print("📊 Test Results Summary:")
    print(f"   TCP Connection: {'✅ PASS' if tcp_success else '❌ FAIL'}")
    print(f"   IB Service: {'✅ PASS' if service_success else '❌ FAIL'}")
    print(f"   Configuration: {'✅ PASS' if config_success else '❌ FAIL'}")
    
    if tcp_success:
        print("\n✅ Basic connectivity to IB Gateway is working!")
        print("   The issue may be with IB Gateway API settings or client ID conflicts.")
    else:
        print("\n❌ Cannot connect to IB Gateway!")
        print("   Please check:")
        print("   1. IB Gateway is running")
        print("   2. Socket port is set to 4002")
        print("   3. API connections are enabled for paper trading")
        print("   4. Trusted IPs include your server IP")
    
    return 0 if tcp_success else 1

if __name__ == "__main__":
    sys.exit(main()) 