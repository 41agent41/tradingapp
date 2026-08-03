'use client';

import React from 'react';

import type { ContractResult } from './types';

interface SearchResultsListProps {
  results: ContractResult[];
  selectedConid?: string;
  onSelect: (contract: ContractResult) => void;
}

export default function SearchResultsList({
  results,
  selectedConid,
  onSelect,
}: SearchResultsListProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">
        📊 Search Results ({results.length})
      </h3>
      <div className="space-y-3">
        {results.map((contract) => (
          <div
            key={contract.conid}
            onClick={() => onSelect(contract)}
            className={`p-4 border rounded-md cursor-pointer transition-colors ${
              selectedConid === contract.conid
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center space-x-2 mb-1">
                  <div className="font-medium text-gray-900">{contract.symbol}</div>
                  <div className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                    {contract.secType}
                  </div>
                  {contract.exchange && contract.exchange !== 'SMART' && (
                    <div className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                      {contract.exchange}
                    </div>
                  )}
                </div>

                <div className="text-sm text-gray-700 mb-2">{contract.companyName}</div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                  {contract.currency && <div>Currency: {contract.currency}</div>}
                  {contract.primaryExchange && <div>Primary: {contract.primaryExchange}</div>}
                  {contract.expiry && <div>Expiry: {contract.expiry}</div>}
                  {contract.strike && <div>Strike: {contract.strike}</div>}
                  {contract.right && <div>Right: {contract.right === 'C' ? 'Call' : 'Put'}</div>}
                  {contract.multiplier && <div>Multiplier: {contract.multiplier}</div>}
                  {contract.tradingClass && <div>Class: {contract.tradingClass}</div>}
                  {contract.industry && <div>Industry: {contract.industry}</div>}
                </div>

                {contract.tradingHours && (
                  <div className="text-xs text-gray-500 mt-1">
                    Trading Hours: {contract.tradingHours}
                  </div>
                )}
              </div>

              <div className="text-xs text-gray-500 ml-4">
                <div>ID: {contract.conid}</div>
                {contract.localSymbol && <div>Local: {contract.localSymbol}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
