'use client';

import React from 'react';

import type { ContractResult, MarketData } from './types';

interface MarketDataPanelProps {
  contract: ContractResult;
  marketData: MarketData | null;
  loading: boolean;
  onShowChart: () => void;
}

export default function MarketDataPanel({
  contract,
  marketData,
  loading,
  onShowChart,
}: MarketDataPanelProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <span className="text-lg text-green-500">📈</span>
          <h3 className="text-lg font-medium text-gray-900">Market Data - {contract.symbol}</h3>
        </div>

        <div className="flex space-x-2">
          <button
            onClick={onShowChart}
            className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 flex items-center space-x-2"
          >
            <span>📊</span>
            <span>View Chart</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <span className="animate-spin mr-2">↻</span>
          <span className="text-gray-600">Loading market data...</span>
        </div>
      ) : marketData ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-gray-50 rounded-md">
            <div className="text-sm text-gray-600">Last Price</div>
            <div className="text-xl font-bold text-gray-900">
              ${marketData.last?.toFixed(2) || 'N/A'}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-md">
            <div className="text-sm text-gray-600">Bid</div>
            <div className="text-xl font-bold text-blue-600">
              ${marketData.bid?.toFixed(2) || 'N/A'}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-md">
            <div className="text-sm text-gray-600">Ask</div>
            <div className="text-xl font-bold text-red-600">
              ${marketData.ask?.toFixed(2) || 'N/A'}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-md">
            <div className="text-sm text-gray-600">Volume</div>
            <div className="text-xl font-bold text-gray-900">
              {marketData.volume?.toLocaleString() || 'N/A'}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">No market data available</div>
      )}
    </div>
  );
}
