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
  type?: string; // 'fixed' | 'notional' | 'pct_equity'
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
