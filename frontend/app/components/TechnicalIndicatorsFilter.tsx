'use client';

import React, { useState, useEffect } from 'react';

interface TechnicalIndicatorsFilterProps {
  onIndicatorsChange: (indicators: string[]) => void;
  disabled?: boolean;
}

interface Indicator {
  name: string;
  category: string;
  description: string;
  parameters?: string[];
}

const INDICATOR_CATEGORIES = {
  'Trend Indicators': [
    { name: 'sma_20', description: 'Simple Moving Average (20 periods)', parameters: ['20'] },
    { name: 'sma_50', description: 'Simple Moving Average (50 periods)', parameters: ['50'] },
    { name: 'ema_12', description: 'Exponential Moving Average (12 periods)', parameters: ['12'] },
    { name: 'ema_26', description: 'Exponential Moving Average (26 periods)', parameters: ['26'] },
    { name: 'macd', description: 'MACD (Moving Average Convergence Divergence)', parameters: ['12', '26', '9'] }
  ],
  'Momentum Indicators': [
    { name: 'rsi', description: 'Relative Strength Index (14 periods)', parameters: ['14'] },
    { name: 'stoch_k', description: 'Stochastic %K (14 periods)', parameters: ['14'] },
    { name: 'stoch_d', description: 'Stochastic %D (3 periods)', parameters: ['3'] }
  ],
  'Volatility Indicators': [
    { name: 'bb_upper', description: 'Bollinger Bands Upper (20 periods)', parameters: ['20', '2'] },
    { name: 'bb_middle', description: 'Bollinger Bands Middle (20 periods)', parameters: ['20'] },
    { name: 'bb_lower', description: 'Bollinger Bands Lower (20 periods)', parameters: ['20', '2'] },
    { name: 'atr', description: 'Average True Range (14 periods)', parameters: ['14'] }
  ],
  'Volume Indicators': [
    { name: 'obv', description: 'On-Balance Volume', parameters: [] },
    { name: 'vwap', description: 'Volume Weighted Average Price', parameters: [] },
    { name: 'volume_sma', description: 'Volume Simple Moving Average (20 periods)', parameters: ['20'] }
  ]
};

export default function TechnicalIndicatorsFilter({ onIndicatorsChange, disabled = false }: TechnicalIndicatorsFilterProps) {
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>([]);
  const [availableIndicators, setAvailableIndicators] = useState<Record<string, Indicator[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Fetch available indicators from API
  useEffect(() => {
    const fetchIndicators = async () => {
      setIsLoading(true);
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL;
        if (!apiUrl) {
          // Fallback to predefined indicators if API is not available
          setAvailableIndicators(INDICATOR_CATEGORIES);
          return;
        }

        const response = await fetch(`${apiUrl}/indicators/available`);
        if (response.ok) {
          const data = await response.json();
          // Transform API response to match our structure
          const transformed = Object.entries(data.indicators || {}).reduce((acc, [category, indicators]) => {
            acc[category] = Array.isArray(indicators) ? indicators : [];
            return acc;
          }, {} as Record<string, Indicator[]>);
          
          setAvailableIndicators(transformed);
        } else {
          // Fallback to predefined indicators
          setAvailableIndicators(INDICATOR_CATEGORIES);
        }
      } catch (error) {
        console.error('Error fetching indicators:', error);
        // Fallback to predefined indicators
        setAvailableIndicators(INDICATOR_CATEGORIES);
      } finally {
        setIsLoading(false);
      }
    };

    fetchIndicators();
  }, []);

  // Handle indicator selection
  const handleIndicatorToggle = (indicatorName: string) => {
    const newSelected = selectedIndicators.includes(indicatorName)
      ? selectedIndicators.filter(name => name !== indicatorName)
      : [...selectedIndicators, indicatorName];
    
    setSelectedIndicators(newSelected);
    onIndicatorsChange(newSelected);
  };

  // Handle select all indicators in category
  const handleSelectCategory = (category: string) => {
    const categoryIndicators = availableIndicators[category] || [];
    const categoryNames = categoryIndicators.map(ind => ind.name);
    
    const newSelected = [...selectedIndicators];
    categoryNames.forEach(name => {
      if (!newSelected.includes(name)) {
        newSelected.push(name);
      }
    });
    
    setSelectedIndicators(newSelected);
    onIndicatorsChange(newSelected);
  };

  // Handle deselect all indicators in category
  const handleDeselectCategory = (category: string) => {
    const categoryIndicators = availableIndicators[category] || [];
    const categoryNames = categoryIndicators.map(ind => ind.name);
    
    const newSelected = selectedIndicators.filter(name => !categoryNames.includes(name));
    
    setSelectedIndicators(newSelected);
    onIndicatorsChange(newSelected);
  };

  // Handle select all indicators
  const handleSelectAll = () => {
    const allIndicators = Object.values(availableIndicators).flat().map(ind => ind.name);
    setSelectedIndicators(allIndicators);
    onIndicatorsChange(allIndicators);
  };

  // Handle deselect all indicators
  const handleDeselectAll = () => {
    setSelectedIndicators([]);
    onIndicatorsChange([]);
  };

  // Check if all indicators in category are selected
  const isCategorySelected = (category: string) => {
    const categoryIndicators = availableIndicators[category] || [];
    const categoryNames = categoryIndicators.map(ind => ind.name);
    return categoryNames.every(name => selectedIndicators.includes(name));
  };

  // Check if any indicators in category are selected
  const isCategoryPartiallySelected = (category: string) => {
    const categoryIndicators = availableIndicators[category] || [];
    const categoryNames = categoryIndicators.map(ind => ind.name);
    return categoryNames.some(name => selectedIndicators.includes(name));
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Technical Indicators
        </label>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          <span className="ml-2 text-sm text-gray-500">Loading indicators...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with controls */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">
          Technical Indicators
        </label>
        <div className="flex space-x-2">
          <button
            onClick={handleSelectAll}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Select All
          </button>
          <button
            onClick={handleDeselectAll}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Quick Selection */}
      <div>
        <p className="text-xs text-gray-500 mb-2">Quick selections:</p>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => onIndicatorsChange(['sma_20', 'rsi', 'bb_upper', 'bb_lower'])}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Basic Set
          </button>
          <button
            onClick={() => onIndicatorsChange(['sma_20', 'sma_50', 'ema_12', 'ema_26', 'macd', 'rsi'])}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Trend Analysis
          </button>
          <button
            onClick={() => onIndicatorsChange(['rsi', 'stoch_k', 'stoch_d', 'bb_upper', 'bb_lower', 'atr'])}
            disabled={disabled}
            className="px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Momentum Set
          </button>
        </div>
      </div>

      {/* Indicators by Category */}
      <div className="space-y-3">
        {Object.entries(availableIndicators).map(([category, indicators]) => (
          <div key={category} className="border border-gray-200 rounded-md">
            {/* Category Header */}
            <div className="flex items-center justify-between p-3 bg-gray-50 border-b border-gray-200">
              <h4 className="text-sm font-medium text-gray-700">{category}</h4>
              <div className="flex space-x-1">
                <button
                  onClick={() => isCategorySelected(category) 
                    ? handleDeselectCategory(category) 
                    : handleSelectCategory(category)
                  }
                  disabled={disabled}
                  className={`px-2 py-1 text-xs rounded ${
                    isCategorySelected(category)
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-green-100 text-green-700 hover:bg-green-200'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {isCategorySelected(category) ? 'Deselect All' : 'Select All'}
                </button>
              </div>
            </div>

            {/* Category Indicators */}
            <div className="p-3 space-y-2">
              {indicators.map((indicator) => (
                <label key={indicator.name} className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={selectedIndicators.includes(indicator.name)}
                    onChange={() => handleIndicatorToggle(indicator.name)}
                    disabled={disabled}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-gray-700">{indicator.name}</span>
                    <p className="text-xs text-gray-500">{indicator.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Selected Indicators Summary */}
      {selectedIndicators.length > 0 && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
          <p className="text-sm text-blue-800">
            <span className="font-medium">Selected ({selectedIndicators.length}):</span>
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {selectedIndicators.map((indicator) => (
              <span
                key={indicator}
                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded"
              >
                {indicator}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Advanced Options Toggle */}
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          disabled={disabled}
          className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {showAdvanced ? '▼' : '▶'} Advanced Options
        </button>
        
        {showAdvanced && (
          <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-md">
            <p className="text-xs text-gray-600 mb-2">
              Advanced indicator options and custom parameters can be configured here.
            </p>
            <p className="text-xs text-gray-500">
              Note: Most indicators use default parameters optimized for common trading strategies.
            </p>
          </div>
        )}
      </div>
    </div>
  );
} 