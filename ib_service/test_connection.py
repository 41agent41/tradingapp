#!/usr/bin/env python3
"""
Simple IB Gateway connection test script
"""

import os
import sys
import time
from ib_insync import IB

def test_ib_connection():
    """Test IB Gateway connection with detailed logging"""
    
    # Configuration
    host = os.environ.get('IB_HOST', '10.7.3.21')
    port = int(os.environ.get('IB_PORT', '4002'))
    client_id = int(os.environ.get('IB_CLIENT_ID', '999'))
    timeout = int(os.environ.get('IB_TIMEOUT', '60'))
    
    print(f"Testing connection to {host}:{port} with client ID {client_id}")
    print(f"Timeout: {timeout} seconds")
    
    # Create IB client
    ib = IB()
    
    try:
        print("Attempting connection...")
        start_time = time.time()
        
        # Connect
        ib.connect(
            host=host,
            port=port,
            clientId=client_id,
            timeout=timeout
        )
        
        end_time = time.time()
        connection_time = end_time - start_time
        
        print(f"Connection attempt completed in {connection_time:.2f} seconds")
        
        if ib.isConnected():
            print("✅ SUCCESS: Connected to IB Gateway!")
            print(f"Connection time: {connection_time:.2f} seconds")
            
            # Get some basic info
            try:
                print("Requesting account info...")
                accounts = ib.managedAccounts()
                print(f"Available accounts: {accounts}")
            except Exception as e:
                print(f"Warning: Could not get account info: {e}")
            
            return True
        else:
            print("❌ FAILED: Connection established but client reports not connected")
            return False
            
    except Exception as e:
        print(f"❌ FAILED: Connection error: {e}")
        return False
    finally:
        try:
            if ib.isConnected():
                ib.disconnect()
                print("Disconnected from IB Gateway")
        except:
            pass

if __name__ == "__main__":
    success = test_ib_connection()
    sys.exit(0 if success else 1) 