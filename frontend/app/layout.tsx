import './globals.css';
import type { Metadata } from 'next';
import { TradingAccountProvider } from './contexts/TradingAccountContext';
import StartupNotice from './components/StartupNotice';
import ThemeToggle from './components/ThemeToggle';
import { THEME_SCRIPT } from './lib/theme';

export const metadata: Metadata = {
  title: 'TradingApp',
  description: 'Web-based trading platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-theme before React starts, so the attribute
    // differs from what the server sent.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <StartupNotice />
        <TradingAccountProvider>{children}</TradingAccountProvider>
        <ThemeToggle />
      </body>
    </html>
  );
}
