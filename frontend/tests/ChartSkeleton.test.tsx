import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ChartSkeleton from '../app/components/ChartSkeleton';

describe('ChartSkeleton', () => {
  it('renders the default loading label and marks the region busy', () => {
    const { container } = render(<ChartSkeleton />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('honours a custom label and height', () => {
    const { container } = render(<ChartSkeleton height={250} label="Loading MSFT…" />);
    expect(screen.getByText('Loading MSFT…')).toBeInTheDocument();
    const box = container.querySelector('[style*="height"]');
    expect(box).not.toBeNull();
  });

  it('renders header pills when withHeader is true', () => {
    const { container } = render(<ChartSkeleton withHeader />);
    // Three pulse pills in the header row.
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThanOrEqual(3);
  });
});
