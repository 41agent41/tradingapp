import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom doesn't implement matchMedia or ResizeObserver, both of which
// lightweight-charts touches when a <Chart> mounts (device-pixel-ratio
// observation + container resize). Without these the chart smoke tests throw
// an async "matchMedia is not a function" from fancy-canvas. Provide inert
// stubs so the shared <Chart> primitive can render under jsdom.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
