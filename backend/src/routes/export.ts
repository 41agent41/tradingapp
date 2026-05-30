/**
 * Tabular data export routes.
 *
 *   POST /api/export/parquet — accepts a `{ columns, rows }` payload and
 *     streams back an Apache Parquet binary the caller can download.
 *
 * The route lives in the backend (not in the IB service) so we don't have
 * to ship pyarrow into the IB container or expose a Parquet endpoint that
 * is anything more than a pure serialiser. The frontend collects the
 * already-rendered rows from `DataframeViewer` and POSTs them here.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { logger } from '../services/logger.js';

const router = express.Router();

export type ColumnType = 'string' | 'number' | 'date' | 'currency' | 'boolean';

export interface ExportColumn {
  key: string;
  label?: string;
  type: ColumnType;
}

interface ExportRequestBody {
  filename?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
}

const MAX_ROWS = 200_000;
const MAX_COLS = 256;

/**
 * Translate a logical Column type into the parquetjs schema fragment.
 * Numbers and currencies share the DOUBLE path; dates land as
 * TIMESTAMP_MILLIS so common analytics tools recognise them.
 */
function schemaFragment(col: ExportColumn): Record<string, unknown> {
  switch (col.type) {
    case 'number':
    case 'currency':
      return { type: 'DOUBLE', optional: true };
    case 'date':
      return { type: 'TIMESTAMP_MILLIS', optional: true };
    case 'boolean':
      return { type: 'BOOLEAN', optional: true };
    case 'string':
    default:
      return { type: 'UTF8', optional: true };
  }
}

/**
 * Coerce a raw cell value into something parquetjs will accept for the
 * column's type. Returns `null` for missing / unparseable values so the
 * row stays writable but the cell is empty downstream.
 */
export function coerce(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number':
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'date': {
      if (value instanceof Date) return value;
      if (typeof value === 'number') {
        // Heuristic shared with DataframeViewer: large values are ms,
        // smaller ones are unix seconds.
        const ms = value > 1_000_000_000_000 ? value : value * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      if (typeof value === 'string') {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    }
    case 'boolean':
      return Boolean(value);
    case 'string':
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

router.post('/parquet', async (req: Request, res: Response) => {
  const { columns, rows, filename } = (req.body ?? {}) as ExportRequestBody;

  if (!Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'columns must be a non-empty array' });
  }
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows must be an array' });
  }
  if (columns.length > MAX_COLS) {
    return res.status(413).json({ error: `too many columns (${columns.length} > ${MAX_COLS})` });
  }
  if (rows.length > MAX_ROWS) {
    return res.status(413).json({ error: `too many rows (${rows.length} > ${MAX_ROWS})` });
  }

  // Validate each column declaration.
  for (const col of columns) {
    if (!col || typeof col.key !== 'string' || col.key.length === 0) {
      return res.status(400).json({ error: 'every column must have a string `key`' });
    }
  }

  try {
    // @dsnp/parquetjs has no .d.ts shipped, so we type the import locally
    // rather than letting `any` leak across the route boundary.
    const parquet = (await import('@dsnp/parquetjs')) as unknown as {
      ParquetSchema: new (def: Record<string, unknown>) => unknown;
      ParquetWriter: {
        openStream(schema: unknown, stream: NodeJS.WritableStream): Promise<{
          appendRow(row: Record<string, unknown>): Promise<void>;
          close(): Promise<void>;
        }>;
      };
    };

    const schemaDef: Record<string, unknown> = {};
    for (const col of columns) schemaDef[col.key] = schemaFragment(col);
    const schema = new parquet.ParquetSchema(schemaDef);

    const safeFilename =
      typeof filename === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(filename)
        ? filename
        : `export_${new Date().toISOString().split('T')[0]}.parquet`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    const writer = await parquet.ParquetWriter.openStream(schema, res);
    for (const row of rows) {
      const projected: Record<string, unknown> = {};
      for (const col of columns) projected[col.key] = coerce(row[col.key], col.type);
      await writer.appendRow(projected);
    }
    await writer.close();
  } catch (err) {
    logger.error({ err: String(err) }, 'parquet export failed');
    // Headers may already be flushed once openStream has run; in that case
    // we can't change the status. Best-effort error report:
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to encode Parquet',
        detail: err instanceof Error ? err.message : 'unknown',
        timestamp: new Date().toISOString(),
      });
    } else {
      res.end();
    }
  }
});

export default router;
