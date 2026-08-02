'use client';

import React, { useRef, useState } from 'react';
import BackToHome from '../components/BackToHome';
import OrderBlotter from '../components/OrderBlotter';
import OrderTicket from '../components/OrderTicket';

/**
 * Full trading surface — order ticket on the left, blotter on the right.
 *
 * The `/account` page hosts a compact OrderTicket too, but the dedicated
 * /trade page is where the blotter lives so traders can keep it open
 * while submitting follow-up orders. The blotter polls every 10 s.
 *
 * Every mutating action ultimately flows through `POST /api/orders` →
 * `POST /orders` on the IB service, both of which gate live orders on
 * the `LIVE_TRADING_ENABLED` env var.
 */
export default function TradePage() {
  // A simple counter lets the OrderTicket bump the blotter manually right
  // after a submission — faster than waiting for the next poll tick.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const blotterRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4 py-4 sm:py-6">
            <BackToHome />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Trade</h1>
              <p className="text-xs sm:text-sm text-gray-600 mt-1">
                Submit and monitor orders against IB Gateway
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <OrderTicket
            onPlaced={() => {
              setRefreshNonce((n) => n + 1);
              blotterRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          />
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Notes</h3>
            <ul className="text-xs text-gray-700 space-y-1 list-disc pl-5">
              <li>
                <strong>Paper</strong> orders run against IB's paper account and never touch real
                funds.
              </li>
              <li>
                <strong>Live</strong> orders require both the backend and IB service to start with
                <code className="mx-1 px-1 bg-gray-100 rounded">LIVE_TRADING_ENABLED=true</code>. A
                confirmation modal will appear before submission.
              </li>
              <li>
                Every attempt is recorded in <code>order_audit</code> (visible in the blotter
                below).
              </li>
              <li>
                Order types: <strong>MKT</strong>, <strong>LMT</strong>, <strong>STP</strong>,{' '}
                <strong>STP&nbsp;LMT</strong>. TIF: <strong>DAY</strong>, <strong>GTC</strong>,{' '}
                <strong>IOC</strong>, <strong>FOK</strong>.
              </li>
              <li>
                Fat-finger caps default to 100k quantity / $1M price; override with
                <code className="mx-1 px-1 bg-gray-100 rounded">ORDER_MAX_QUANTITY</code> /
                <code className="mx-1 px-1 bg-gray-100 rounded">ORDER_MAX_PRICE</code>.
              </li>
            </ul>
          </div>
        </div>

        <div ref={blotterRef}>
          <OrderBlotter key={refreshNonce} pollMs={10_000} />
        </div>
      </main>
    </div>
  );
}
