'use client';

import React, { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border border-red-200 p-6">
        <div className="flex items-start space-x-3">
          <div className="text-2xl" aria-hidden="true">
            ⚠️
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
            <p className="mt-1 text-sm text-gray-600">
              An unexpected error occurred while rendering this page. The rest of the app is still
              available — try again, or go back to the home page.
            </p>
            {error.digest && (
              <p className="mt-2 text-xs text-gray-400">
                Reference: <code>{error.digest}</code>
              </p>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
                Technical details
              </summary>
              <pre className="mt-2 overflow-auto rounded bg-gray-50 p-2 text-[11px] text-gray-700">
                {error.message}
              </pre>
            </details>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Try again
              </button>
              <a
                href="/"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Go home
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
