/**
 * Prometheus metrics (GAP_ANALYSIS §6).
 *
 * Default process metrics + an HTTP request duration histogram + a backtest
 * persistence counter. Scraped at `GET /metrics` by Prometheus / Grafana
 * Agent / similar.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'backend' });
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labelled by method/route/status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const backtestRunsPersisted = new Counter({
  name: 'backtest_runs_persisted_total',
  help: 'Backtest runs successfully persisted to Postgres',
  labelNames: ['strategy', 'symbol'],
  registers: [registry],
});

// --------------------------------------------------------------------------- //
// Fleet metrics (Component C — C-5)
// --------------------------------------------------------------------------- //
//
// Every one of these is labelled by **connection**, not by platform. That is
// the whole point of the component: "MT5 is up" is not a useful statement when
// three MT5 accounts are trading and one of them is wedged at a login dialog.
//
// Gauges rather than counters where the question is "what is true right now?"
// — an operator looking at a dashboard at 3am wants current state, and a
// counter forces them to reason about rates to recover it.

export const connectionUp = new Gauge({
  name: 'tradingapp_connection_up',
  help: '1 when a connection responded on the last health check, 0 otherwise',
  labelNames: ['connection', 'platform', 'account', 'account_mode'],
  registers: [registry],
});

export const connectionBreakerOpen = new Gauge({
  name: 'tradingapp_connection_breaker_open',
  help: '1 when the runner is skipping a connection after repeated failures',
  labelNames: ['connection'],
  registers: [registry],
});

export const connectionActiveRuns = new Gauge({
  name: 'tradingapp_connection_active_runs',
  help: 'Strategy runs currently evaluating on a connection',
  labelNames: ['connection'],
  registers: [registry],
});

export const connectionPositionDivergence = new Gauge({
  name: 'tradingapp_connection_position_divergence',
  help: 'Runs on a connection whose venue and fills-derived positions disagree',
  labelNames: ['connection'],
  registers: [registry],
});

export const unprotectedPositions = new Gauge({
  name: 'tradingapp_unprotected_positions',
  help: 'Open positions with no protective stop at the venue',
  labelNames: ['connection'],
  registers: [registry],
});

export const killSwitchTriggers = new Counter({
  name: 'tradingapp_kill_switch_triggers_total',
  help: 'Kill-switch triggers fired, by kind',
  labelNames: ['connection', 'kind'],
  registers: [registry],
});

export const ordersBlockedByCap = new Counter({
  name: 'tradingapp_orders_blocked_by_cap_total',
  help: 'Orders a risk cap refused, by the level that refused them',
  labelNames: ['connection', 'level'],
  registers: [registry],
});

export const stopsTightened = new Counter({
  name: 'tradingapp_stops_tightened_total',
  help: 'Trailing-stop modifications accepted by a venue',
  labelNames: ['connection'],
  registers: [registry],
});
