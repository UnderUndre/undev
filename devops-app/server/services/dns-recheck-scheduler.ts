/**
 * Feature 008 T064 — in-process DNS double-verify scheduler (FR-014a).
 *
 * Holds setTimeout handles per certId so that:
 *   (a) cancellation (T067 endpoint) clears the timeout cleanly
 *   (b) duplicate scheduling for the same cert is rejected
 *
 * V1 is in-memory — restart loses pending recheck timers; operator can
 * re-submit via Force renew. v2 nicety: persist via a delayed-job queue.
 */

const timers = new Map<string, NodeJS.Timeout>();

export function scheduleDnsRecheck(certId: string, ms: number, fn: () => void): void {
  const existing = timers.get(certId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(certId);
    fn();
  }, ms);
  t.unref();
  timers.set(certId, t);
}

export function cancelDnsRecheck(certId: string): boolean {
  const existing = timers.get(certId);
  if (!existing) return false;
  clearTimeout(existing);
  timers.delete(certId);
  return true;
}

export function hasPendingRecheck(certId: string): boolean {
  return timers.has(certId);
}

export function __resetForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
