/**
 * Position sizing (Systematic Trading roadmap — A3).
 *
 * Resolve a strategy's abstract `sizing` block into a concrete, broker-native
 * order quantity. Per the roadmap the broker adapter is the authority that
 * turns an abstract size into a valid, rounded quantity and rejects
 * sub-minimum sizes — so the same `type` yields different concrete quantities
 * on IB (shares) vs MT5 (lots). Phase 3 ships the IB (equities / shares) path;
 * MT5 lots resolve in B2.
 *
 * A pure function returning a discriminated result: a positive integer
 * quantity, or a reason the size can't be resolved (so the engine skips the
 * order with an auditable explanation rather than guessing a quantity).
 */

export interface SizingSpec {
  type?: string; // 'fixed' | 'notional' | 'pct_equity'
  unit?: string; // 'broker_default' | 'shares' | 'lots' | 'notional' | 'pct_equity'
  size?: number;
}

export interface SizingContext {
  /** Latest close for the run's symbol — used to convert notional → quantity. */
  price: number;
  /** Execution broker for the run; only 'ib' is resolvable in Phase 3. */
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
 * MT5 `lots` sizing is out of scope until the MT5 adapter (B2) lands, so it is
 * rejected rather than silently mis-sized as shares.
 */
export function resolveOrderQuantity(spec: SizingSpec, ctx: SizingContext): SizeResolution {
  const type = spec?.type ?? 'fixed';
  const unit = spec?.unit ?? 'broker_default';
  const size = Number(spec?.size);

  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `sizing.size must be a positive number (got ${spec?.size})` };
  }

  if (ctx.broker !== 'ib') {
    return {
      ok: false,
      reason: `sizing for broker '${ctx.broker}' is not supported yet (Phase 3 is IB-only)`,
    };
  }
  if (unit === 'lots') {
    return { ok: false, reason: "sizing unit 'lots' is MT5-only; this run targets IB (shares)" };
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
          reason: 'pct_equity sizing needs account equity, which is not wired for paper A3',
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
