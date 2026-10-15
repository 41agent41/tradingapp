/**
 * Settings: the Getting started checklist shows what is left, opens the tab
 * where each step is done, and disappears once everything is done.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GettingStarted, { type ChecklistItem } from '../app/components/GettingStarted';

const ITEMS: ChecklistItem[] = [
  {
    id: 'password',
    title: 'Choose the login password',
    done: true,
    detail: 'Set.',
    tab: 'security',
  },
  {
    id: 'broker',
    title: 'Add a broker connection',
    done: false,
    detail: 'Add one (OANDA, MT5, IB or Alpaca); it is tested when saved.',
    tab: 'connections',
  },
];

function mockApi(items: ChecklistItem[]) {
  global.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ items, done: items.every((i) => i.done) }), { status: 200 })
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GettingStarted', () => {
  it('lists the steps left and opens the tab for one', async () => {
    mockApi(ITEMS);
    const onOpen = vi.fn();
    render(<GettingStarted onOpen={onOpen} />);
    expect(await screen.findByText('Getting started: 1 of 2 steps left')).toBeInTheDocument();
    expect(screen.getByText(/it is tested when saved/)).toBeInTheDocument();
    // A done step is not a link.
    expect(screen.queryByRole('button', { name: 'Choose the login password' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a broker connection' }));
    expect(onOpen).toHaveBeenCalledWith('connections');
  });

  it('shows nothing once every step is done', async () => {
    mockApi(ITEMS.map((i) => ({ ...i, done: true })));
    const { container } = render(<GettingStarted onOpen={vi.fn()} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the checklist cannot be read', async () => {
    global.fetch = vi.fn(
      async () => new Response('{}', { status: 500 })
    ) as unknown as typeof fetch;
    const { container } = render(<GettingStarted onOpen={vi.fn()} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
