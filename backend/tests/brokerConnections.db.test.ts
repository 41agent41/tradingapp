/**
 * A connection's own limits and prop rules against a real TimescaleDB (the
 * columns come from migration 002). Runs only with DB_TESTS=1 (see
 * marketDataStorage.db.test.ts); otherwise skipped.
 */
import { dbService } from '../src/services/database.js';
import { BrokerConnectionStore } from '../src/services/brokerConnections.js';
import { loadConnectionLimits } from '../src/services/accountLimits.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const account = `db${Date.now().toString(36).slice(-6)}`;

run('connection limits (real database)', () => {
  jest.setTimeout(60000);
  const store = new BrokerConnectionStore(dbService, {
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
  });
  const ctx = { actor: 'test' };

  afterAll(async () => {
    await dbService.query('DELETE FROM broker_connections WHERE account = $1', [account]);
    await dbService.close();
  });

  it('stores, keeps and clears them, and the entry checks read them', async () => {
    const prop = { firm: 'FTMO', initial_balance: 10000, max_loss: { pct: 10 } };
    const created = await store.create(
      {
        platform: 'ib',
        account,
        settings: { host: '10.0.0.5' },
        limits: { max_drawdown: 750 },
        prop_rules: prop,
      },
      ctx
    );
    expect(created).toMatchObject({ limits: { max_drawdown: 750 }, prop_rules: prop });

    await store.update(created.id, { account_mode: 'live' }, ctx);
    const limits = await loadConnectionLimits({ broker: 'ib', brokerAccount: account }, store, {});
    expect(limits).toMatchObject({
      max_drawdown: 750,
      prop: expect.objectContaining({ firm: 'FTMO' }),
    });

    await store.update(created.id, { limits: null, prop_rules: null }, ctx);
    expect(await store.limitsFor('ib', account)).toEqual({ limits: {}, prop_rules: null });
  });
});
