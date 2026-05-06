/**
 * Feature 012 T025 — in-memory drain timer manager per research.md R-005.
 *
 * Map<appId, TimerEntry>. setTimeout().unref() so the dashboard process
 * can exit cleanly. On dashboard restart, all timers are lost; affected
 * deploys surface via interrupted-deploys panel.
 */

import { logger } from "../lib/logger.js";

interface TimerEntry {
  handle: NodeJS.Timeout;
  expectedEndAt: number;
}

export class DrainTimerService {
  private timers = new Map<string, TimerEntry>();

  start(appId: string, drainSeconds: number, onComplete: () => void): void {
    this.cancel(appId); // safety — replace any prior timer
    const ms = Math.max(0, drainSeconds * 1000);
    const handle = setTimeout(() => {
      this.timers.delete(appId);
      try {
        onComplete();
      } catch (err) {
        logger.error({ ctx: "drain-timer", appId, err }, "onComplete threw");
      }
    }, ms);
    handle.unref();
    this.timers.set(appId, { handle, expectedEndAt: Date.now() + ms });
  }

  pause(appId: string): { remainingMs: number } | null {
    const entry = this.timers.get(appId);
    if (!entry) return null;
    clearTimeout(entry.handle);
    this.timers.delete(appId);
    return { remainingMs: Math.max(0, entry.expectedEndAt - Date.now()) };
  }

  resume(appId: string, remainingMs: number, onComplete: () => void): void {
    if (remainingMs <= 0) {
      onComplete();
      return;
    }
    this.cancel(appId);
    const handle = setTimeout(() => {
      this.timers.delete(appId);
      try {
        onComplete();
      } catch (err) {
        logger.error({ ctx: "drain-timer", appId, err }, "onComplete threw on resume");
      }
    }, remainingMs);
    handle.unref();
    this.timers.set(appId, { handle, expectedEndAt: Date.now() + remainingMs });
  }

  cancel(appId: string): void {
    const entry = this.timers.get(appId);
    if (entry) clearTimeout(entry.handle);
    this.timers.delete(appId);
  }

  getRemainingMs(appId: string): number | null {
    const entry = this.timers.get(appId);
    if (!entry) return null;
    return Math.max(0, entry.expectedEndAt - Date.now());
  }

  /** For diagnostics / leak audits. */
  size(): number {
    return this.timers.size;
  }
}

export const drainTimer = new DrainTimerService();
