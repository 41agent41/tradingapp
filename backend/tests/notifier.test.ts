/**
 * Tests for operational alerting (Component E — §8).
 *
 * Deduplication is the substance here. These alerts fire from a loop that runs
 * every bar, so an ongoing condition is true again 60 seconds later. A channel
 * that repeats itself gets muted, and a muted channel is worse than none
 * because it looks like coverage.
 */
import { Notifier, type Alert, type NotificationChannel } from '../src/services/notifier.js';

function fakeChannel(fail = false): NotificationChannel & { sent: Alert[] } {
  const sent: Alert[] = [];
  return {
    name: 'fake',
    sent,
    async send(alert: Alert) {
      if (fail) throw new Error('channel down');
      sent.push(alert);
    },
  };
}

const alert = (key = 'k1'): Alert => ({ key, severity: 'critical', title: 'Something happened' });

describe('Notifier', () => {
  it('delivers an alert', async () => {
    const channel = fakeChannel();
    const result = await new Notifier({ channels: [channel] }).notify(alert());
    expect(result.sent).toBe(true);
    expect(channel.sent).toHaveLength(1);
  });

  it('suppresses a repeat of the same key inside the window', async () => {
    const channel = fakeChannel();
    const n = new Notifier({ channels: [channel], dedupeSeconds: 3600 });

    await n.notify(alert());
    const second = await n.notify(alert());

    expect(second).toEqual({ sent: false, reason: 'deduplicated' });
    expect(channel.sent).toHaveLength(1);
    expect(n.suppressed).toBe(1);
  });

  it('sends again once the dedupe window has passed', async () => {
    const channel = fakeChannel();
    let now = 0;
    const n = new Notifier({ channels: [channel], dedupeSeconds: 60, now: () => now });

    await n.notify(alert());
    now = 61_000;
    await n.notify(alert());

    expect(channel.sent).toHaveLength(2);
  });

  it('does not suppress different keys', async () => {
    const channel = fakeChannel();
    const n = new Notifier({ channels: [channel] });

    await n.notify(alert('a'));
    await n.notify(alert('b'));

    expect(channel.sent).toHaveLength(2);
  });

  it('rate-limits a novel failure producing a new key every bar', async () => {
    // Dedup alone would not help: each key is new.
    const channel = fakeChannel();
    const n = new Notifier({ channels: [channel], maxPerWindow: 3 });

    for (let i = 0; i < 10; i++) await n.notify(alert(`key-${i}`));

    expect(channel.sent).toHaveLength(3);
    expect(n.suppressed).toBe(7);
  });

  it('lets a resolved condition alert again immediately', async () => {
    const channel = fakeChannel();
    const n = new Notifier({ channels: [channel], dedupeSeconds: 3600 });

    await n.notify(alert());
    n.resolve('k1');
    await n.notify(alert());

    expect(channel.sent).toHaveLength(2);
  });

  it('never throws when a channel fails', async () => {
    // An operator with a broken notifier and a working trading system is in a
    // much better position than the reverse.
    const n = new Notifier({ channels: [fakeChannel(true)] });
    const result = await n.notify(alert());

    expect(result.sent).toBe(false);
    expect(n.failures).toBe(1);
  });

  it('does not record a dedupe entry for an alert that failed to send', async () => {
    // Otherwise a transient outage silently suppresses the condition for the
    // whole dedupe window.
    const failing = fakeChannel(true);
    const n = new Notifier({ channels: [failing], dedupeSeconds: 3600 });

    await n.notify(alert());
    const working = fakeChannel();
    const n2 = new Notifier({ channels: [working], dedupeSeconds: 3600 });
    await n2.notify(alert());

    expect(working.sent).toHaveLength(1);
  });

  it('reports itself disabled with no channel configured', async () => {
    const n = new Notifier({ channels: [] });
    expect(n.enabled).toBe(false);
    expect(await n.notify(alert())).toEqual({ sent: false, reason: 'no channel configured' });
  });
});
