/**
 * The price levels a trader holds in one instrument, as lines for the chart
 * (E-24): each open position's entry, its stop and target, and each working
 * order.
 */
import type { ChartPriceLine } from '../components/Chart';

export interface LevelPosition {
  symbol: string;
  /** Signed: negative when short. */
  position: number;
  average_cost?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
}

export interface LevelOrder {
  order_id: string;
  symbol: string;
  action: string;
  quantity: number;
  order_type: string;
  remaining_quantity?: number | null;
  /** The price the order waits at. */
  price?: number | null;
}

const COLOR = {
  long: '#2563eb',
  short: '#7c3aed',
  stop: '#dc2626',
  target: '#059669',
  order: '#b45309',
};

/** `EUR.USD`, `EUR/USD`, `eur_usd` and `EURUSD` all name one instrument. */
export const sameInstrument = (a: string, b: string) =>
  a.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === b.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const amount = (n: number) => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const level = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const ORDER_NAME: Record<string, string> = { LMT: 'limit', STP: 'stop', STP_LMT: 'stop-limit' };

/** The lines to draw for `symbol`. Rows for other instruments, flat
 *  positions and orders with no waiting price add nothing. */
export function priceLevels(
  symbol: string,
  positions: LevelPosition[],
  orders: LevelOrder[]
): ChartPriceLine[] {
  const lines: ChartPriceLine[] = [];
  for (const p of positions) {
    if (!p || !sameInstrument(p.symbol ?? '', symbol) || !p.position) continue;
    const long = p.position > 0;
    if (level(p.average_cost)) {
      lines.push({
        key: `position:${long ? 'long' : 'short'}`,
        price: p.average_cost,
        color: long ? COLOR.long : COLOR.short,
        style: 'solid',
        title: `${long ? 'Long' : 'Short'} ${amount(p.position)}`,
      });
    }
    if (level(p.stop_loss)) {
      lines.push({
        key: `stop:${long ? 'long' : 'short'}`,
        price: p.stop_loss,
        color: COLOR.stop,
        style: 'dashed',
        title: 'Stop',
      });
    }
    if (level(p.take_profit)) {
      lines.push({
        key: `target:${long ? 'long' : 'short'}`,
        price: p.take_profit,
        color: COLOR.target,
        style: 'dashed',
        title: 'Target',
      });
    }
  }
  for (const o of orders) {
    if (!o || !sameInstrument(o.symbol ?? '', symbol) || !level(o.price)) continue;
    const kind = ORDER_NAME[String(o.order_type).toUpperCase()] ?? String(o.order_type);
    const side = String(o.action).toUpperCase() === 'SELL' ? 'Sell' : 'Buy';
    lines.push({
      key: `order:${o.order_id}`,
      price: o.price,
      color: COLOR.order,
      style: 'dotted',
      title: `${side} ${kind} ${amount(o.remaining_quantity ?? o.quantity)}`,
    });
  }
  return lines;
}
