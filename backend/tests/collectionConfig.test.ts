/**
 * The data collection list's validation and routes. The SQL runs against a
 * real database in collectionConfig.db.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { CollectionConfigRepository } from '../src/services/collectionConfig.js';
import { collectionRouter } from '../src/routes/marketData/collection.js';

function repoWith() {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('INSERT INTO data_collection_config')) return { rows: [{ id: 1 }] };
    return {
      rows: [
        {
          id: 1,
          contract_id: 9,
          broker: 'oanda',
          account: 'default',
          symbol: 'EUR_USD',
          sec_type: 'CASH',
          timeframe: '1hour',
          enabled: true,
          auto_collect: true,
          collection_interval_minutes: 60,
          retention_days: 365,
        },
      ],
    };
  });
  const contracts = { getOrCreateContract: jest.fn(async () => 9) };
  return { repo: new CollectionConfigRepository({ query }, contracts), query, contracts };
}

describe('CollectionConfigRepository.add', () => {
  it('creates the contract at the chosen broker and saves the options', async () => {
    const { repo, query, contracts } = repoWith();
    await repo.add({
      broker: 'OANDA',
      symbol: 'eur_usd',
      timeframe: '1hour',
      collection_interval_minutes: 60,
    });
    expect(contracts.getOrCreateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        broker: 'oanda',
        brokerAccount: 'default',
        symbol: 'EUR_USD',
        secType: 'CASH',
      })
    );
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT'));
    expect(insert?.[1]).toEqual([9, '1hour', null, null, 60, null, false, null]);
  });

  it.each([
    [{ broker: 'nope', symbol: 'X', timeframe: '1hour' }, /broker must be/],
    [{ broker: 'ib', symbol: '', timeframe: '1hour' }, /symbol is required/],
    [{ broker: 'ib', symbol: 'MSFT', timeframe: 'tick' }, /timeframe must be/],
    [{ broker: 'ib', symbol: 'MSFT', timeframe: '1day', sec_type: 'XYZ' }, /sec_type/],
    [{ broker: 'ib', symbol: 'MSFT', timeframe: '1day', retention_days: 0 }, /retention_days/],
    [{ broker: 'ib', symbol: 'MSFT', timeframe: '1day', enabled: 'yes' }, /true or false/],
    [
      { broker: 'oanda', symbol: 'EUR_USD', timeframe: '5min', history_start: '1/2/24' },
      /YYYY-MM-DD/,
    ],
    [
      { broker: 'oanda', symbol: 'EUR_USD', timeframe: '5min', history_start: '2999-01-01' },
      /past/,
    ],
    [
      { broker: 'oanda', symbol: 'EUR_USD', timeframe: '5min', history_start: '2000-01-01' },
      /730 days/,
    ],
  ])('refuses %j', async (input, message) => {
    const { repo, contracts } = repoWith();
    await expect(repo.add(input)).rejects.toThrow(message);
    expect(contracts.getOrCreateContract).not.toHaveBeenCalled();
  });
});

describe('history_start', () => {
  const recent = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);

  it('is saved on add, and replaces the old one when added again', async () => {
    const { repo, query } = repoWith();
    await repo.add({
      broker: 'oanda',
      symbol: 'EUR_USD',
      timeframe: '5min',
      history_start: recent,
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT'));
    expect(insert?.[1]?.slice(-2)).toEqual([true, recent]);
  });

  it('is cleared by an empty value and left alone when absent', async () => {
    const { repo, query } = repoWith();
    await repo.update(3, { history_start: '' });
    await repo.update(3, { retention_days: 30 });
    const updates = query.mock.calls.filter(([sql]) => sql.includes('UPDATE'));
    expect(updates[0][1]?.slice(-2)).toEqual([true, null]);
    expect(updates[1][1]?.slice(-2)).toEqual([false, null]);
  });
});

describe('collection routes', () => {
  const app = (repo: any) => express().use(express.json()).use(collectionRouter(repo));

  it('lists entries with the brokers and timeframes to choose from', async () => {
    const res = await request(app(repoWith().repo)).get('/collection');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].symbol).toBe('EUR_USD');
    expect(res.body.timeframes).not.toContain('tick');
    expect(res.body.brokers).toContain('oanda');
  });

  it('answers 400 with the reason for a bad entry, and 404 for a missing one', async () => {
    const res = await request(app(repoWith().repo)).post('/collection').send({ broker: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/broker must be/);

    const empty = new CollectionConfigRepository(
      { query: jest.fn(async () => ({ rows: [] })) },
      { getOrCreateContract: jest.fn() }
    );
    expect((await request(app(empty)).delete('/collection/5')).status).toBe(404);
    expect((await request(app(empty)).put('/collection/abc').send({})).status).toBe(400);
  });
});
