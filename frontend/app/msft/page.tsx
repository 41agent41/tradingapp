'use client';

import React from 'react';
import MSFTRealtimeChart from '../components/MSFTRealtimeChart';

export default function MSFTPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">MSFT Real-time Chart</h1>
              <p className="text-sm text-gray-600">Microsoft Corporation - Live Market Data</p>
            </div>
            <div className="flex items-center space-x-4">
              <a 
                href="/" 
                className="text-blue-600 hover:text-blue-800 text-sm"
              >
                ← Back to Main
              </a>
              <div className="text-sm text-gray-500">
                Connected to IB Gateway
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Debug Information */}
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="text-lg font-medium text-blue-900 mb-2">Debug Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p><strong>API URL:</strong> {process.env.NEXT_PUBLIC_API_URL || 'Not configured'}</p>
              <p><strong>Environment:</strong> {process.env.NODE_ENV || 'development'}</p>
            </div>
            <div>
              <p><strong>Target Endpoint:</strong> /api/market-data/realtime?symbol=MSFT</p>
              <p><strong>Update Frequency:</strong> Every 2 seconds</p>
            </div>
          </div>
        </div>

        {/* MSFT Chart */}
        <MSFTRealtimeChart />

        {/* Additional Debug Section */}
        <div className="mt-8 p-4 bg-gray-50 border border-gray-200 rounded-md">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Manual API Test</h3>
          <p className="text-sm text-gray-600 mb-4">
            Test the API endpoint directly from your browser or terminal:
          </p>
          <div className="bg-gray-800 text-green-400 p-3 rounded font-mono text-sm">
            curl "{process.env.NEXT_PUBLIC_API_URL || 'http://10.7.3.20:4000'}/api/market-data/realtime?symbol=MSFT"
          </div>
        </div>
      </main>
    </div>
  );
} 