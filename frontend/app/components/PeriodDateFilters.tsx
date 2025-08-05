'use client';

import React, { useState } from 'react';

interface PeriodDateFiltersProps {
  onFiltersChange: (filters: { period: string; startDate?: string; endDate?: string; useDateRange: boolean }) => void;
  disabled?: boolean;
}

const PERIODS = [
  { value: '1D', label: '1 Day', description: 'Last 24 hours' },
  { value: '1W', label: '1 Week', description: 'Last 7 days' },
  { value: '1M', label: '1 Month', description: 'Last 30 days' },
  { value: '3M', label: '3 Months', description: 'Last 90 days' },
  { value: '6M', label: '6 Months', description: 'Last 180 days' },
  { value: '1Y', label: '1 Year', description: 'Last 365 days' }
];

export default function PeriodDateFilters({ onFiltersChange, disabled = false }: PeriodDateFiltersProps) {
  const [useDateRange, setUseDateRange] = useState(false);
  const [period, setPeriod] = useState('3M');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Set default end date to today
  React.useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    setEndDate(today);
  }, []);

  // Handle period change
  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    setUseDateRange(false);
    onFiltersChange({
      period: newPeriod,
      useDateRange: false
    });
  };

  // Handle date range toggle
  const handleDateRangeToggle = (useRange: boolean) => {
    setUseDateRange(useRange);
    if (useRange) {
      onFiltersChange({
        period: 'CUSTOM',
        startDate,
        endDate,
        useDateRange: true
      });
    } else {
      onFiltersChange({
        period,
        useDateRange: false
      });
    }
  };

  // Handle start date change
  const handleStartDateChange = (date: string) => {
    setStartDate(date);
    if (useDateRange) {
      onFiltersChange({
        period: 'CUSTOM',
        startDate: date,
        endDate,
        useDateRange: true
      });
    }
  };

  // Handle end date change
  const handleEndDateChange = (date: string) => {
    setEndDate(date);
    if (useDateRange) {
      onFiltersChange({
        period: 'CUSTOM',
        startDate,
        endDate: date,
        useDateRange: true
      });
    }
  };

  // Validate date range
  const validateDateRange = () => {
    if (!startDate || !endDate) return false;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    
    return start < end && end <= today;
  };

  const isDateRangeValid = validateDateRange();

  return (
    <div className="space-y-4">
      {/* Period vs Date Range Toggle */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Time Period
        </label>
        <div className="flex space-x-2">
          <button
            onClick={() => handleDateRangeToggle(false)}
            disabled={disabled}
            className={`px-4 py-2 text-sm rounded-md font-medium ${
              !useDateRange
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Predefined Period
          </button>
          <button
            onClick={() => handleDateRangeToggle(true)}
            disabled={disabled}
            className={`px-4 py-2 text-sm rounded-md font-medium ${
              useDateRange
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Custom Date Range
          </button>
        </div>
      </div>

      {!useDateRange ? (
        /* Predefined Period Selection */
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Period
          </label>
          <div className="grid grid-cols-2 gap-2">
            {PERIODS.map((periodOption) => (
              <button
                key={periodOption.value}
                onClick={() => handlePeriodChange(periodOption.value)}
                disabled={disabled}
                className={`p-3 text-sm rounded-md border ${
                  period === periodOption.value
                    ? 'bg-blue-50 border-blue-300 text-blue-700'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="font-medium">{periodOption.label}</div>
                <div className="text-xs text-gray-500">{periodOption.description}</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        /* Custom Date Range Selection */
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleStartDateChange(e.target.value)}
                disabled={disabled}
                max={endDate}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => handleEndDateChange(e.target.value)}
                disabled={disabled}
                max={new Date().toISOString().split('T')[0]}
                min={startDate}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          {/* Date Range Validation */}
          {startDate && endDate && !isDateRangeValid && (
            <div className="p-2 bg-red-50 border border-red-200 rounded-md">
              <p className="text-xs text-red-600">
                ⚠️ Invalid date range. Start date must be before end date and end date cannot be in the future.
              </p>
            </div>
          )}

          {/* Date Range Summary */}
          {startDate && endDate && isDateRangeValid && (
            <div className="p-2 bg-green-50 border border-green-200 rounded-md">
              <p className="text-xs text-green-600">
                ✓ Date range: {startDate} to {endDate}
              </p>
              <p className="text-xs text-green-500 mt-1">
                Duration: {Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24))} days
              </p>
            </div>
          )}
        </div>
      )}

      {/* Current Selection Summary */}
      <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
        <p className="text-sm text-gray-700">
          <span className="font-medium">Selected:</span>{' '}
          {useDateRange 
            ? `Custom range: ${startDate} to ${endDate}`
            : `${PERIODS.find(p => p.value === period)?.label}`
          }
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {useDateRange 
            ? 'Custom date range selected'
            : `${PERIODS.find(p => p.value === period)?.description}`
          }
        </p>
      </div>
    </div>
  );
} 