import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Coalescing pattern (post Gemini-review fix 2026-04-28):
//   leading-edge alert at T+0 + trailing-edge summary at T+60s if count > 1.
// Lossless — operator gets immediate alert AND a flap summary.
describe("notifier coalescing (feature 006 T059/T060)", () => {
  let originalFetch: typeof fetch;
  let originalToken: string | undefined;
  let originalChat: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.TELEGRAM_BOT_TOKEN;
    originalChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
  });

  const payload = (
    appId = "app-1",
    transition: "to-unhealthy" | "to-healthy" = "to-unhealthy",
  ) => ({
    appId,
    appName: "myapp",
    serverLabel: "prod",
    transition,
    reason: "container died",
    deepLink: "/apps/app-1",
  });

  function lastBodyText(spy: ReturnType<typeof vi.fn>): string {
    const calls = spy.mock.calls;
    const lastCall = calls[calls.length - 1];
    if (lastCall === undefined) return "";
    const init = lastCall[1] as { body?: string } | undefined;
    if (init?.body === undefined) return "";
    const parsed = JSON.parse(init.body) as { text?: string };
    return parsed.text ?? "";
  }

  // (a) 2 identical events <60s → 1 leading send + 1 summary send with "+1 occurrences".
  it("two identical events <60s apart: leading send now + summary at T+60s with +1 occurrences", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload());
    await notifier.notifyAppHealthChange(payload());
    expect(fetchSpy).toHaveBeenCalledTimes(1); // leading only

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // leading + summary
    expect(lastBodyText(fetchSpy)).toContain("+1 occurrences");
    notifier.stop();
  });

  // (b) Events 61s apart: 2 distinct sends, neither carries the suffix.
  it("events 61s apart: two distinct leading sends, no summary suffix", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload());

    // First window's summary timer fires at T+60s — no summary because count==1.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await notifier.notifyAppHealthChange(payload());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(lastBodyText(fetchSpy)).not.toContain("occurrences");
    notifier.stop();
  });

  // (c) Same app + different transition: each transition gets its own leading send.
  it("different transitions for same app are not coalesced together", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload("app-1", "to-unhealthy"));
    await notifier.notifyAppHealthChange(payload("app-1", "to-healthy"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  // (d) Burst of 5 within window → 1 leading + 1 summary "+4 occurrences".
  it("+N suffix counts accurately for N=5 burst within window", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    for (let i = 0; i < 5; i++) {
      await notifier.notifyAppHealthChange(payload());
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1); // leading only
    expect(notifier.getCoalesceCount("app-1", "to-unhealthy")).toBe(5);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(lastBodyText(fetchSpy)).toContain("+4 occurrences");
    notifier.stop();
  });

  // (e) After window closes with count==1, the entry is fully evicted.
  it("single event in window: timer fires, no summary, entry cleared", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload());
    expect(notifier.getCoalesceCount("app-1", "to-unhealthy")).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no extra summary
    expect(notifier.getCoalesceCount("app-1", "to-unhealthy")).toBe(0);
    notifier.stop();
  });

  // (f) cert-expiring + caddy-unreachable are NOT subject to the dedup map.
  it("cert-expiring is NOT subject to the dedup map", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    const cert = {
      appId: "a",
      appName: "n",
      domain: "x.test",
      daysLeft: 7,
      windowDays: 7,
      expiresAtIso: new Date().toISOString(),
      lastRenewAtIso: null,
      certStatus: "active",
      deepLink: "/apps/a",
    };
    await notifier.notifyCertExpiring(cert);
    await notifier.notifyCertExpiring(cert);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  // (g) Different apps each get their own leading send (no cross-app coalescing).
  it("different apps are not coalesced together", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload("app-1"));
    await notifier.notifyAppHealthChange(payload("app-2"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });
});
