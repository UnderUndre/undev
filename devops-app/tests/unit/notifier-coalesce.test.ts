import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

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
    // Reset module cache so a fresh notifier instance is created.
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
  });

  const payload = (appId = "app-1", transition: "to-unhealthy" | "to-healthy" = "to-unhealthy") => ({
    appId,
    appName: "myapp",
    serverLabel: "prod",
    transition,
    reason: "container died",
    deepLink: "/apps/app-1",
  });

  it("identical payloads within 60s collapse into one fetch", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload());
    await notifier.notifyAppHealthChange(payload());
    await notifier.notifyAppHealthChange(payload());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(notifier.getCoalesceCount("app-1", "to-unhealthy")).toBe(3);
    notifier.stop();
  });

  it("different transitions for same app are not coalesced together", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload("app-1", "to-unhealthy"));
    await notifier.notifyAppHealthChange(payload("app-1", "to-healthy"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("different apps are not coalesced together", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyAppHealthChange(payload("app-1"));
    await notifier.notifyAppHealthChange(payload("app-2"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("cert-expiring is NOT subject to the dedup map", async () => {
    const { notifier } = await import("../../server/services/notifier.js");
    await notifier.notifyCertExpiring({
      appId: "a",
      appName: "n",
      domain: "x.test",
      daysLeft: 7,
      windowDays: 7,
      expiresAtIso: new Date().toISOString(),
      lastRenewAtIso: null,
      certStatus: "active",
      deepLink: "/apps/a",
    });
    await notifier.notifyCertExpiring({
      appId: "a",
      appName: "n",
      domain: "x.test",
      daysLeft: 7,
      windowDays: 7,
      expiresAtIso: new Date().toISOString(),
      lastRenewAtIso: null,
      certStatus: "active",
      deepLink: "/apps/a",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });
});
