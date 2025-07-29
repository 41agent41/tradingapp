'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import DataSwitch from '../components/DataSwitch';

interface ConnectionStatus {
  connected: boolean;
  host: string;
  port: number;
  client_id: number;
  last_connected?: string;
  last_error?: string;
  connection_count: number;
}

interface AccountInfo {
  account_id: string;
  net_liquidation?: number;
  total_cash_value?: number;
  buying_power?: number;
  maintenance_margin?: number;
  currency: string;
  last_updated: string;
}

interface Position {
  symbol: string;
  position: number;
  market_price?: number;
  market_value?: number;
  average_cost?: number;
  unrealized_pnl?: number;
  currency: string;
}

interface Order {
  order_id: number;
  symbol: string;
  action: string;
  quantity: number;
  order_type: string;
  status: string;
  filled_quantity?: number;
  remaining_quantity?: number;
  avg_fill_price?: number;
}

interface AccountData {
  account: AccountInfo;
  positions: Position[];
  orders: Order[];
  last_updated: string;
}

export default function AccountPage() {
  const [activeTab, setActiveTab] = useState('account');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [nextAutoRefresh, setNextAutoRefresh] = useState<Date | null>(null);
  
  // Data switch state
  const [dataQueryEnabled, setDataQueryEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('account-data-enabled');
      return saved !== null ? JSON.parse(saved) : false;
    }
    return false;
  });

  // Create a ref to store the latest fetchAccountData function
  const fetchAccountDataRef = useRef<((isManualRefresh?: boolean) => Promise<void>) | null>(null);

  // Handle data switch toggle with persistence
  const handleDataSwitchToggle = (enabled: boolean) => {
    setDataQueryEnabled(enabled);
    if (typeof window !== 'undefined') {
      localStorage.setItem('account-data-enabled', JSON.stringify(enabled));
    }
    
    // Clear any errors when disabling
    if (!enabled) {
      setError(null);
    }
  };

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    console.error('NEXT_PUBLIC_API_URL is not configured');
    return <div>Configuration error: API URL not set</div>;
  }

  // Fetch connection status (independent of account data) - only when needed
  const fetchConnectionStatus = useCallback(async () => {
    try {
      const connectionRes = await fetch(`${apiUrl}/api/account/connection`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (connectionRes.ok) {
        const connectionData = await connectionRes.json();
        setConnectionStatus(connectionData);
      } else {
        console.warn('Could not fetch connection status');
      }
    } catch (err) {
      console.warn('Connection status check failed:', err);
      setConnectionStatus(null);
    }
  }, [apiUrl]);

  // Manual connection status check function
  const handleConnectionCheck = () => {
    fetchConnectionStatus();
  };

  // Fetch all account data (separate from connection check)
  const fetchAccountData = useCallback(async (isManualRefresh = false) => {
    if (!dataQueryEnabled) {
      console.log('Account data fetching is disabled');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    
    if (isManualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    
    try {
      console.log('Fetching all account data...');
      
      const accountRes = await fetch(`${apiUrl}/api/account/all`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'X-Data-Query-Enabled': dataQueryEnabled.toString()
        },
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (accountRes.ok) {
        const data: AccountData = await accountRes.json();
        setAccountData(data);
        setLastRefresh(new Date());
        
        // Set next auto refresh time (1 hour from now)
        const nextRefresh = new Date();
        nextRefresh.setHours(nextRefresh.getHours() + 1);
        setNextAutoRefresh(nextRefresh);
        
        console.log('Successfully loaded account data');
      } else {
        const errorData = await accountRes.json();
        throw new Error(errorData.detail || `HTTP ${accountRes.status}: ${accountRes.statusText}`);
      }
    } catch (err) {
      console.error('Error fetching account data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch account data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiUrl, dataQueryEnabled]);

  // Keep the ref updated with the latest function
  useEffect(() => {
    fetchAccountDataRef.current = fetchAccountData;
  }, [fetchAccountData]);

  // Manual refresh function
  const handleManualRefresh = () => {
    if (dataQueryEnabled) {
      console.log('🔄 Manual refresh triggered by user');
      fetchAccountData(true);
    } else {
      console.log('Manual refresh blocked - data querying is disabled');
    }
  };

  // Initial load - only fetch account data once, no automatic polling
  useEffect(() => {
    console.log('📊 Initial account data load (one-time only)');
    // Only fetch account data, which respects data switch setting
    // Connection status will be checked manually when needed
    fetchAccountData(); // Respects data switch setting
  }, [fetchAccountData]);

  // Set up hourly auto-refresh - only when data query is enabled
  useEffect(() => {
    if (!dataQueryEnabled) {
      console.log('Auto-refresh disabled - data querying is off');
      return;
    }

    console.log('Setting up hourly auto-refresh for account data (60 minutes)');
    
    // Create a stable function that uses the ref to call the latest function
    const intervalFunction = () => {
      console.log('🕐 Auto-refreshing account data (hourly interval)');
      if (fetchAccountDataRef.current) {
        fetchAccountDataRef.current();
      }
    };
    
    const interval = setInterval(intervalFunction, 60 * 60 * 1000); // 1 hour in milliseconds (60 minutes)

    return () => {
      console.log('Clearing hourly auto-refresh interval');
      clearInterval(interval);
    };
  }, [dataQueryEnabled]); // Only depend on dataQueryEnabled, not fetchAccountData

  // Helper functions
  const formatTime = (date: Date) => {
    return date.toLocaleString('en-US', { 
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  };

  const formatCurrency = (value?: number, currency = 'AUD') => {
    if (value === undefined || value === null) return 'N/A';
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const renderAccountTab = () => (
    <div className="space-y-6">
      {/* Data Switch */}
      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <DataSwitch
          enabled={dataQueryEnabled}
          onToggle={handleDataSwitchToggle}
          label="IB Gateway Account Data Query"
          description="Enable or disable account data fetching from IB Gateway (account, positions, orders)"
          size="medium"
        />
      </div>

      {/* Account Summary Header */}
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Account Summary (Basic)</h3>
          <div className="flex items-center gap-4">
            <button
              onClick={handleManualRefresh}
              disabled={refreshing || loading || !dataQueryEnabled}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 flex items-center gap-2"
            >
              {refreshing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Refreshing...
                </>
              ) : (
                <>
                  <span>🔄</span>
                  Refresh Now
                </>
              )}
            </button>
            
            {!dataQueryEnabled && (
              <div className="px-3 py-1 bg-amber-100 text-amber-800 text-sm rounded border border-amber-200">
                Data querying disabled
              </div>
            )}
          </div>
        </div>

        {/* Refresh Status */}
        <div className="text-sm text-gray-600 mb-4">
          {lastRefresh && (
            <div>Last updated: {formatTime(lastRefresh)}</div>
          )}
          {nextAutoRefresh && dataQueryEnabled && (
            <div>Next auto-refresh: {formatTime(nextAutoRefresh)} (60 minutes)</div>
          )}
          {!dataQueryEnabled && (
            <div className="text-amber-600">Auto-refresh disabled - data querying is off</div>
          )}
        </div>

        {/* Account Summary Content - Basic Required Fields Only */}
        {!dataQueryEnabled ? (
          <div className="text-center py-8">
            <div className="text-gray-600 mb-2">⚠️ Data querying is disabled</div>
            <p className="text-sm text-gray-500">Enable data querying above to fetch account information from IB Gateway</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="ml-3 text-gray-600">Loading account data...</span>
          </div>
        ) : error ? (
          <div className="text-red-600 bg-red-50 p-4 rounded border border-red-200">
            <div className="flex items-center">
              <span className="mr-2">❌</span>
              <span>Error: {error}</span>
            </div>
            <button
              onClick={handleManualRefresh}
              className="mt-2 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        ) : accountData ? (
          <div>
            <div className="mb-4 text-sm text-gray-600">
              ℹ️ Showing basic required fields only for optimal performance
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-50 p-4 rounded">
                <span className="text-sm text-gray-600">Account ID</span>
                <div className="text-lg font-semibold">{accountData.account.account_id}</div>
              </div>
              <div className="bg-gray-50 p-4 rounded">
                <span className="text-sm text-gray-600">Currency</span>
                <div className="text-lg font-semibold">{accountData.account.currency}</div>
              </div>
              <div className="bg-blue-50 p-4 rounded">
                <span className="text-sm text-blue-600">Net Liquidation</span>
                <div className="text-xl font-bold text-blue-700">
                  {formatCurrency(accountData.account.net_liquidation, accountData.account.currency)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-gray-600">No account data available</div>
        )}
      </div>
    </div>
  );

  const renderPositionsTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Current Positions</h3>
          <div className="text-sm text-gray-600">
            {accountData?.positions?.length || 0} positions
          </div>
        </div>
        
        {!dataQueryEnabled ? (
          <div className="text-center py-8">
            <div className="text-gray-600 mb-2">⚠️ Data querying is disabled</div>
            <p className="text-sm text-gray-500">Enable data querying to fetch positions from IB Gateway</p>
          </div>
        ) : !connectionStatus?.connected ? (
          <div className="text-amber-600">Please connect to IB Gateway to view positions</div>
        ) : !accountData?.positions || accountData.positions.length === 0 ? (
          <div className="text-gray-600">No positions found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-3">Symbol</th>
                  <th className="text-right p-3">Position</th>
                  <th className="text-right p-3">Market Price</th>
                  <th className="text-right p-3">Market Value</th>
                  <th className="text-right p-3">Avg Cost</th>
                  <th className="text-right p-3">Unrealized P&L</th>
                  <th className="text-center p-3">Currency</th>
                </tr>
              </thead>
              <tbody>
                {accountData.positions.map((position, index) => (
                  <tr key={index} className="border-b hover:bg-gray-50">
                    <td className="p-3 font-semibold">{position.symbol}</td>
                    <td className="p-3 text-right">{position.position}</td>
                    <td className="p-3 text-right">
                      {position.market_price ? formatCurrency(position.market_price, position.currency) : 'N/A'}
                    </td>
                    <td className="p-3 text-right">
                      {position.market_value ? formatCurrency(position.market_value, position.currency) : 'N/A'}
                    </td>
                    <td className="p-3 text-right">
                      {position.average_cost ? formatCurrency(position.average_cost, position.currency) : 'N/A'}
                    </td>
                    <td className={`p-3 text-right font-semibold ${
                      (position.unrealized_pnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {position.unrealized_pnl ? formatCurrency(position.unrealized_pnl, position.currency) : 'N/A'}
                    </td>
                    <td className="p-3 text-center">{position.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  const renderOrdersTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Active Orders</h3>
          <div className="text-sm text-gray-600">
            {accountData?.orders?.length || 0} orders
          </div>
        </div>
        
        {!dataQueryEnabled ? (
          <div className="text-center py-8">
            <div className="text-gray-600 mb-2">⚠️ Data querying is disabled</div>
            <p className="text-sm text-gray-500">Enable data querying to fetch orders from IB Gateway</p>
          </div>
        ) : !connectionStatus?.connected ? (
          <div className="text-amber-600">Please connect to IB Gateway to view orders</div>
        ) : !accountData?.orders || accountData.orders.length === 0 ? (
          <div className="text-gray-600">No active orders found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-3">Order ID</th>
                  <th className="text-left p-3">Symbol</th>
                  <th className="text-center p-3">Action</th>
                  <th className="text-right p-3">Quantity</th>
                  <th className="text-center p-3">Type</th>
                  <th className="text-center p-3">Status</th>
                  <th className="text-right p-3">Filled</th>
                  <th className="text-right p-3">Avg Fill Price</th>
                </tr>
              </thead>
              <tbody>
                {accountData.orders.map((order, index) => (
                  <tr key={index} className="border-b hover:bg-gray-50">
                    <td className="p-3 font-mono">{order.order_id}</td>
                    <td className="p-3 font-semibold">{order.symbol}</td>
                    <td className={`p-3 text-center font-semibold ${
                      order.action === 'BUY' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {order.action}
                    </td>
                    <td className="p-3 text-right">{order.quantity}</td>
                    <td className="p-3 text-center">{order.order_type}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-1 rounded text-xs ${
                        order.status === 'Filled' ? 'bg-green-100 text-green-800' :
                        order.status === 'Cancelled' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">{order.filled_quantity || 0}</td>
                    <td className="p-3 text-right">
                      {order.avg_fill_price ? `$${order.avg_fill_price.toFixed(2)}` : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  const renderConnectionTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">IB Gateway Connection</h3>
        
        {connectionStatus && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={`w-4 h-4 rounded-full ${connectionStatus.connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="font-medium text-lg">
                {connectionStatus.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="bg-gray-50 p-3 rounded">
                <span className="text-gray-600">Host:</span>
                <span className="ml-2 font-mono">{connectionStatus.host}</span>
              </div>
              <div className="bg-gray-50 p-3 rounded">
                <span className="text-gray-600">Port:</span>
                <span className="ml-2 font-mono">{connectionStatus.port}</span>
              </div>
              <div className="bg-gray-50 p-3 rounded">
                <span className="text-gray-600">Client ID:</span>
                <span className="ml-2 font-mono">{connectionStatus.client_id}</span>
              </div>
              <div className="bg-gray-50 p-3 rounded">
                <span className="text-gray-600">Connections:</span>
                <span className="ml-2 font-mono">{connectionStatus.connection_count}</span>
              </div>
            </div>

            {connectionStatus.last_connected && (
              <div className="bg-green-50 p-3 rounded border border-green-200">
                <span className="text-green-700 text-sm">
                  Last connected: {new Date(connectionStatus.last_connected).toLocaleString()}
                </span>
              </div>
            )}

            {connectionStatus.last_error && (
              <div className="bg-red-50 p-3 rounded border border-red-200">
                <span className="text-red-700 text-sm">{connectionStatus.last_error}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 space-y-3">
          <button
            onClick={handleConnectionCheck}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Check Connection Status
          </button>
          <div className="text-sm text-gray-600">
            💡 Connection status is now checked manually to prevent automatic IB Gateway queries
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Account Dashboard</h1>
          <p className="text-gray-600 mt-2">
            Monitor your IB Gateway account information with automatic hourly updates (60 minutes)
          </p>
          <div className="mt-2 text-sm text-blue-600 bg-blue-50 p-3 rounded border border-blue-200">
            💡 <strong>Refresh Schedule:</strong> Data refreshes automatically every 60 minutes or manually via "Refresh Now" button. 
            No frequent polling to minimize IB Gateway API calls.
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mb-6">
          <nav className="flex space-x-1 bg-gray-200 rounded-lg p-1">
            {[
              { id: 'account', label: 'Account Summary', icon: '💰' },
              { id: 'positions', label: 'Positions', icon: '📊' },
              { id: 'orders', label: 'Orders', icon: '📋' },
              { id: 'connection', label: 'Connection', icon: '🔗' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div>
          {activeTab === 'account' && renderAccountTab()}
          {activeTab === 'positions' && renderPositionsTab()}
          {activeTab === 'orders' && renderOrdersTab()}
          {activeTab === 'connection' && renderConnectionTab()}
        </div>
      </div>
    </div>
  );
} 