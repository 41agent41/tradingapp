'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import TradingChart from './components/TradingChart';

export default function HomePage() {
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    // Use the backend URL from environment or default to localhost
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const newSocket = io(backendUrl);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setConnectionStatus('Connected');
      console.log('Connected to backend');
    });

    newSocket.on('disconnect', () => {
      setConnectionStatus('Disconnected');
      console.log('Disconnected from backend');
    });

    return () => {
      newSocket.close();
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-100">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200 px-6 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-3xl font-bold text-gray-900">TradingApp</h1>
            <div className="flex items-center space-x-4">
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                connectionStatus === 'Connected' ? 'bg-green-100 text-green-800' : 
                connectionStatus === 'Connecting...' ? 'bg-yellow-100 text-yellow-800' :
                'bg-red-100 text-red-800'
              }`}>
                {connectionStatus}
              </div>
              <Link 
                href="/account" 
                className="bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-md transition-colors"
              >
                Account
              </Link>
            </div>
          </div>
        </div>

        {/* Main Trading Chart */}
        <div className="p-6">
          <TradingChart 
            onTimeframeChange={(timeframe) => console.log('Timeframe changed:', timeframe)}
            onSymbolChange={(symbol) => console.log('Symbol changed:', symbol)}
          />
        </div>
      </div>
    </main>
  );
} 