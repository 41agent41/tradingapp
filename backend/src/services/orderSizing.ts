/**
 * Position sizing (Systematic Trading roadmap — A3).
 *
 * Resolve a strategy's abstract `sizing` block into a concrete, broker-native
 * order quantity. Per the roadmap the broker adapter is the authority that
 * turns an abstract size into a valid, rounded quantity and rejects
 * sub-minimum sizes — so the same `type` yields different concrete quantities
 * on IB/Alpaca (shares) vs MT5 (lots) vs OANDA (units). Phase 3 ships the
 * share-based path (IB, Alpaca); MT5 lots and OANDA units resolve later.
 *
 * `pct_equity` needs an account equity figure, which the engine now supplies
 * from the run's own venue (`/account/summary?broker=`, normalised per venue
 * so this code never sees a raw broker payload). It was previously unreachable
 * — every `pct_equity` size was rejected with "not wired for paper A3".
 *
 * A pure function returning a discriminated result: a positive integer
 * quantity, or a reason the size can't be resolved (so the engine skips the
 * order with an auditable explanation rather than guessing a quantity).
 */

export interface SizingSpec {
  type?: string; // 'fixed' | 'notional' | 'pct_equity'
  unit?: string; // 'broker_default' | 'shares' | 'lots' | 'units' | 'notional' | 'pct_equity'
  size?: number;
}

export interface SizingContext {
  /** Latest close for the run's symbol — used to convert notional → quantity. */
  price: number;
  /** Execution broker for the run; only share-based brokers (ib, alpaca) resolve today. */
  broker: string;
  /** Account equity, when known — required for `pct_equity`. */
  equity?: number | null;
}

export type SizeResolution = { ok: true; quantity: number } | { ok: false; reason: string };

function positiveInt(raw: number): SizeResolution {
  const q = Math.floor(raw);
  if (!Number.isFinite(q) || q < 1) {
    return { ok: false, reason: `resolved quantity ${raw} is below the 1-unit minimum` };
  }
  return { ok: true, quantity: q };
}

/**
 * Resolve `sizing` → an integer share quantity for the given context.
 *
 *   - `fixed`      → `size` shares outright.
 *   - `notional`   → floor(size / price) shares (needs a positive price).
 *   - `pct_equity` → floor((size% × equity) / price) shares (needs equity + price).
 *
 * Alpaca trades in shares with identical unit semantics to IB, so it shares
 * this path. MT5 `lots` and OANDA `units` sizing are out of scope until their
 * broker-native unit conversion lands, so both are rejected rather than
 * silently mis-sized as shares.
 */
const SHARE_SIZED_BROKERS = new Set(['ib', 'alpaca']);

export function resolveOrderQuantity(spec: SizingSpec, ctx: SizingContext): SizeResolution {
  const type = spec?.type ?? 'fixed';
  const unit = spec?.unit ?? 'broker_default';
  const size = Number(spec?.size);

  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `sizing.size must be a positive number (got ${spec?.size})` };
  }

  if (!SHARE_SIZED_BROKERS.has(ctx.broker)) {
    return {
      ok: false,
      reason: `sizing for broker '${ctx.broker}' is not supported yet (share-based sizing only)`,
    };
  }
  if (unit === 'lots') {
    return { ok: false, reason: "sizing unit 'lots' is MT5-only; this run targets IB (shares)" };
  }
  if (unit === 'units') {
    return {
      ok: false,
      reason: "sizing unit 'units' is OANDA-only; this run targets IB/Alpaca (shares)",
    };
  }

  switch (type) {
    case 'fixed':
      return positiveInt(size);

    case 'notional': {
      if (!Number.isFinite(ctx.price) || ctx.price <= 0) {
        return { ok: false, reason: 'notional sizing needs a positive bar price' };
      }
      return positiveInt(size / ctx.price);
    }

    case 'pct_equity': {
      if (ctx.equity == null || !Number.isFinite(ctx.equity) || ctx.equity <= 0) {
        return {
          ok: false,
          reason:
            'pct_equity sizing needs account equity — the venue reported none ' +
            "(check /account/summary for this run's broker)",
        };
      }
      if (!Number.isFinite(ctx.price) || ctx.price <= 0) {
        return { ok: false, reason: 'pct_equity sizing needs a positive bar price' };
      }
      return positiveInt(((size / 100) * ctx.equity) / ctx.price);
    }

    default:
      return { ok: false, reason: `unknown sizing type '${type}'` };
  }
}
