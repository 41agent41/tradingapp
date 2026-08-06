/**
 * Tests for the rule-set builder helpers (A5 / Phase 4).
 */
import { describe, expect, it } from 'vitest';
import { buildDefinitionPayload, coerceOperand, type StrategyForm } from '../app/lib/ruleSet';

function form(overrides: Partial<StrategyForm> = {}): StrategyForm {
  return {
    name: 'MA cross',
    symbol: 'msft',
    timeframe: '5min',
    broker: 'ib',
    indicators: 'sma_20, sma_50',
    entry: [{ left: 'sma_20', op: 'crosses_above', right: 'sma_50' }],
    exit: [{ left: 'rsi', op: '>', right: '70' }],
    sizingType: 'fixed',
    sizingSize: '100',
    maxOrdersPerDay: '4',
    stopLossPct: '',
    ...overrides,
  };
}

describe('coerceOperand', () => {
  it('keeps identifiers as strings', () => {
    expect(coerceOperand('sma_20')).toBe('sma_20');
    expect(coerceOperand('position.size')).toBe('position.size');
  });
  it('converts pure numbers', () => {
    expect(coerceOperand('70')).toBe(70);
    expect(coerceOperand('-2.5')).toBe(-2.5);
  });
});

describe('buildDefinitionPayload', () => {
  it('serializes a valid form into the definitions payload', () => {
    const res = buildDefinitionPayload(form());
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      name: 'MA cross',
      symbol: 'MSFT',
      timeframe: '5min',
      broker: 'ib',
    });
    const rs = res.payload!.rule_set as Record<string, any>;
    expect(rs.entry).toEqual({ all: [{ left: 'sma_20', op: 'crosses_above', right: 'sma_50' }] });
    expect(rs.exit).toEqual({ any: [{ left: 'rsi', op: '>', right: 70 }] });
    expect(rs.sizing).toEqual({ type: 'fixed', unit: 'broker_default', size: 100 });
    expect(rs.risk).toEqual({ max_orders_per_day: 4 });
    expect(rs.indicators).toEqual(['sma_20', 'sma_50']);
  });

  it('drops incomplete condition rows', () => {
    const res = buildDefinitionPayload(
      form({
        entry: [
          { left: 'sma_20', op: '>', right: 'sma_50' },
          { left: '', op: '<', right: '' },
        ],
      })
    );
    expect(res.ok).toBe(true);
    const rs = res.payload!.rule_set as Record<string, any>;
    expect(rs.entry.all).toHaveLength(1);
  });

  it('omits exit + risk when empty', () => {
    const res = buildDefinitionPayload(form({ exit: [], maxOrdersPerDay: '0', stopLossPct: '' }));
    expect(res.ok).toBe(true);
    const rs = res.payload!.rule_set as Record<string, any>;
    expect(rs.exit).toBeUndefined();
    expect(rs.risk).toBeUndefined();
  });

  it('defaults instrument fields to STK/SMART/USD when omitted', () => {
    const res = buildDefinitionPayload(form());
    expect(res.payload).toMatchObject({ sec_type: 'STK', exchange: 'SMART', currency: 'USD' });
  });

  it('uppercases supplied instrument fields', () => {
    const res = buildDefinitionPayload(
      form({ secType: 'cash', exchange: 'idealpro', currency: 'usd', symbol: 'eur.usd' })
    );
    expect(res.payload).toMatchObject({
      symbol: 'EUR.USD',
      sec_type: 'CASH',
      exchange: 'IDEALPRO',
      currency: 'USD',
    });
  });

  it('includes stop_loss_pct when provided', () => {
    const res = buildDefinitionPayload(form({ stopLossPct: '2.5' }));
    const rs = res.payload!.rule_set as Record<string, any>;
    expect(rs.risk.stop_loss_pct).toBe(2.5);
  });

  it('rejects a form with no name', () => {
    const res = buildDefinitionPayload(form({ name: '  ' }));
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('Name is required');
  });

  it('rejects a form with no entry conditions', () => {
    const res = buildDefinitionPayload(form({ entry: [] }));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /entry condition/i.test(e))).toBe(true);
  });

  it('rejects a non-positive sizing size', () => {
    const res = buildDefinitionPayload(form({ sizingSize: '0' }));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /size/i.test(e))).toBe(true);
  });
});
