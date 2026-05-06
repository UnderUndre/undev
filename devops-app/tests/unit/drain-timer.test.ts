import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DrainTimerService } from "../../server/services/drain-timer.js";

describe("DrainTimerService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start fires onComplete after drainSeconds elapse", () => {
    const t = new DrainTimerService();
    const cb = vi.fn();
    t.start("app1", 30, cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_000);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_001);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.size()).toBe(0);
  });

  it("pause returns remainingMs and prevents onComplete", () => {
    const t = new DrainTimerService();
    const cb = vi.fn();
    t.start("app1", 30, cb);
    vi.advanceTimersByTime(12_000);
    const result = t.pause("app1");
    expect(result).not.toBeNull();
    expect(result?.remainingMs).toBeGreaterThan(17_000);
    expect(result?.remainingMs).toBeLessThanOrEqual(18_000);
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("resume fires onComplete after remainingMs", () => {
    const t = new DrainTimerService();
    const cb = vi.fn();
    t.resume("app1", 5_000, cb);
    vi.advanceTimersByTime(4_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("resume with remainingMs<=0 fires immediately", () => {
    const t = new DrainTimerService();
    const cb = vi.fn();
    t.resume("app1", 0, cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents onComplete", () => {
    const t = new DrainTimerService();
    const cb = vi.fn();
    t.start("app1", 30, cb);
    t.cancel("app1");
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(t.size()).toBe(0);
  });

  it("pause on missing app returns null", () => {
    const t = new DrainTimerService();
    expect(t.pause("nope")).toBeNull();
  });

  it("getRemainingMs returns null when no timer", () => {
    const t = new DrainTimerService();
    expect(t.getRemainingMs("nope")).toBeNull();
  });

  it("no leak after 1000 sequential start+complete cycles", () => {
    const t = new DrainTimerService();
    for (let i = 0; i < 1000; i++) {
      t.start(`app${i}`, 1, () => {});
      vi.advanceTimersByTime(1_001);
    }
    expect(t.size()).toBe(0);
  });
});
