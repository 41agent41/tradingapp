'use client';

import React from 'react';

interface DataSwitchProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  label: string;
  description?: string;
  size?: 'small' | 'medium' | 'large';
  disabled?: boolean;
  className?: string;
}

export default function DataSwitch({
  enabled,
  onToggle,
  label,
  description,
  size = 'medium',
  disabled = false,
  className = ''
}: DataSwitchProps) {
  const handleToggle = () => {
    if (!disabled) {
      onToggle(!enabled);
    }
  };

  const sizeClasses = {
    small: {
      switch: 'w-8 h-5',
      thumb: 'w-3 h-3',
      translate: 'translate-x-3',
      label: 'text-sm',
      description: 'text-xs'
    },
    medium: {
      switch: 'w-11 h-6',
      thumb: 'w-4 h-4',
      translate: 'translate-x-5',
      label: 'text-base',
      description: 'text-sm'
    },
    large: {
      switch: 'w-14 h-7',
      thumb: 'w-5 h-5',
      translate: 'translate-x-7',
      label: 'text-lg',
      description: 'text-base'
    }
  };

  const sizes = sizeClasses[size];

  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex-1 mr-4">
        <label 
          htmlFor={`data-switch-${label.replace(/\s+/g, '-').toLowerCase()}`}
          className={`font-medium text-gray-900 ${sizes.label} ${disabled ? 'opacity-50' : ''}`}
        >
          {label}
        </label>
        {description && (
          <p className={`text-gray-600 mt-1 ${sizes.description} ${disabled ? 'opacity-50' : ''}`}>
            {description}
          </p>
        )}
      </div>
      
      <div className="flex items-center">
        <button
          type="button"
          className={`
            relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent 
            transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2
            ${enabled 
              ? 'bg-blue-600 focus:ring-blue-500' 
              : 'bg-gray-200 focus:ring-gray-300'
            }
            ${disabled 
              ? 'opacity-50 cursor-not-allowed' 
              : 'hover:bg-opacity-90'
            }
            ${sizes.switch}
          `}
          role="switch"
          aria-checked={enabled}
          aria-disabled={disabled}
          onClick={handleToggle}
          id={`data-switch-${label.replace(/\s+/g, '-').toLowerCase()}`}
        >
          <span className="sr-only">{label}</span>
          <span
            aria-hidden="true"
            className={`
              pointer-events-none inline-block rounded-full bg-white shadow transform ring-0 
              transition duration-200 ease-in-out
              ${enabled ? sizes.translate : 'translate-x-0'}
              ${sizes.thumb}
            `}
          />
        </button>
        
        {/* Status indicator */}
        <div className="ml-3 flex items-center">
          <div 
            className={`
              w-2 h-2 rounded-full 
              ${enabled ? 'bg-green-500' : 'bg-red-500'}
              ${disabled ? 'opacity-50' : ''}
            `}
          />
          <span 
            className={`
              ml-2 text-xs font-medium
              ${enabled ? 'text-green-700' : 'text-red-700'}
              ${disabled ? 'opacity-50' : ''}
            `}
          >
            {enabled ? 'ON' : 'OFF'}
          </span>
        </div>
      </div>
    </div>
  );
} 