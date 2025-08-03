'use client';

import React from 'react';

interface TradingAccountSwitchProps {
  isLiveTrading: boolean;
  onToggle: (isLiveTrading: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export default function TradingAccountSwitch({
  isLiveTrading,
  onToggle,
  disabled = false,
  className = ''
}: TradingAccountSwitchProps) {
  const handleToggle = () => {
    if (!disabled) {
      onToggle(!isLiveTrading);
    }
  };

  return (
    <div className={`bg-white rounded-lg shadow-sm border p-4 sm:p-6 ${className}`}>
      <div className="flex flex-col lg:flex-row lg:items-center justify-between space-y-4 lg:space-y-0">
        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg font-medium text-gray-900 mb-2">
            Trading Account Mode
          </h3>
          <p className="text-xs sm:text-sm text-gray-600 mb-4">
            Switch between live trading and paper trading modes. This affects all market data requests throughout the application.
          </p>
          
          {/* Account Mode Display */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center space-y-2 sm:space-y-0 sm:space-x-4">
            <div className={`flex items-center space-x-2 px-4 py-2 rounded-lg border-2 ${
              isLiveTrading 
                ? 'border-red-200 bg-red-50 text-red-800' 
                : 'border-gray-200 bg-gray-50 text-gray-600'
            }`}>
              <div className={`w-3 h-3 rounded-full ${
                isLiveTrading ? 'bg-red-500' : 'bg-gray-400'
              }`}></div>
              <span className="font-medium">Live Trading</span>
              {isLiveTrading && (
                <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">
                  ACTIVE
                </span>
              )}
            </div>
            
            <div className={`flex items-center space-x-2 px-4 py-2 rounded-lg border-2 ${
              !isLiveTrading 
                ? 'border-green-200 bg-green-50 text-green-800' 
                : 'border-gray-200 bg-gray-50 text-gray-600'
            }`}>
              <div className={`w-3 h-3 rounded-full ${
                !isLiveTrading ? 'bg-green-500' : 'bg-gray-400'
              }`}></div>
              <span className="font-medium">Paper Trading</span>
              {!isLiveTrading && (
                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                  ACTIVE
                </span>
              )}
            </div>
          </div>
        </div>
        
        <div className="lg:ml-6 flex justify-center lg:justify-end">
          <button
            type="button"
            className={`
              relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent 
              transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2
              ${isLiveTrading 
                ? 'bg-red-600 focus:ring-red-500' 
                : 'bg-green-600 focus:ring-green-500'
              }
              ${disabled 
                ? 'opacity-50 cursor-not-allowed' 
                : 'hover:bg-opacity-90'
              }
              w-14 h-7
            `}
            role="switch"
            aria-checked={isLiveTrading}
            aria-disabled={disabled}
            onClick={handleToggle}
          >
            <span className="sr-only">Toggle trading account mode</span>
            <span
              aria-hidden="true"
              className={`
                pointer-events-none inline-block rounded-full bg-white shadow transform ring-0 
                transition duration-200 ease-in-out w-5 h-5
                ${isLiveTrading ? 'translate-x-7' : 'translate-x-0'}
              `}
            />
          </button>
        </div>
      </div>
      
      {/* Mode Information */}
      <div className="mt-4 p-4 rounded-lg border-l-4 bg-blue-50 border-blue-400">
        <div className="flex items-start space-x-3">
          <div className="text-blue-600 text-lg">
            {isLiveTrading ? '⚠️' : '📊'}
          </div>
          <div className="flex-1">
            <h4 className="font-medium text-blue-900 mb-1">
              {isLiveTrading ? 'Live Trading Mode' : 'Paper Trading Mode'}
            </h4>
            <div className="text-sm text-blue-700 space-y-1">
              {isLiveTrading ? (
                <>
                  <p>• <strong>Real-time market data</strong> with live pricing</p>
                  <p>• <strong>Live account data</strong> with actual positions and orders</p>
                  <p>• <strong>Real money transactions</strong> - use with caution</p>
                  <p>• <strong>Immediate execution</strong> of trades</p>
                </>
              ) : (
                <>
                  <p>• <strong>Delayed market data</strong> (15-20 minute delay)</p>
                  <p>• <strong>Paper account data</strong> with simulated positions</p>
                  <p>• <strong>Risk-free trading</strong> with virtual money</p>
                  <p>• <strong>Practice environment</strong> for strategy testing</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Warning for Live Trading */}
      {isLiveTrading && (
        <div className="mt-4 p-4 rounded-lg border-l-4 bg-red-50 border-red-400">
          <div className="flex items-start space-x-3">
            <div className="text-red-600 text-lg">⚠️</div>
            <div className="flex-1">
              <h4 className="font-medium text-red-900 mb-1">Live Trading Warning</h4>
              <p className="text-sm text-red-700">
                You are now in <strong>LIVE TRADING MODE</strong>. All trades and data requests will use real money and live market data. 
                Ensure you understand the risks before proceeding.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 