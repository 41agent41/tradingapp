/**
 * Runs a job once a day at a fixed UTC time. A failure is logged and the job
 * runs again the next day.
 */
import { logger } from './logger.js';

const DAY_MS = 86_400_000;

/** Milliseconds from `now` to the next `hour:minute` UTC, never 0. */
export function msUntilUtc(hour: number, minute: number, now = Date.now()): number {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  return at > now ? at - now : at + DAY_MS - now;
}

export class DailyJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hour: number,
    private readonly minute: number,
    private readonly job: () => Promise<unknown>
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.job()
          .catch((err) => logger.warn({ err: String(err) }, 'daily job failed'))
          .finally(() => this.start());
      },
      msUntilUtc(this.hour, this.minute)
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
