import './globals.css';
import type { Metadata } from 'next';
import { TradingAccountProvider } from './contexts/TradingAccountContext';
import StartupNotice from './components/StartupNotice';

export const metadata: Metadata = {
  title: 'TradingApp',
  description: 'Web-based trading platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StartupNotice />
        <TradingAccountProvider>{children}</TradingAccountProvider>
      </body>
    </html>
  );
}
