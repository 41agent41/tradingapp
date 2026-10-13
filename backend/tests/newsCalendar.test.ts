/**
 * Economic calendar for prop-firm news blackouts (R-P2).
 */
import {
  NewsCalendar,
  blackoutEvent,
  instrumentCurrencies,
  parseCalendar,
} from '../src/services/newsCalendar.js';

const FEED = [
  {
    title: 'Non-Farm Employment Change',
    country: 'USD',
    date: '2026-10-02T08:30:00-04:00',
    impact: 'High',
  },
  {
    title: 'German Factory Orders',
    country: 'EUR',
    date: '2026-10-02T02:00:00-04:00',
    impact: 'Low',
  },
  { title: 'bad row', country: 'USD', date: 'not a date', impact: 'High' },
];

describe('parseCalendar', () => {
  it('reads the feed and drops rows it cannot place in time', () => {
    const events = parseCalendar(FEED);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      at: new Date('2026-10-02T12:30:00Z'),
      currency: 'USD',
      impact: 'High',
      title: 'Non-Farm Employment Change',
    });
  });

  it('refuses something that is not a list', () => {
    expect(() => parseCalendar({ error: 'rate limited' })).toThrow('not a list');
  });
});

describe('instrumentCurrencies', () => {
  it('splits FX and metal pairs, ignoring broker suffixes', () => {
    expect(instrumentCurrencies('EURUSD')).toEqual(['EUR', 'USD']);
    expect(instrumentCurrencies('EUR/USD')).toEqual(['EUR', 'USD']);
    expect(instrumentCurrencies('XAUUSD.a')).toEqual(['XAU', 'USD']);
    expect(instrumentCurrencies('gbpjpym')).toEqual(['GBP', 'JPY']);
  });

  it('falls back to the quote currency for anything else', () => {
    expect(instrumentCurrencies('US500', 'USD')).toEqual(['USD']);
    expect(instrumentCurrencies('MSFT')).toEqual([]);
  });
});

describe('blackoutEvent', () => {
  const events = parseCalendar(FEED);
  const rule = { minutes_before: 2, minutes_after: 2, impact: ['High'] };

  it('finds a high-impact release for either currency inside the window', () => {
    const at = new Date('2026-10-02T12:28:30Z');
    expect(blackoutEvent(events, ['EUR', 'USD'], at, rule)?.title).toBe(
      'Non-Farm Employment Change'
    );
    expect(blackoutEvent(events, ['USD'], new Date('2026-10-02T12:32:00Z'), rule)).not.toBeNull();
  });

  it('ignores releases outside the window, for other currencies or of lower impact', () => {
    expect(blackoutEvent(events, ['USD'], new Date('2026-10-02T12:27:59Z'), rule)).toBeNull();
    expect(
      blackoutEvent(events, ['GBP', 'JPY'], new Date('2026-10-02T12:30:00Z'), rule)
    ).toBeNull();
    expect(blackoutEvent(events, ['EUR'], new Date('2026-10-02T06:00:00Z'), rule)).toBeNull();
  });
});

describe('NewsCalendar', () => {
  const t0 = new Date('2026-10-02T00:00:00Z');
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it('fetches on first use and again once the refresh interval passes', async () => {
    const fetchBody = jest.fn().mockResolvedValue(FEED);
    const calendar = new NewsCalendar(fetchBody, { NEWS_CALENDAR_REFRESH_MINUTES: '60' });
    const first = await calendar.current(t0);
    expect(first.stale).toBe(false);
    expect(first.events).toHaveLength(2);
    await calendar.current(later(30 * 60_000));
    expect(fetchBody).toHaveBeenCalledTimes(1);
    await calendar.current(later(61 * 60_000));
    expect(fetchBody).toHaveBeenCalledTimes(2);
  });

  it('is stale when it has never been fetched', async () => {
    const calendar = new NewsCalendar(jest.fn().mockRejectedValue(new Error('blocked')), {});
    const state = await calendar.current(t0);
    expect(state).toEqual(
      expect.objectContaining({ stale: true, fetchedAt: null, error: 'blocked' })
    );
  });

  it('keeps the last copy through an outage until it is too old', async () => {
    const fetchBody = jest.fn().mockResolvedValueOnce(FEED).mockRejectedValue(new Error('down'));
    const calendar = new NewsCalendar(fetchBody, {
      NEWS_CALENDAR_REFRESH_MINUTES: '60',
      NEWS_CALENDAR_MAX_AGE_HOURS: '24',
    });
    await calendar.current(t0);
    const during = await calendar.current(later(2 * 3_600_000));
    expect(during).toEqual(expect.objectContaining({ stale: false, error: 'down' }));
    expect(during.events).toHaveLength(2);
    const after = await calendar.current(later(25 * 3_600_000));
    expect(after.stale).toBe(true);
  });

  it('retries a failed fetch at most once a minute', async () => {
    const fetchBody = jest.fn().mockRejectedValue(new Error('down'));
    const calendar = new NewsCalendar(fetchBody, {});
    await calendar.current(t0);
    await calendar.current(later(10_000));
    expect(fetchBody).toHaveBeenCalledTimes(1);
    await calendar.current(later(61_000));
    expect(fetchBody).toHaveBeenCalledTimes(2);
  });
});
