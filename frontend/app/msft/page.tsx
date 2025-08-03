'use client';

import React from 'react';
import MSFTRealtimeChart from '../components/MSFTRealtimeChart';
import BackToHome from '../components/BackToHome';

export default function MSFTPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center py-4 sm:py-6 space-y-4 sm:space-y-0">
            <div className="flex items-center space-x-2 sm:space-x-4">
              <BackToHome />
              <div className="min-w-0 flex-1">
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">MSFT Real-time Chart</h1>
                <p className="text-xs sm:text-sm text-gray-600 mt-1">Microsoft Corporation - Live Market Data</p>
              </div>
            </div>
            <div className="flex items-center space-x-2 sm:space-x-4">
              <div className="text-xs sm:text-sm text-gray-500">
                Connected to IB Gateway
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        {/* Debug Information */}
        <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="text-base sm:text-lg font-medium text-blue-900 mb-2">Debug Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-xs sm:text-sm">
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
        <div className="mt-6 sm:mt-8 p-3 sm:p-4 bg-gray-50 border border-gray-200 rounded-md">
          <h3 className="text-base sm:text-lg font-medium text-gray-900 mb-2">Manual API Test</h3>
          <p className="text-xs sm:text-sm text-gray-600 mb-3 sm:mb-4">
            Test the API endpoint directly from your browser or terminal:
          </p>
          <div className="bg-gray-800 text-green-400 p-2 sm:p-3 rounded font-mono text-xs sm:text-sm overflow-x-auto">
            curl "{process.env.NEXT_PUBLIC_API_URL || 'http://10.7.3.20:4000'}/api/market-data/realtime?symbol=MSFT"
          </div>
        </div>
      </main>
    </div>
  );
} 