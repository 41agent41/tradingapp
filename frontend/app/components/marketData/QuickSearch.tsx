'use client';

import React from 'react';

import { POPULAR_SYMBOLS } from './constants';

interface QuickSearchProps {
  onSelect: (symbol: string) => void;
}

export default function QuickSearch({ onSelect }: QuickSearchProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-4 sm:p-6 mb-6">
      <div className="flex items-center space-x-2 mb-4">
        <span className="text-base sm:text-lg">⚡</span>
        <h3 className="text-base sm:text-lg font-medium text-gray-900">Quick Search</h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {POPULAR_SYMBOLS.map((item) => (
          <button
            key={item.symbol}
            onClick={() => onSelect(item.symbol)}
            className="p-2 text-xs sm:text-sm bg-gray-100 hover:bg-blue-100 text-gray-700 hover:text-blue-700 rounded-md transition-colors"
          >
            <div className="font-medium truncate">{item.symbol}</div>
            <div className="text-xs text-gray-500 truncate">{item.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
