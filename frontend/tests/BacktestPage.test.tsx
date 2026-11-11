/**
 * The backtest page's question when stored bars do not cover the range:
 * fetch what is missing, or run on what is stored.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BacktestPage from '../app/backtest/page';
import {
  describeFills,
  describeRunData,
  describeSpread,
  spreadsMissing,
} from '../app/lib/backtestData';

const RESULTS = {
  symbol: 'MSFT',
  start_date: '2026-01-05',
  end_date: '2026-03-01',
  initial_capital: 100000,
  final_capital: 104000,
  total_trades: 3,
  winning_trades: 2,
  losing_trades: 1,
  total_return: 4000,
  total_return_percent: 4,
  max_drawdown: 1,
  sharpe_ratio: 1.2,
  win_rate: 66.6,
  average_win: 3000,
  average_loss: -2000,
  profit_factor: 3,
  equity_curve: [],
  trades_summary: [],
};

function mockApi(firstRun: { status: number; body: unknown }) {
  const runs: any[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/api/backtesting/run') && init?.method === 'POST') {
      runs.push(JSON.parse(String(init.body)));
      if (runs.length === 1) return json(firstRun.body, firstRun.status);
      return json({
        success: true,
        results: RESULTS,
        data_points: 40,
        timeframe: '1day',
        period: '1Y',
        persisted_id: 5,
        data: {
          source: 'stored',
          bars: 40,
          first_bar: '2026-01-05T00:00:00.000Z',
          last_bar: '2026-03-01T00:00:00.000Z',
          hash: 'abcdef0123456789',
          complete: false,
        },
      });
    }
    if (url.includes('/api/backtesting/strategies')) {
      return json({ strategies: { ma_crossover: { name: 'MA Crossover', indicators: [] } } });
    }
    if (url.includes('/api/backtesting/runs')) return json({ runs: [] });
    return json({ definitions: [] });
  }) as any;
  return runs;
}

describe('BacktestPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks what to do when bars are missing, and runs on stored bars when told to', async () => {
    const runs = mockApi({
      status: 409,
      body: {
        error: 'coverage_incomplete',
        detail: 'Stored bars do not cover the whole range. Missing: 2025-11-10 to 2026-01-05.',
        coverage: { bars: 40 },
      },
    });
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('MA Crossover')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }));

    const question = await screen.findByRole('alert');
    expect(question).toHaveTextContent('Missing: 2025-11-10 to 2026-01-05');
    expect(question).toHaveTextContent('the 40 bars already stored');
    expect(runs[0].on_missing).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Run on what is stored' }));
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ symbol: 'MSFT', on_missing: 'use_stored' });
    await waitFor(() =>
      expect(screen.getByTestId('result-data')).toHaveTextContent(
        'Stored bars, 2026-01-05 to 2026-03-01 (the range is not fully covered). Data hash abcdef012345'
      )
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers only the fetch when nothing is stored, and sends it', async () => {
    const runs = mockApi({
      status: 409,
      body: {
        error: 'coverage_incomplete',
        detail: 'No bars are stored for this instrument, timeframe and range.',
        coverage: { bars: 0 },
      },
    });
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('MA Crossover')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Run on what is stored' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch missing bars, then run' }));
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1].on_missing).toBe('fetch');
  });

  it('offers to download the range again when stored bars have no spreads', async () => {
    const runs = mockApi({
      status: 200,
      body: {
        success: true,
        results: RESULTS,
        data_points: 40,
        timeframe: '1day',
        period: '1Y',
        data: { source: 'stored', bars: 40, spread_bars: 0, spread_source: true, complete: true },
      },
    });
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('MA Crossover')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }));

    const note = await screen.findByTestId('result-spread-missing');
    expect(note).toHaveTextContent("0 of 40 bars carry the broker's spread");
    expect(screen.queryByTestId('result-spread')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Download the range again with spreads, then run' })
    );
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ symbol: 'MSFT', on_missing: 'refetch' });
    await waitFor(() =>
      expect(screen.queryByTestId('result-spread-missing')).not.toBeInTheDocument()
    );
  });

  it('says what the spread cost when the run used it', async () => {
    mockApi({
      status: 200,
      body: {
        success: true,
        results: {
          ...RESULTS,
          spread: {
            applied: true,
            bars: 40,
            bars_with_spread: 40,
            fills: 6,
            cost: 12.5,
            average: 0.0002,
          },
        },
        data_points: 40,
        timeframe: '1day',
        period: '1Y',
        data: { source: 'stored', bars: 40, spread_bars: 40, spread_source: true, complete: true },
      },
    });
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('MA Crossover')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run Backtest' }));
    expect(await screen.findByTestId('result-spread')).toHaveTextContent(
      'The spread cost 12.50 over 6 fills.'
    );
    expect(screen.queryByTestId('result-spread-missing')).not.toBeInTheDocument();
  });
});

describe('describeRunData', () => {
  it('says where the bars came from', () => {
    expect(describeRunData(null)).toBeNull();
    expect(describeRunData({ source: 'broker', bars: 10 })).toMatch(/fetched from the broker/);
    expect(
      describeRunData({
        source: 'stored',
        first_bar: '2026-01-05T00:00:00Z',
        last_bar: '2026-02-01T00:00:00Z',
        hash: '0123456789abcdef',
        complete: true,
      })
    ).toBe('Stored bars, 2026-01-05 to 2026-02-01. Data hash 0123456789ab');
    expect(
      describeRunData({
        source: 'stored',
        built_from: '1min',
        first_bar: '2026-01-05T00:00:00.000Z',
        last_bar: '2026-02-01T00:00:00.000Z',
      })
    ).toBe('Bars built from stored 1 minute bars, 2026-01-05 to 2026-02-01');
  });
});

describe('describeFills', () => {
  it('says nothing for a strategy without a stop', () => {
    expect(describeFills(undefined)).toBeNull();
    expect(describeFills({})).toBeNull();
  });

  it('says what stops were filled against and how often', () => {
    expect(
      describeFills({ stop: true, model: '1min', bars: 96, bars_with_minutes: 90, stop_exits: 3 })
    ).toBe(
      'Stops filled along stored 1 minute bars (90 of 96 bars had them). 3 trades closed on the stop.'
    );
    expect(
      describeFills({ stop: true, model: 'bar', bars: 96, stop_exits: 1, entries_refused: 2 })
    ).toBe(
      "Stops filled on each bar's own range (no 1 minute bars are stored for this range). " +
        '1 trade closed on the stop. 2 entries were refused because the stop could not be set.'
    );
  });
});

describe('describeSpread', () => {
  it('says nothing when no spread was applied', () => {
    expect(describeSpread(undefined)).toBeNull();
    expect(describeSpread({ applied: false, bars: 10 })).toBeNull();
  });

  it('says what the spread cost, and how many bars had one', () => {
    expect(
      describeSpread({ applied: true, bars: 10, bars_with_spread: 10, fills: 1, cost: 3 })
    ).toBe(
      "Buys filled at the ask and sells at the bid, using the broker's spread on each bar. " +
        'The spread cost 3.00 over 1 fill.'
    );
    expect(
      describeSpread({ applied: true, bars: 10, bars_with_spread: 4, fills: 2, cost: 1234.5 })
    ).toMatch(
      /cost 1,234\.50 over 2 fills\. 4 of 10 bars carried a spread; the rest filled at the bar's own price\.$/
    );
  });
});

describe('spreadsMissing', () => {
  it('is true only for stored bars from a broker that reports spreads', () => {
    expect(spreadsMissing(null)).toBe(false);
    expect(spreadsMissing({ source: 'stored', bars: 10, spread_bars: 0 })).toBe(false);
    expect(spreadsMissing({ source: 'broker', bars: 10, spread_source: true })).toBe(false);
    expect(
      spreadsMissing({ source: 'stored', bars: 10, spread_bars: 10, spread_source: true })
    ).toBe(false);
    expect(
      spreadsMissing({ source: 'stored', bars: 10, spread_bars: 4, spread_source: true })
    ).toBe(true);
  });
});
