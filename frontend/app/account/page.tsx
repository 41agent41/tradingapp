'use client';
import React, { useEffect, useState } from 'react';

interface ConnectionStatus {
  connected: boolean;
  host: string;
  port: number;
  client_id: number;
  last_error?: string;
}

interface AccountInfo {
  account_id: string;
  net_liquidation: string;
  total_cash_value: string;
  buying_power: string;
  maintenance_margin: string;
  currency: string;
}

interface Position {
  symbol: string;
  position: number;
  market_price: number;
  market_value: number;
  average_cost: number;
  unrealized_pnl: number;
}

interface Order {
  perm_id: number;
  client_id: number;
  order_id: number;
  symbol: string;
  action: string;
  order_type: string;
  total_quantity: number;
  status: string;
}

export default function AccountPage() {
  const [activeTab, setActiveTab] = useState('connection');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  // Fetch all data
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Fetch settings
      const settingsRes = await fetch(`${apiUrl}/api/settings`);
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setSettings(settingsData);
      }

      // Fetch connection status
      const connectionRes = await fetch(`${apiUrl}/api/ib/connection`);
      if (connectionRes.ok) {
        const connectionData = await connectionRes.json();
        setConnectionStatus(connectionData);
      }

      // If connected, fetch account data
      if (connectionStatus?.connected) {
        try {
          const accountRes = await fetch(`${apiUrl}/api/ib/account`);
          if (accountRes.ok) {
            const accountData = await accountRes.json();
            setAccountInfo(accountData);
          }

          const positionsRes = await fetch(`${apiUrl}/api/ib/positions`);
          if (positionsRes.ok) {
            const positionsData = await positionsRes.json();
            setPositions(positionsData.positions || []);
          }

          const ordersRes = await fetch(`${apiUrl}/api/ib/orders`);
          if (ordersRes.ok) {
            const ordersData = await ordersRes.json();
            setOrders(ordersData.orders || []);
          }
        } catch (err) {
          console.warn('Some account data could not be fetched:', err);
        }
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [connectionStatus?.connected]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const response = await fetch(`${apiUrl}/api/ib/connect`, {
        method: 'POST',
      });
      
      if (response.ok) {
        await fetchData();
      } else {
        throw new Error('Connection failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/ib/disconnect`, {
        method: 'POST',
      });
      
      if (response.ok) {
        await fetchData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    }
  };

  const renderConnectionTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">IB Gateway Connection</h3>
        
        {connectionStatus && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${connectionStatus.connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="font-medium">
                {connectionStatus.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-600">Host:</span>
                <span className="ml-2 font-mono">{connectionStatus.host}</span>
              </div>
              <div>
                <span className="text-gray-600">Port:</span>
                <span className="ml-2 font-mono">{connectionStatus.port}</span>
              </div>
              <div>
                <span className="text-gray-600">Client ID:</span>
                <span className="ml-2 font-mono">{connectionStatus.client_id}</span>
              </div>
            </div>

            {connectionStatus.last_error && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded">
                <span className="text-red-700 text-sm">{connectionStatus.last_error}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={handleConnect}
            disabled={connecting || connectionStatus?.connected}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300"
          >
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
          <button
            onClick={handleDisconnect}
            disabled={!connectionStatus?.connected}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:bg-gray-300"
          >
            Disconnect
          </button>
          <button
            onClick={fetchData}
            className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );

  const renderSettingsTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Application Settings</h3>
        
        {Object.entries(settings).length === 0 ? (
          <div className="text-gray-600">No settings found</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(settings).map(([key, value]) => (
              <div key={key} className="flex flex-col">
                <label className="font-semibold text-sm text-gray-700 mb-1">{key}</label>
                <input
                  className="border border-gray-300 p-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={value}
                  readOnly
                  type={key.toLowerCase().includes('password') ? 'password' : 'text'}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderAccountTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Account Information</h3>
        
        {!connectionStatus?.connected ? (
          <div className="text-gray-600">Please connect to IB Gateway to view account information</div>
        ) : accountInfo ? (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-gray-600">Account ID:</span>
              <span className="ml-2 font-mono">{accountInfo.account_id}</span>
            </div>
            <div>
              <span className="text-gray-600">Currency:</span>
              <span className="ml-2 font-mono">{accountInfo.currency}</span>
            </div>
            <div>
              <span className="text-gray-600">Net Liquidation:</span>
              <span className="ml-2 font-mono">{accountInfo.net_liquidation}</span>
            </div>
            <div>
              <span className="text-gray-600">Cash Value:</span>
              <span className="ml-2 font-mono">{accountInfo.total_cash_value}</span>
            </div>
            <div>
              <span className="text-gray-600">Buying Power:</span>
              <span className="ml-2 font-mono">{accountInfo.buying_power}</span>
            </div>
            <div>
              <span className="text-gray-600">Maintenance Margin:</span>
              <span className="ml-2 font-mono">{accountInfo.maintenance_margin}</span>
            </div>
          </div>
        ) : (
          <div className="text-gray-600">Loading account information...</div>
        )}
      </div>
    </div>
  );

  const renderPositionsTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Current Positions</h3>
        
        {!connectionStatus?.connected ? (
          <div className="text-gray-600">Please connect to IB Gateway to view positions</div>
        ) : positions.length === 0 ? (
          <div className="text-gray-600">No positions found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Symbol</th>
                  <th className="text-right p-2">Position</th>
                  <th className="text-right p-2">Market Price</th>
                  <th className="text-right p-2">Market Value</th>
                  <th className="text-right p-2">Avg Cost</th>
                  <th className="text-right p-2">Unrealized P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position, index) => (
                  <tr key={index} className="border-b">
                    <td className="p-2 font-mono">{position.symbol}</td>
                    <td className="p-2 text-right">{position.position}</td>
                    <td className="p-2 text-right">{position.market_price.toFixed(2)}</td>
                    <td className="p-2 text-right">{position.market_value.toFixed(2)}</td>
                    <td className="p-2 text-right">{position.average_cost.toFixed(2)}</td>
                    <td className={`p-2 text-right ${position.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {position.unrealized_pnl.toFixed(2)}
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

  const renderOrdersTab = () => (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Orders</h3>
        
        {!connectionStatus?.connected ? (
          <div className="text-gray-600">Please connect to IB Gateway to view orders</div>
        ) : orders.length === 0 ? (
          <div className="text-gray-600">No orders found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Order ID</th>
                  <th className="text-left p-2">Symbol</th>
                  <th className="text-left p-2">Action</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-right p-2">Quantity</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, index) => (
                  <tr key={index} className="border-b">
                    <td className="p-2 font-mono">{order.order_id}</td>
                    <td className="p-2 font-mono">{order.symbol}</td>
                    <td className="p-2">{order.action}</td>
                    <td className="p-2">{order.order_type}</td>
                    <td className="p-2 text-right">{order.total_quantity}</td>
                    <td className="p-2">
                      <span className={`px-2 py-1 rounded text-xs ${
                        order.status === 'Filled' ? 'bg-green-100 text-green-800' :
                        order.status === 'Cancelled' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {order.status}
                      </span>
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

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold mb-4">Account Management</h1>
        <div className="text-blue-600">Loading...</div>
      </div>
    );
  }

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">Account Management</h1>
      
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="text-red-700">{error}</div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="flex space-x-8">
          {[
            { id: 'connection', label: 'Connection' },
            { id: 'account', label: 'Account Info' },
            { id: 'positions', label: 'Positions' },
            { id: 'orders', label: 'Orders' },
            { id: 'settings', label: 'Settings' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="min-h-96">
        {activeTab === 'connection' && renderConnectionTab()}
        {activeTab === 'settings' && renderSettingsTab()}
        {activeTab === 'account' && renderAccountTab()}
        {activeTab === 'positions' && renderPositionsTab()}
        {activeTab === 'orders' && renderOrdersTab()}
      </div>
    </main>
  );
} 