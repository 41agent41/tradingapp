'use client';

import React from 'react';
import Link from 'next/link';

interface BackToHomeProps {
  className?: string;
}

export default function BackToHome({ className = '' }: BackToHomeProps) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 hover:text-gray-900 transition-colors duration-200 ${className}`}
    >
      <svg 
        className="w-4 h-4 mr-2" 
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24"
      >
        <path 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeWidth={2} 
          d="M10 19l-7-7m0 0l7-7m-7 7h18" 
        />
      </svg>
      Back to Home
    </Link>
  );
} 