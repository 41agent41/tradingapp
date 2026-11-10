/**
 * The firm map (services/firms.ts) and its mirror in the frontend form
 * (FIRM_PRESETS in frontend/app/lib/brokerConnections.ts) must agree, and the
 * migration's backfill must name only real firms of the right platform.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { FIRMS, findFirm, firmsFor, impliedFirm } from '../src/services/firms.js';
import { BROKER_PRIORITY } from '../src/services/orderTypes.js';

const ROOT = join(__dirname, '..', '..');

describe('firms', () => {
  it('gives every platform at least one firm, and only known platforms', () => {
    for (const platform of BROKER_PRIORITY) expect(firmsFor(platform).length).toBeGreaterThan(0);
    for (const firm of FIRMS) expect(BROKER_PRIORITY).toContain(firm.platform);
    expect(new Set(FIRMS.map((f) => f.id)).size).toBe(FIRMS.length);
  });

  it('implies the firm only where a platform has one', () => {
    expect(impliedFirm('oanda')).toBe('oanda');
    expect(impliedFirm('ib')).toBe('ib');
    expect(impliedFirm('mt5')).toBeNull();
    expect(impliedFirm('ctrader')).toBeNull();
  });

  it('matches FIRM_PRESETS in the frontend form', () => {
    const source = readFileSync(join(ROOT, 'frontend/app/lib/brokerConnections.ts'), 'utf8');
    const block = source.slice(source.indexOf('export const FIRM_PRESETS'));
    const presets = [
      ...block.matchAll(
        /id: '([a-z0-9_]+)',\s*name: (?:'[^']*'|"[^"]*"),\s*platform: '([a-z0-9]+)'/g
      ),
    ].map((m) => [m[1], m[2]]);
    expect(presets).toEqual(FIRMS.map((f) => [f.id, f.platform]));
  });

  it('backfills only firms of the matching platform', () => {
    const sql = readFileSync(
      join(ROOT, 'backend/src/database/migrations/005_connection_firm.sql'),
      'utf8'
    );
    for (const m of sql.matchAll(/platform = '([a-z0-9]+)' AND account IN \(([^)]*)\)/g)) {
      for (const id of m[2].match(/'([^']+)'/g)!.map((q) => q.slice(1, -1))) {
        expect(findFirm(id)?.platform).toBe(m[1]);
      }
    }
  });
});
