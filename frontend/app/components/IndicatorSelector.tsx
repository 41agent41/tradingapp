'use client';

import React, { useState, useEffect } from 'react';

interface IndicatorMetadata {
  name: string;
  description: string;
}

interface IndicatorCategory {
  [key: string]: IndicatorMetadata;
}

interface AvailableIndicators {
  trend: IndicatorCategory;
  momentum: IndicatorCategory;
  volatility: IndicatorCategory;
  volume: IndicatorCategory;
}

interface IndicatorSelectorProps {
  selectedIndicators: string[];
  onIndicatorChange: (indicators: string[]) => void;
  isLoading?: boolean;
}

const IndicatorSelector: React.FC<IndicatorSelectorProps> = ({
  selectedIndicators,
  onIndicatorChange,
  isLoading = false
}) => {
  const [availableIndicators, setAvailableIndicators] = useState<AvailableIndicators | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [loadingIndicators, setLoadingIndicators] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch available indicators from API
  useEffect(() => {
    const fetchIndicators = async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL;
        if (!apiUrl) {
          throw new Error('API URL not configured');
        }

        const response = await fetch(`${apiUrl.replace(':4000', ':8000')}/indicators/available`);
        if (!response.ok) {
          throw new Error('Failed to fetch indicators');
        }

        const data = await response.json();
        setAvailableIndicators(data.indicators);
        setError(null);
      } catch (err) {
        console.error('Error fetching indicators:', err);
        setError(err instanceof Error ? err.message : 'Failed to load indicators');
        
        // Fallback to static indicators if API fails
        setAvailableIndicators({
          trend: {
            sma_20: { name: 'SMA 20', description: 'Simple Moving Average (20 periods)' },
            sma_50: { name: 'SMA 50', description: 'Simple Moving Average (50 periods)' },
            ema_12: { name: 'EMA 12', description: 'Exponential Moving Average (12 periods)' },
            ema_26: { name: 'EMA 26', description: 'Exponential Moving Average (26 periods)' },
          },
          momentum: {
            rsi: { name: 'RSI', description: 'Relative Strength Index (14 periods)' },
            macd: { name: 'MACD', description: 'Moving Average Convergence Divergence' },
            stochastic: { name: 'Stochastic', description: 'Stochastic Oscillator (%K/%D)' },
          },
          volatility: {
            bollinger: { name: 'Bollinger Bands', description: 'Bollinger Bands (20, 2.0)' },
            atr: { name: 'ATR', description: 'Average True Range (14 periods)' },
          },
          volume: {
            obv: { name: 'OBV', description: 'On-Balance Volume' },
            vwap: { name: 'VWAP', description: 'Volume Weighted Average Price' },
            volume_sma: { name: 'Volume SMA', description: 'Volume Simple Moving Average' },
          }
        });
      } finally {
        setLoadingIndicators(false);
      }
    };

    fetchIndicators();
  }, []);

  const handleIndicatorToggle = (indicatorKey: string) => {
    const newSelectedIndicators = selectedIndicators.includes(indicatorKey)
      ? selectedIndicators.filter(id => id !== indicatorKey)
      : [...selectedIndicators, indicatorKey];
    
    onIndicatorChange(newSelectedIndicators);
  };

  const handleClearAll = () => {
    onIndicatorChange([]);
  };

  const categoryColors = {
    trend: 'text-blue-600 border-blue-200 bg-blue-50',
    momentum: 'text-orange-600 border-orange-200 bg-orange-50',
    volatility: 'text-purple-600 border-purple-200 bg-purple-50',
    volume: 'text-green-600 border-green-200 bg-green-50'
  };

  const categoryIcons = {
    trend: '📈',
    momentum: '⚡',
    volatility: '🌊',
    volume: '📊'
  };

  if (loadingIndicators) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center space-x-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-sm text-gray-600">Loading indicators...</span>
        </div>
      </div>
    );
  }

  if (!availableIndicators) {
    return (
      <div className="bg-white rounded-lg border border-red-200 p-4">
        <div className="text-red-600 text-sm">
          {error || 'Failed to load indicators'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Header */}
      <div 
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center space-x-2">
          <span className="text-lg">📊</span>
          <h3 className="font-medium text-gray-900">Technical Indicators</h3>
          {selectedIndicators.length > 0 && (
            <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded">
              {selectedIndicators.length} selected
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          {selectedIndicators.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClearAll();
              }}
              className="text-xs text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50"
              disabled={isLoading}
            >
              Clear All
            </button>
          )}
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Indicator Categories */}
      {isExpanded && (
        <div className="border-t border-gray-200 p-4 space-y-4">
          {Object.entries(availableIndicators).map(([categoryKey, indicators]) => (
            <div key={categoryKey} className="space-y-2">
              <div className="flex items-center space-x-2">
                <span className="text-lg">{categoryIcons[categoryKey as keyof typeof categoryIcons]}</span>
                <h4 className="font-medium text-gray-700 capitalize">{categoryKey}</h4>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {Object.entries(indicators).map(([indicatorKey, metadata]) => (
                  <label
                    key={indicatorKey}
                    className={`flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedIndicators.includes(indicatorKey)
                        ? categoryColors[categoryKey as keyof typeof categoryColors]
                        : 'border-gray-200 hover:bg-gray-50'
                    } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndicators.includes(indicatorKey)}
                      onChange={() => handleIndicatorToggle(indicatorKey)}
                      disabled={isLoading}
                      className="mt-1 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900">
                        {metadata.name}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {metadata.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}

          {/* Usage Info */}
          {selectedIndicators.length > 0 && (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="text-sm text-blue-800">
                <div className="font-medium mb-1">Selected Indicators:</div>
                <div className="text-xs">{selectedIndicators.join(', ')}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default IndicatorSelector;