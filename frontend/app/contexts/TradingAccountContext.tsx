'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface TradingAccountContextType {
  isLiveTrading: boolean;
  setIsLiveTrading: (isLiveTrading: boolean) => void;
  accountMode: 'live' | 'paper';
  dataType: 'real-time' | 'delayed';
}

const TradingAccountContext = createContext<TradingAccountContextType | undefined>(undefined);

interface TradingAccountProviderProps {
  children: ReactNode;
}

export function TradingAccountProvider({ children }: TradingAccountProviderProps) {
  // Initialize with paper trading by default for safety
  const [isLiveTrading, setIsLiveTrading] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('trading-account-mode');
      return saved === 'live';
    }
    return false; // Default to paper trading
  });

  // Update localStorage when trading mode changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('trading-account-mode', isLiveTrading ? 'live' : 'paper');
      console.log(`🔄 Trading account mode changed to: ${isLiveTrading ? 'LIVE' : 'PAPER'}`);
    }
  }, [isLiveTrading]);

  // Computed values
  const accountMode = isLiveTrading ? 'live' : 'paper';
  const dataType = isLiveTrading ? 'real-time' : 'delayed';

  const value: TradingAccountContextType = {
    isLiveTrading,
    setIsLiveTrading,
    accountMode,
    dataType
  };

  return (
    <TradingAccountContext.Provider value={value}>
      {children}
    </TradingAccountContext.Provider>
  );
}

export function useTradingAccount() {
  const context = useContext(TradingAccountContext);
  if (context === undefined) {
    throw new Error('useTradingAccount must be used within a TradingAccountProvider');
  }
  return context;
} 