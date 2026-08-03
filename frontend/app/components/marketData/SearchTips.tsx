'use client';

import React from 'react';

export default function SearchTips() {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
      <div className="flex items-start space-x-2">
        <span className="text-blue-600 text-lg">💡</span>
        <div>
          <div className="text-blue-800 font-medium mb-1">Search Tips:</div>
          <ul className="text-blue-700 text-sm space-y-1">
            <li>• Use Quick Search buttons for popular stocks</li>
            <li>• Try searching by company name (check "Search by company name")</li>
            <li>• Use Advanced Search for options, futures, and specific criteria</li>
            <li>• For options: specify expiry (YYYYMMDD), strike price, and right (C/P)</li>
            <li>• For futures: specify expiry and multiplier</li>
            <li>• Recent searches are saved for quick access</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
