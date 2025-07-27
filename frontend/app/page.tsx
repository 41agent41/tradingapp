'use client';

import React from 'react';
import MarketDataFilter from './components/MarketDataFilter';
import TradingAccountSwitch from './components/TradingAccountSwitch';
import { useTradingAccount } from './contexts/TradingAccountContext';

export default function HomePage() {
  const { isLiveTrading, setIsLiveTrading } = useTradingAccount();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Trading App</h1>
              <p className="text-sm text-gray-600">Interactive Brokers Market Data & TradingView Charts</p>
            </div>
            <div className="flex items-center space-x-4">
              <div className="text-sm text-gray-500">
                Connected to IB Gateway
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Quick Access Links */}
        <div className="mb-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          <a 
            href="/msft" 
            className="block p-6 bg-white rounded-lg shadow-sm border hover:shadow-md transition-shadow"
          >
            <div className="flex items-center">
              <div className="text-2xl mr-3">📈</div>
              <div>
                <h3 className="text-lg font-medium text-gray-900">MSFT Real-time Chart</h3>
                <p className="text-sm text-gray-600">Live Microsoft stock data with TradingView charts</p>
              </div>
            </div>
          </a>
          
          <a 
            href="/account" 
            className="block p-6 bg-white rounded-lg shadow-sm border hover:shadow-md transition-shadow"
          >
            <div className="flex items-center">
              <div className="text-2xl mr-3">👤</div>
              <div>
                <h3 className="text-lg font-medium text-gray-900">Account Settings</h3>
                <p className="text-sm text-gray-600">Manage your trading account preferences</p>
              </div>
            </div>
          </a>
          
          <div className="p-6 bg-gray-100 rounded-lg shadow-sm border">
            <div className="flex items-center">
              <div className="text-2xl mr-3">🔧</div>
              <div>
                <h3 className="text-lg font-medium text-gray-700">More Charts</h3>
                <p className="text-sm text-gray-500">Additional timeframes coming soon</p>
              </div>
            </div>
          </div>
        </div>

        {/* Market Data Search Section */}
        <div className="mb-8">
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            Market Data Search & Filter
          </h2>
          <p className="text-gray-600 mb-4">
            Search for stocks, options, futures, and other financial instruments using Interactive Brokers data.
          </p>
          
          {/* Market Data Filter Component */}
          <MarketDataFilter />
        </div>

        {/* Trading Account Mode Section */}
        <div className="mb-8">
          <TradingAccountSwitch
            isLiveTrading={isLiveTrading}
            onToggle={setIsLiveTrading}
          />
        </div>
      </main>
    </div>
  );
} 