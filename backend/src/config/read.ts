/**
 * Parsing helpers for settings read through `configService.asEnv()` (or any
 * environment-shaped record): unset or unparsable falls back to the default,
 * then the result is clamped. An explicit 0 is kept (where the minimum
 * allows it), so a start delay or a cache TTL can be turned off.
 */
export type EnvLike = Record<string, string | undefined>;

export function readInt(
  env: EnvLike,
  key: string,
  fallback: number,
  min: number,
  max = Number.POSITIVE_INFINITY
): number {
  const parsed = parseInt(env[key] ?? '', 10);
  return Math.min(max, Math.max(min, Number.isNaN(parsed) ? fallback : parsed));
}

export function readBool(env: EnvLike, key: string, fallback: boolean): boolean {
  const raw = (env[key] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return fallback ? raw !== 'false' : raw === 'true';
}

/** The setting values a caller actually passed (no deps or callbacks), so
 *  they override what `.env` and the Settings page say. */
export function definedOnly<T extends object>(opts: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(opts).filter(
      ([key, value]) => key !== 'deps' && value !== undefined && typeof value !== 'function'
    )
  ) as Partial<T>;
}
