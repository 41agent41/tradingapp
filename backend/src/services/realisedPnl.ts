/**
 * Realised P&L and net position from a stream of fills.
 *
 * The platform used to derive both from `order_audit` — a log of what it
 * *asked* a venue to trade. That estimate diverges from the account silently
 * on a partial fill, on a rejection that arrives after the acknowledgement,
 * and on any trade placed outside the app. `order_executions` records what
 * actually traded; this module is the arithmetic on top of it.
 *
 * Both functions are pure reducers over a time-ordered fill list, deliberately
 * separated from the SQL that fetches it: this is the part with the subtle
 * rules (average-cost basis, position reversal, commissions), and it should be
 * testable without a database.
 *
 * **Average-cost basis.** A fill that increases exposure moves the average
 * cost; a fill that reduces it realises `(exit − entry) × closed × direction`
 * against that average and leaves the average untouched. This matches how
 * every broker in the stack reports an average cost, so the app's numbers and
 * the venue's agree — FIFO/LIFO lot matching would give a different (also
 * defensible) answer that no venue here reports.
 *
 * **Reversals.** A sell of 150 against a long 100 closes the 100 and opens a
 * short 50 at the sell price. Treating it as "close 150" would realise P&L on
 * shares that were never held.
 *
 * **Commissions** are always subtracted, on entries as well as exits — a
 * commission is cash gone the moment it is charged, not something to defer to
 * the closing trade.
 */

export interface Fill {
  symbol: string;
  side: string; // 'BUY' | 'SELL'
  quantity: number | string;
  price: number | string;
  commission?: number | string | null;
}

export interface RealisedPnlResult {
  /** Net realised P&L across every symbol, commissions included. */
  realised: number;
  /** Commission paid over the same fills (already subtracted from `realised`). */
  commission: number;
  /** Per-symbol breakdown of realised P&L, for diagnostics. */
  bySymbol: Record<string, number>;
}

interface Lot {
  size: number; // signed: positive long, negative short
  avgPrice: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Signed size of a fill: BUY adds, SELL subtracts. */
function signedQuantity(fill: Fill): number {
  const quantity = Math.abs(num(fill.quantity));
  return String(fill.side).toUpperCase() === 'SELL' ? -quantity : quantity;
}

/**
 * Walk `fills` in the order given (callers pass them in execution order) and
 * return the realised P&L they imply.
 *
 * Fills are grouped by symbol internally, so a mixed-symbol list is fine — but
 * they must already be scoped to one venue and one account mode, since a
 * position never nets across those.
 */
export function realisedPnl(fills: Fill[]): RealisedPnlResult {
  const lots = new Map<string, Lot>();
  const bySymbol: Record<string, number> = {};
  let commission = 0;

  for (const fill of fills) {
    const symbol = String(fill.symbol ?? '').toUpperCase();
    const delta = signedQuantity(fill);
    const price = num(fill.price);
    const fee = Math.abs(num(fill.commission));

    commission += fee;
    bySymbol[symbol] = (bySymbol[symbol] ?? 0) - fee;

    if (delta === 0) continue;

    const lot = lots.get(symbol) ?? { size: 0, avgPrice: 0 };

    if (lot.size === 0 || Math.sign(lot.size) === Math.sign(delta)) {
      // Opening or adding: the average cost absorbs the new fill. No P&L is
      // realised by taking on exposure.
      const size = lot.size + delta;
      lot.avgPrice = (lot.avgPrice * Math.abs(lot.size) + price * Math.abs(delta)) / Math.abs(size);
      lot.size = size;
    } else {
      // Reducing, closing or reversing. Only the overlap with the existing
      // position realises P&L; anything beyond it opens a new position on the
      // other side at this fill's price.
      const closed = Math.min(Math.abs(delta), Math.abs(lot.size));
      const direction = lot.size > 0 ? 1 : -1;
      bySymbol[symbol] = (bySymbol[symbol] ?? 0) + (price - lot.avgPrice) * closed * direction;

      const remaining = lot.size + delta;
      if (Math.sign(remaining) === Math.sign(lot.size) || remaining === 0) {
        lot.size = remaining;
        if (remaining === 0) lot.avgPrice = 0;
      } else {
        // Reversed past flat — the leftover is a fresh position at this price.
        lot.size = remaining;
        lot.avgPrice = price;
      }
    }

    lots.set(symbol, lot);
  }

  const realised = Object.values(bySymbol).reduce((sum, value) => sum + value, 0);
  return { realised, commission, bySymbol };
}

/**
 * Net signed position per symbol implied by `fills` — the fill-authoritative
 * replacement for `OrderAuditRepository.netExposure`'s submitted-order estimate.
 */
export function netPositions(fills: Fill[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const fill of fills) {
    const symbol = String(fill.symbol ?? '').toUpperCase();
    net[symbol] = (net[symbol] ?? 0) + signedQuantity(fill);
  }
  return net;
}
