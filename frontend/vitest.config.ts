import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './app'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['app/**/*.{ts,tsx}'],
      exclude: ['app/**/*.d.ts'],
    },
    // The app code reads NEXT_PUBLIC_* at module-evaluation time. The
    // individual test files re-import the module under test after
    // setting the env, so we keep modules isolated.
    isolate: true,
  },
});
