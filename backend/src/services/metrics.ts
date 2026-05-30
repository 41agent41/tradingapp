/**
 * Prometheus metrics (GAP_ANALYSIS §6).
 *
 * Default process metrics + an HTTP request duration histogram + a backtest
 * persistence counter. Scraped at `GET /metrics` by Prometheus / Grafana
 * Agent / similar.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
