'use client';

import React from 'react';

interface ConnectionStatusBarProps {
  connectionStatus: string;
  accountMode: string;
  dataType: string;
  onRefresh: () => void;
}

export default function ConnectionStatusBar({
  connectionStatus,
  accountMode,
  dataType,
  onRefresh,
}: ConnectionStatusBarProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between space-y-2 sm:space-y-0">
        <div className="flex flex-col sm:flex-row items-start sm:items-center space-y-2 sm:space-y-0 sm:space-x-4">
          <div className="flex items-center space-x-2">
            <div
              className={`w-3 h-3 rounded-full ${
                connectionStatus === 'Connected'
                  ? 'bg-green-500'
                  : connectionStatus === 'Checking...'
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
              }`}
            ></div>
            <span className="text-xs sm:text-sm font-medium">{connectionStatus}</span>
          </div>
          <div className="flex items-center space-x-2">
            <div
              className={`w-3 h-3 rounded-full ${
                accountMode === 'live' ? 'bg-red-500' : 'bg-green-500'
              }`}
            ></div>
            <span className="text-xs sm:text-sm font-medium">
              {accountMode.toUpperCase()} Mode •{' '}
              {dataType === 'real-time' ? 'Live Data' : 'Delayed Data'}
            </span>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="text-gray-400 hover:text-gray-600 text-xs sm:text-sm self-start sm:self-auto"
        >
          ↻ Refresh
        </button>
      </div>
    </div>
  );
}
