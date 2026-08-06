'use client';

import React from 'react';
import BackToHome from '../components/BackToHome';
import Watchlist from '../components/Watchlist';

export default function WatchlistPage() {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4 py-4 sm:py-6">
            <BackToHome />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Watchlist</h1>
              <p className="text-xs sm:text-sm text-gray-600 mt-1">
                Track symbols and their live quotes in one place
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Watchlist />
      </main>
    </div>
  );
}
