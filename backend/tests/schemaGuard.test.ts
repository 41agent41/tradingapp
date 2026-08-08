/**
 * Tests for the multi-connection schema guard (C-4 / C7).
 *
 * The hazard is silent: a second connection on the pre-C-0 schema drops every
 * colliding fill, and widening the constraint later recovers nothing because
 * the rows were never written. So the guard's job is to be loud *before* that
 * happens, and to distinguish "unsafe" from "cannot tell".
 */
import { checkConnectionSchema, reportSchemaGuard } from '../src/services/schemaGuard.js';

function db(rows: any[] = [], fail = false) {
  return {
    query: jest.fn().mockImplementation(async () => {
      if (fail) throw new Error('connection refused');
      return { rows };
    }),
  };
}

describe('checkConnectionSchema', () => {
  it('passes when the connection-scoped key is present', async () => {
    const result = await checkConnectionSchema(db([{ '?column?': 1 }]), 3);
    expect(result.ok).toBe(true);
  });

  it('refuses multi-connection on the pre-C-0 schema', async () => {
    const result = await checkConnectionSchema(db([]), 3);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/only unique within an account/);
  });

  it('allows a single connection on the old schema', async () => {
    // That is exactly the pre-C-0 state, and it is safe: fill ids are unique
    // within one account.
    const result = await checkConnectionSchema(db([]), 1);
    expect(result.ok).toBe(true);
  });

  it('treats an unreadable database as indeterminate, not unsafe', async () => {
    // A transient outage must not become a refusal to boot; the app is
    // unusable without a database anyway and that failure reports itself.
    const result = await checkConnectionSchema(db([], true), 3);
    expect(result.ok).toBe(true);
    expect(result.indeterminate).toBe(true);
  });
});

describe('reportSchemaGuard', () => {
  it('permits startup when the check passed', () => {
    expect(reportSchemaGuard({ ok: true })).toBe(true);
  });

  it('permits startup when the check was indeterminate', () => {
    expect(reportSchemaGuard({ ok: true, indeterminate: true, reason: 'db down' })).toBe(true);
  });

  it('blocks startup when the schema is unsafe', () => {
    expect(reportSchemaGuard({ ok: false, reason: 'old key' })).toBe(false);
  });
});
