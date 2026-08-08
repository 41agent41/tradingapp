/**
 * Position sizing (Systematic Trading roadmap — A3).
 *
 * Resolve a strategy's abstract `sizing` block into a concrete, broker-native
 * order quantity. Per the roadmap the broker is the authority on what a
 * quantity *means* and what sizes it will accept — so the same `type` yields
 * different concrete quantities on IB/Alpaca (shares) vs MT5 (lots) vs OANDA
 * (units).
 *
 * That authority arrives as an `InstrumentSpec` fetched from the venue
 * (`GET /instrument/spec`). It supplies the three numbers that make the
 * conversion exact rather than approximate:
 *
 *   - `contractSize` — what one quantity unit controls. 1 for a share and for
 *     an OANDA unit (an OANDA "unit" *is* one unit of the base currency);
 *     typically 100000 for a standard FX lot on MT5. Notional and
 *     percent-of-equity sizing divide by `price × contractSize`.
 *   - `sizeStep` — the venue's size increment (1 share, 0.01 lots, …).
 *   - `minSize` — the smallest size it will accept.
 *
 * Lot and unit sizing used to be refused outright, because pricing a lot as if
 * it were a share is not a rounding error — at a standard contract size it is
 * a five-order-of-magnitude mistake. With the spec the conversion is exact, so
 * the refusal is gone.
 *
 * A resolved size is **floored** onto the step and refused below the minimum:
 * rounding up would place an order larger than the strategy asked for, which
 * is never the safe direction to err.
 *
 * `pct_equity` additionally needs an account equity figure, which the engine
 * supplies from the run's own venue (`/account/summary?broker=`, normalised
 * per venue so this code never sees a raw broker payload).
 *
 * A pure function returning a discriminated result: a positive quantity, or a
 * reason the size can't be resolved (so the engine skips the order with an
 * auditable explanation rather than guessing).
 */

export interface SizingSpec {
  type?: string; // 'fixed' | 'notional' | 'pct_equity' | 'risk_pct'
  unit?: string; // 'broker_default' | 'shares' | 'lots' | 'units' | 'notional' | 'pct_equity'
  size?: number;
}

/** The venue's answer to "what is one unit here, and what sizes do you take?" */
export interface InstrumentSpec {
  unit: string; // 'shares' | 'lots' | 'units'
  minSize: number;
  sizeStep: number;
  maxSize?: number | null;
  contractSize: number;
  /** Minimum distance a stop must sit from the market, in **points** (MT5's
   *  `trade_stops_level`). Needs `point` to become a price distance (E-2). */
  stopsLevel?: number | null;
  /** Price value of one point. */
  point?: number | null;
  /** Value of one tick in the **account** currency, and the tick size it
   *  applies to. Risk-based sizing (E-4) divides by these rather than by
   *  `contractSize`, because a price move is denominated in the quote currency
   *  while the risk budget is in the account's. */
  tickValue?: number | null;
  tickSize?: number | null;
}

/** Whole shares — what every equity venue in the stack uses, and the behaviour
 *  this module shipped with before instrument specs existed. */
export const DEFAULT_SPEC: InstrumentSpec = {
  unit: 'shares',
  minSize: 1,
  sizeStep: 1,
  maxSize: null,
  contractSize: 1,
};

export interface SizingContext {
  /** Latest close for the run's symbol — used to convert notional → quantity. */
  price: number;
  /** The protective stop for this entry. Required by `risk_pct`, which sizes
   *  from the distance to it (E-4). */
  stopPrice?: number | null;
  /** Execution broker for the run (used only for messages now that the spec
   *  carries the venue's actual unit semantics). */
  broker: string;
  /** Account equity, when known — required for `pct_equity`. */
  equity?: number | null;
  /** The venue's instrument spec; omitted, whole shares are assumed. */
  spec?: InstrumentSpec | null;
}

export type SizeResolution = { ok: true; quantity: number } | { ok: false; reason: string };

function positiveOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Floor `quantity` onto a multiple of `step`.
 *
 * Floors rather than rounds so a resolved size never grows past what the
 * strategy asked for. The result is re-rounded to the step's own decimal
 * precision because binary floating point turns e.g. `0.07 / 0.01` into
 * 6.999999999999999, which would floor to 0.06 — a whole step lost to
 * representation error.
 */
export function roundToStep(quantity: number, step: number): number {
  if (!(step > 0)) return quantity;
  const steps = Math.floor(quantity / step + 1e-9);
  const decimals = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) + 2 : 0;
  return Number((steps * step).toFixed(decimals));
}

/**
 * What one unit of size loses when price moves `stopDistance` against it,
 * denominated in the **account** currency.
 *
 * The naive formula — `stopDistance × contractSize` — is correct only when the
 * instrument's quote currency matches the account's. EURUSD in a USD account
 * works; EURJPY, XAUUSD in some configurations, and index CFDs do not, because
 * the price move is denominated in the quote currency while the risk budget is
 * in the account's. Getting it wrong does not error: it silently sizes every
 * position wrong by the FX rate, which stays invisible until it is expensive.
 *
 * So the venue's own `tickValue` / `tickSize` are used where available — MT5
 * reports the tick value already converted to the account currency — and the
 * contract-size approximation is used **only** when the instrument is quoted
 * in the account currency. Returns null when neither is safe, so the caller
 * refuses rather than guessing.
 */
export function lossPerUnitOfSize(
  spec: InstrumentSpec,
  stopDistance: number,
  contractSize: number
): number | null {
  const tickValue = Number(spec.tickValue) || 0;
  const tickSize = Number(spec.tickSize) || 0;
  if (tickValue > 0 && tickSize > 0) {
    return (stopDistance / tickSize) * tickValue;
  }
  // Shares and OANDA units are quoted in the account currency in this stack,
  // and a contract size of 1 means a price move *is* the per-unit loss.
  if (contractSize === 1) return stopDistance;
  return null;
}

export function resolveOrderQuantity(spec: SizingSpec, ctx: SizingContext): SizeResolution {
  const type = spec?.type ?? 'fixed';
  const unit = spec?.unit ?? 'broker_default';
  const size = Number(spec?.size);

  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `sizing.size must be a positive number (got ${spec?.size})` };
  }

  const instrument: InstrumentSpec = { ...DEFAULT_SPEC, ...(ctx.spec ?? {}) };
  const venueUnit = instrument.unit || 'shares';

  // A rule-set may pin a unit. If it names one the venue doesn't trade in, the
  // declared size means something other than what it says, and converting it
  // would be a guess — refuse instead.
  if (unit !== 'broker_default' && unit !== venueUnit) {
    return {
      ok: false,
      reason: `sizing unit '${unit}' does not match ${ctx.broker}'s '${venueUnit}'`,
    };
  }

  const contractSize = positiveOr(instrument.contractSize, 1);
  const step = positiveOr(instrument.sizeStep, 1);
  const minSize = positiveOr(instrument.minSize, step);

  let quantity: number;
  switch (type) {
    case 'fixed':
      // Already expressed in venue units — no conversion, just conformance.
      quantity = size;
      break;

    case 'notional': {
      if (!Number.isFinite(ctx.price) || ctx.price <= 0) {
        return { ok: false, reason: 'notional sizing needs a positive bar price' };
      }
      quantity = size / (ctx.price * contractSize);
      break;
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
      quantity = ((size / 100) * ctx.equity) / (ctx.price * contractSize);
      break;
    }

    case 'risk_pct': {
      // Risk a fixed fraction of equity per trade: position size falls out of
      // the distance to the stop, so notional varies with stop width but the
      // **loss does not**. That is the point — it makes a wide-stop setup and
      // a tight-stop setup comparable, and it is the reason to know the stop
      // at entry at all.
      if (ctx.equity == null || !Number.isFinite(ctx.equity) || ctx.equity <= 0) {
        return {
          ok: false,
          reason:
            'risk_pct sizing needs account equity — the venue reported none ' +
            "(check /account/summary for this run's connection)",
        };
      }
      if (ctx.stopPrice == null || !Number.isFinite(ctx.stopPrice) || ctx.stopPrice <= 0) {
        return {
          ok: false,
          reason: 'risk_pct sizing needs a stop price — declare a `stop` block on the rule-set',
        };
      }
      if (!Number.isFinite(ctx.price) || ctx.price <= 0) {
        return { ok: false, reason: 'risk_pct sizing needs a positive bar price' };
      }

      const stopDistance = Math.abs(ctx.price - ctx.stopPrice);
      if (!(stopDistance > 0)) {
        return { ok: false, reason: 'risk_pct sizing needs a non-zero distance to the stop' };
      }

      const lossPerUnit = lossPerUnitOfSize(instrument, stopDistance, contractSize);
      if (lossPerUnit == null) {
        return {
          ok: false,
          reason:
            'risk_pct sizing needs the venue tick value — refusing rather than approximating ' +
            'from contract size, which is only correct when the quote and account currencies ' +
            'match',
        };
      }

      const riskBudget = (size / 100) * ctx.equity;
      quantity = riskBudget / lossPerUnit;
      break;
    }

    default:
      return { ok: false, reason: `unknown sizing type '${type}'` };
  }

  const maxSize = Number(instrument.maxSize);
  if (Number.isFinite(maxSize) && maxSize > 0) {
    quantity = Math.min(quantity, maxSize);
  }

  const rounded = roundToStep(quantity, step);
  if (rounded < minSize) {
    return {
      ok: false,
      reason:
        `resolved quantity ${quantity.toPrecision(6)} ${venueUnit} is below ` +
        `${ctx.broker}'s minimum of ${minSize}`,
    };
  }
  return { ok: true, quantity: rounded };
}
