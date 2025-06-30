'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import TradingChart from './components/TradingChart';

interface AccountInfo {
  account_number: string;
  account_type: string;
  net_liquidation: number;
  total_cash: number;
  settled_cash: number;
  buying_power: number;
  excess_liquidity: number;
  day_trades_remaining: number;
  currency: string;
  last_updated: number;
}

interface Position {
  symbol: string;
  secType: string;
  exchange: string;
  currency: string;
  account: string;
  position: number;
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPNL: number;
  realizedPNL: number;
}

interface Order {
  orderId: number;
  symbol: string;
  secType: string;
  action: string;
  orderType: string;
  totalQuantity: number;
  lmtPrice: number;
  auxPrice: number;
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice: number;
}

interface AccountData {
  account?: {
    status?: string;
    account_info?: AccountInfo;
    error?: string;
  };
  positions?: {
    status?: string;
    positions?: Position[];
    total_positions?: number;
    error?: string;
  };
  orders?: {
    status?: string;
    orders?: Order[];
    total_orders?: number;
    error?: string;
  };
  timestamp?: string;
  error?: string;
}

export default function HomePage() {
  const [accountData, setAccountData] = useState<AccountData>({});
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [ibStatus, setIbStatus] = useState<any>(null);
  const [showDebug, setShowDebug] = useState(true); // Start with debug visible for testing
  const [testCounter, setTestCounter] = useState(0);

  useEffect(() => {
    // Use the backend URL from environment or default to localhost
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const newSocket = io(backendUrl);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setConnectionStatus('Connected');
      console.log('Connected to backend');
    });

    newSocket.on('disconnect', () => {
      setConnectionStatus('Disconnected');
      console.log('Disconnected from backend');
    });

    newSocket.on('accountData', (data: AccountData) => {
      setAccountData(data);
      console.log('Received account data:', data);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  const formatCurrency = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  const formatNumber = (num: number, decimals: number = 2) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(num);
  };

  const checkIBStatus = async () => {
    try {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const response = await fetch(`${backendUrl}/api/ib-status`);
      const data = await response.json();
      setIbStatus(data);
    } catch (error) {
      setIbStatus({ error: 'Failed to check IB status' });
    }
  };

  const connectToIB = async () => {
    try {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const response = await fetch(`${backendUrl}/api/ib-connect`, { method: 'POST' });
      const data = await response.json();
      setIbStatus(data);
      // Refresh status after attempting connection
      setTimeout(checkIBStatus, 1000);
    } catch (error) {
      setIbStatus({ error: 'Failed to connect to IB' });
    }
  };

  const handleDebugToggle = () => {
    console.log('Debug button clicked, current showDebug:', showDebug);
    setShowDebug(!showDebug);
    console.log('Debug button clicked, new showDebug:', !showDebug);
  };

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900">TradingApp</h1>
          <div className="flex items-center space-x-4">
            <div className={`px-3 py-1 rounded-full text-sm font-medium ${
              connectionStatus === 'Connected' ? 'bg-green-100 text-green-800' : 
              connectionStatus === 'Connecting...' ? 'bg-yellow-100 text-yellow-800' :
              'bg-red-100 text-red-800'
            }`}>
              {connectionStatus}
            </div>
            <Link 
              href="/settings" 
              className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
            >
              Settings
            </Link>
          </div>
        </div>

        {accountData.error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
            Error: {accountData.error}
          </div>
        )}

        {/* Trading Chart */}
        <div className="mb-6">
          <TradingChart 
            symbol="MSFT" 
            onTimeframeChange={(timeframe) => console.log('Timeframe changed:', timeframe)}
          />
        </div>

        {/* Debug Panel */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-gray-900">Connection Debug</h2>
            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-500">Debug: {showDebug ? 'ON' : 'OFF'}</span>
              <span className="text-xs text-gray-500">Counter: {testCounter}</span>
              <button
                onClick={() => setTestCounter(testCounter + 1)}
                className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-1 px-2 rounded text-xs"
              >
                Test +1
              </button>
              <button
                onClick={handleDebugToggle}
                className="bg-gray-500 hover:bg-gray-700 text-white font-bold py-1 px-3 rounded text-sm"
              >
                {showDebug ? 'Hide' : 'Show'} Debug
              </button>
            </div>
          </div>
          
          {showDebug && (
            <div className="space-y-4">
              <div className="flex space-x-2">
                <button
                  onClick={checkIBStatus}
                  className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
                >
                  Check IB Status
                </button>
                <button
                  onClick={connectToIB}
                  className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
                >
                  Connect to IB Gateway
                </button>
              </div>
              
              {ibStatus && (
                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-semibold mb-2">IB Service Status:</h3>
                  <pre className="text-sm overflow-auto">{JSON.stringify(ibStatus, null, 2)}</pre>
                </div>
              )}
              
              {accountData.account?.error && (
                <div className="bg-red-50 p-4 rounded-lg">
                  <h3 className="font-semibold mb-2 text-red-800">Account Data Error Details:</h3>
                  <div className="text-sm text-red-700">
                    {typeof accountData.account === 'object' && 'detail' in accountData.account ? (
                      <div>
                        <p><strong>Error:</strong> {accountData.account.error}</p>
                        <p><strong>Detail:</strong> {(accountData.account as any).detail}</p>
                        <p><strong>Status:</strong> {(accountData.account as any).ib_service_status}</p>
                        <p><strong>URL:</strong> {(accountData.account as any).ib_service_url}</p>
                      </div>
                    ) : (
                      <p>{accountData.account.error}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Account Information */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Account Information</h2>
          {accountData.account?.error ? (
            <div className="text-red-600">Error: {accountData.account.error}</div>
          ) : accountData.account?.account_info ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-blue-600">Account Number</h3>
                <p className="text-2xl font-bold text-blue-900">{accountData.account.account_info.account_number}</p>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-green-600">Net Liquidation</h3>
                <p className="text-2xl font-bold text-green-900">
                  {formatCurrency(accountData.account.account_info.net_liquidation, accountData.account.account_info.currency)}
                </p>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-purple-600">Buying Power</h3>
                <p className="text-2xl font-bold text-purple-900">
                  {formatCurrency(accountData.account.account_info.buying_power, accountData.account.account_info.currency)}
                </p>
              </div>
              <div className="bg-orange-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-orange-600">Available Cash</h3>
                <p className="text-2xl font-bold text-orange-900">
                  {formatCurrency(accountData.account.account_info.total_cash, accountData.account.account_info.currency)}
                </p>
              </div>
              <div className="bg-indigo-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-indigo-600">Account Type</h3>
                <p className="text-lg font-semibold text-indigo-900">{accountData.account.account_info.account_type}</p>
              </div>
              <div className="bg-pink-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-pink-600">Day Trades Remaining</h3>
                <p className="text-2xl font-bold text-pink-900">{accountData.account.account_info.day_trades_remaining}</p>
              </div>
              <div className="bg-yellow-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-yellow-600">Excess Liquidity</h3>
                <p className="text-2xl font-bold text-yellow-900">
                  {formatCurrency(accountData.account.account_info.excess_liquidity, accountData.account.account_info.currency)}
                </p>
              </div>
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="text-sm font-medium text-gray-600">Settled Cash</h3>
                <p className="text-2xl font-bold text-gray-900">
                  {formatCurrency(accountData.account.account_info.settled_cash, accountData.account.account_info.currency)}
                </p>
              </div>
            </div>
          ) : (
            <div className="text-gray-500">Loading account information...</div>
          )}
        </div>

        {/* Positions */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Positions 
            {accountData.positions?.total_positions !== undefined && (
              <span className="text-lg font-normal text-gray-600">
                ({accountData.positions.total_positions})
              </span>
            )}
          </h2>
          {accountData.positions?.error ? (
            <div className="text-red-600">Error: {accountData.positions.error}</div>
          ) : accountData.positions?.positions && accountData.positions.positions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Position</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Cost</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Market Value</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {accountData.positions.positions.map((position, index) => (
                    <tr key={index}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{position.symbol}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(position.position)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatCurrency(position.avgCost, position.currency)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatCurrency(position.marketValue, position.currency)}</td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${position.unrealizedPNL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(position.unrealizedPNL, position.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-gray-500">No positions or loading...</div>
          )}
        </div>

        {/* Orders */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Orders 
            {accountData.orders?.total_orders !== undefined && (
              <span className="text-lg font-normal text-gray-600">
                ({accountData.orders.total_orders})
              </span>
            )}
          </h2>
          {accountData.orders?.error ? (
            <div className="text-red-600">Error: {accountData.orders.error}</div>
          ) : accountData.orders?.orders && accountData.orders.orders.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {accountData.orders.orders.map((order, index) => (
                    <tr key={index}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{order.orderId}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{order.symbol}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          order.action === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {order.action}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(order.totalQuantity, 0)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {order.lmtPrice > 0 ? formatCurrency(order.lmtPrice) : 'Market'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
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
          ) : (
            <div className="text-gray-500">No orders or loading...</div>
          )}
        </div>

        {accountData.timestamp && (
          <div className="text-center text-sm text-gray-500 mt-4">
            Last updated: {new Date(accountData.timestamp).toLocaleString()}
          </div>
        )}
      </div>
    </main>
  );
} 