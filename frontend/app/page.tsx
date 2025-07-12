'use client';

import React from 'react';
import MarketDataFilter from './components/MarketDataFilter';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Trading App</h1>
              <p className="text-sm text-gray-600">Interactive Brokers Market Data</p>
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
        <div className="mb-8">
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            Market Data Search & Filter
          </h2>
          <p className="text-gray-600">
            Search for stocks, options, futures, and other financial instruments using Interactive Brokers data.
          </p>
        </div>

        {/* Market Data Filter Component */}
        <MarketDataFilter />
      </main>
    </div>
  );
} 