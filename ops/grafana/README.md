# TradingApp Grafana dashboards

This directory holds the Grafana dashboards that visualise the Prometheus
metrics shipped by the backend (`pino` + `prom-client`) and the IB service
(`structlog` + `prometheus_fastapi_instrumentator`).

## Dashboards

- [`tradingapp-dashboard.json`](tradingapp-dashboard.json) — the
  *TradingApp Overview* board. Three rows: **Backend**, **IB Service**,
  **Process**. Each row covers request rate, p95 latency and error rate
  for that service, plus a backtest-runs-persisted indicator and process
  metrics (RSS, CPU, event-loop lag).

## Importing into Grafana

1. Bring up Prometheus and have it scrape the two `/metrics` endpoints —
   `http://backend:4000/metrics` and `http://ib_service:8000/metrics`. A
   minimal scrape job:

   ```yaml
   scrape_configs:
     - job_name: tradingapp-backend
       static_configs:
         - targets: ['backend:4000']
       metrics_path: /metrics
     - job_name: tradingapp-ib_service
       static_configs:
         - targets: ['ib_service:8000']
       metrics_path: /metrics
   ```

2. In Grafana, **Dashboards → New → Import**, paste the JSON file (or
   upload it), pick your Prometheus datasource for the
   `DS_PROMETHEUS` template variable, and save.

## Metric reference

These are the metrics the dashboard panels rely on. They are emitted by
the code referenced in each row.

| Metric | Source | Emitter |
|---|---|---|
| `http_request_duration_seconds` (Histogram) | backend | `backend/src/services/metrics.ts` |
| `http_request_duration_seconds_count` (Counter) | backend | same |
| `backtest_runs_persisted_total` (Counter) | backend | `backend/src/routes/backtesting.ts` |
| `process_*`, `nodejs_*` | backend | `prom-client` defaults |
| `http_requests_total` (Counter) | ib_service | `prometheus_fastapi_instrumentator` |
| `http_request_duration_seconds` (Histogram) | ib_service | same |

All series carry a `service=` label (`backend` for prom-client,
auto-tagged by Prometheus's job label otherwise) so the panels can
distinguish.
