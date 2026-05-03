# Notification Channel Contract

**Date**: 2026-05-03 | **Branch**: `011-zero-touch-onboarding` | **Plan**: [../plan.md](../plan.md)

This is the operational contract for `notification-gate.ts` — the unified
gate that sits between event emitters and the TG send path. Defines the
interface, the dispatch flow, retry classification, and audit-event
shapes per drop reason.

---

## Public interface

```ts
// notification-gate.ts

export interface DispatchInput {
  /** Canonical event identifier (must exist in EVENT_CATALOGUE) */
  eventType: string;
  /** Resource being acted on — typically `serverId` or `appId`. Used for
   *  per-pair cooldown keys. */
  resourceId: string;
  /** Lazy formatter — invoked only if the event will actually be sent.
   *  Receives the suppression count (0 = first/sole, N = "+N suppressed")
   *  so it can append the suffix in the right place. */
  payloadFormatter: (suppressedCount: number) => string;
}

export type DispatchResult =
  | { delivered: true; messageId: number }
  | { delivered: false; reason: DropReason };

export type DropReason =
  | "telegram_unconfigured"
  | "preferences_disabled"
  | "throttled_cooldown"
  | "throttled_token_bucket"
  | "delivery_failed_transient"   // 3 retries exhausted
  | "delivery_failed_permanent";  // 4xx that we recognise

export interface NotificationGate {
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}

export const gate: NotificationGate;     // singleton instance
```

The `NotificationChannel` interface mentioned in spec FR-033 lives as a
private type inside `notification-gate.ts` — single implementation
(`TelegramChannel`) is inlined; v2 splits it out when adding a second
channel. The gate's *external* API is what callers depend on; the
*internal* channel abstraction is implementation detail.

---

## Dispatch flow

```
                   ┌────────────────────────┐
DispatchInput ────▶│ gate.dispatch()         │
                   └───────────┬────────────┘
                               ▼
            ┌───────────────────────────────────────┐
            │ 1. Catalogue check                    │
            │    EVENT_CATALOGUE.has(eventType)?    │
            └───────────┬─────────────────┬─────────┘
                        │ no              │ yes
                        ▼                 │
                 ignore silently          ▼
                 (orphan event)   ┌──────────────────────┐
                                  │ 2. Preferences check  │
                                  │    notification_prefs │
                                  │    [eventType].enabled│
                                  └─────┬──────────┬──────┘
                                        │ false    │ true
                                        ▼          │
                              audit:               │
                              preferences_disabled │
                              (no audit row, just  │
                              return)              │
                                                   ▼
                                  ┌──────────────────────────┐
                                  │ 3. TG configured?         │
                                  │    last_test_ok = TRUE,   │
                                  │    token + chat_id != null│
                                  └─────┬──────────────┬──────┘
                                        │ no           │ yes
                                        ▼              │
                            audit:                     │
                            notification.dropped       │
                              .telegram_unconfigured   │
                            return {delivered:false}   │
                                                       ▼
                                  ┌──────────────────────────┐
                                  │ 4. Per-pair cooldown      │
                                  │    pairKey = `${et}::${r}`│
                                  │    last send < 5 min ago? │
                                  └─────┬──────────────┬──────┘
                                        │ yes          │ no
                                        ▼              │
                            increment                  │
                            suppressedSinceLastSend    │
                            audit:                     │
                            notification.dropped       │
                              .throttled (cooldown)    │
                            return {delivered:false}   │
                                                       ▼
                                  ┌──────────────────────────┐
                                  │ 5. Global token bucket    │
                                  │    refill(); tokens >= 1? │
                                  └─────┬──────────────┬──────┘
                                        │ no           │ yes
                                        ▼              │
                            audit:                     │
                            notification.dropped       │
                              .throttled (bucket)      │
                            return {delivered:false}   │
                                                       ▼
                                  ┌──────────────────────────┐
                                  │ 6. Format payload         │
                                  │    text = formatter(N)    │
                                  │    (N from cooldown entry)│
                                  └────────────┬─────────────┘
                                               ▼
                                  ┌──────────────────────────┐
                                  │ 7. TelegramChannel.send   │
                                  │    POST /sendMessage      │
                                  └────────────┬─────────────┘
                                               ▼
                                  ┌──────────────────────────┐
                                  │ 8. Classify response      │
                                  └──┬─────────┬──────────┬──┘
                                     │success  │transient │permanent
                                     ▼         ▼          ▼
                       audit: success    retry up to 3x  audit:
                       reset cooldown    with backoff,   notification.dropped
                       counter,          then if still   .delivery_failed
                       consume token     fail → audit    + flip
                       return            transient drop  last_test_ok=false
                       {delivered:true}                  return drop
```

---

## Retry classification

Implementation of FR-041. Lives as `classifyTelegramResponse(resp)` in
`notification-gate.ts`.

```ts
type Classification =
  | { kind: "success" }
  | { kind: "transient"; reason: string; retryAfterMs?: number }
  | { kind: "permanent"; reason: string; tgErrorCode?: number; tgErrorDescription?: string };

function classifyTelegramResponse(
  status: number,
  body: { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null,
  err: Error | null,
): Classification {
  if (err !== null) {
    // Network / timeout / DNS
    return { kind: "transient", reason: "network_error" };
  }
  if (status >= 200 && status < 300 && body?.ok === true) {
    return { kind: "success" };
  }
  if (status === 429) {
    const retryAfterSec = body?.parameters?.retry_after ?? 1;
    return { kind: "transient", reason: "rate_limit", retryAfterMs: retryAfterSec * 1000 };
  }
  if (status >= 500) {
    return { kind: "transient", reason: "server_error" };
  }
  // 400, 401, 403, 404 — permanent
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return {
      kind: "permanent",
      reason: status === 401 ? "unauthorized"
            : status === 403 ? "forbidden"
            : status === 404 ? "chat_not_found"
            : "bad_request",
      tgErrorCode: body?.error_code,
      tgErrorDescription: body?.description,
    };
  }
  // Unknown 4xx — treat as permanent (safer than infinite retry)
  return { kind: "permanent", reason: "unknown_4xx", tgErrorCode: body?.error_code };
}
```

Retry schedule (transient): attempt at 0s, ~1s, ~4s, ~16s. Total
worst-case 21s before final transient drop. Backoff implementation:

```ts
const TRANSIENT_BACKOFFS_MS = [1_000, 4_000, 16_000];

async function deliverWithRetry(token: string, chatId: string, text: string): Promise<DispatchOutcome> {
  let lastClass: Classification | null = null;
  for (let attempt = 0; attempt <= TRANSIENT_BACKOFFS_MS.length; attempt++) {
    const cls = await sendOnce(token, chatId, text);
    if (cls.kind === "success") return { ok: true, attempts: attempt + 1 };
    if (cls.kind === "permanent") return { ok: false, classification: cls, attempts: attempt + 1 };
    lastClass = cls;
    if (attempt < TRANSIENT_BACKOFFS_MS.length) {
      const wait = cls.retryAfterMs ?? TRANSIENT_BACKOFFS_MS[attempt];
      await sleep(wait);
    }
  }
  return { ok: false, classification: lastClass!, attempts: TRANSIENT_BACKOFFS_MS.length + 1 };
}
```

---

## Audit event shapes

Per drop reason — written by gate BEFORE returning to caller (FR-032
unconditionality + FR-040/043 traceability).

### `notification.dropped.telegram_unconfigured`

```json
{
  "action": "notification.dropped.telegram_unconfigured",
  "actor": "system",
  "payload": {
    "eventType": "deploy.failed",
    "resourceId": "app_xyz789"
  }
}
```

### `notification.dropped.throttled`

```json
{
  "action": "notification.dropped.throttled",
  "actor": "system",
  "payload": {
    "eventType": "healthcheck.degraded",
    "resourceId": "app_xyz789",
    "reason": "cooldown",
    "suppressedCount": 12,
    "windowExpiresAt": "2026-05-03T14:35:22.123Z"
  }
}
```

`reason` is `"cooldown"` or `"token_bucket"`.

### `notification.dropped.delivery_failed`

```json
{
  "action": "notification.dropped.delivery_failed",
  "actor": "system",
  "payload": {
    "eventType": "server.added",
    "resourceId": "srv_abc123",
    "httpStatus": 403,
    "tgErrorCode": 403,
    "tgErrorDescription": "Forbidden: bot was kicked from the supergroup chat",
    "retryCount": 1,
    "classification": "permanent",
    "reason": "forbidden"
  }
}
```

For transient final-failure, `classification: "transient"` and `reason:
"network_error" | "server_error" | "rate_limit"`.

### `notification.settings_changed`

```json
{
  "action": "notification.settings_changed",
  "actor": "user_42",
  "payload": {
    "field": "telegram_bot_token",
    "previousState": "configured",
    "newState": "configured"
  }
}
```

Or for event toggle:

```json
{
  "action": "notification.settings_changed",
  "actor": "user_42",
  "payload": {
    "field": "event_preference",
    "eventType": "deploy.succeeded",
    "previousEnabled": false,
    "newEnabled": true
  }
}
```

**NEVER in payload**: bot token (encrypted or plain), chat_id values
(field name only), env_var values, decrypted SSH keys.

---

## Suppression counter semantics

Per FR-039, the counter is incremented on every cooldown drop. When the
window expires and the next event of the pair fires:

```
At T=0:00:  event A1 fires → delivered, set firstSendAt=0:00, counter=0
At T=0:30:  event A2 fires → cooldown, counter=1, audit drop
At T=1:15:  event A3 fires → cooldown, counter=2
At T=2:00:  event A4 fires → cooldown, counter=3
At T=4:59:  event A5 fires → cooldown, counter=4
At T=5:01:  event A6 fires → window expired, formatter(suppressedCount=4) → text includes "(4 similar events suppressed in the last 5 min)"
            → delivered, reset firstSendAt=5:01, counter=0
At T=5:30:  event A7 fires → cooldown, counter=1 (new window)
```

The `payloadFormatter(suppressedCount)` callback receives the counter so
the caller controls *where* in the message text the suffix appears. Most
formatters will append; some (e.g. cert-expiring) may want to prepend.

**Edge case**: gate must call the formatter EVERY time (to maintain the
pure-function contract), but only consume the result on the delivery
path. Cooldown drops do NOT call the formatter (saves work for high-volume
flapping).

Wait — clarification: looking again, formatter should be called only
when delivery is happening. The lazy contract is:

```ts
// Inside gate.dispatch:
if (cooldownActive) { audit drop; return; /* formatter NEVER called */ }
if (bucketEmpty)    { audit drop; return; /* formatter NEVER called */ }
// Past here: delivery is happening
const text = input.payloadFormatter(suppressedSinceLastSend);
const result = await deliverWithRetry(token, chatId, text);
if (result.ok) {
  // Reset counter, refresh firstSendAt
  cooldownEntry.suppressedSinceLastSend = 0;
  cooldownEntry.firstSendAt = Date.now();
}
```

Lazy formatter saves per-event payload-formatting cost during
flapping bursts — only invoked when the message actually leaves the
process.

---

## Token bucket math

```
BUCKET_MAX = 20
BUCKET_REFILL_PER_MIN = 20  (i.e. 1 token per 3000 ms)

On each dispatch (token consumed BEFORE the attempt — per github P1 #2):
  elapsed = now - lastRefillAt
  refilled = floor(elapsed / 3000)  // integer tokens added since last calc
  tokens = min(BUCKET_MAX, tokens + refilled)
  lastRefillAt += refilled * 3000
  if (tokens >= 1) {
    tokens -= 1                      // consumed regardless of TG outcome
    return { allow: true }
  } else {
    return { allow: false, reason: "token_bucket" }
  }
```

**Consume-on-attempt semantics (clarified per github P1 #2)**: the token
is decremented BEFORE the TG send, not after a successful 200. Reason:
if the bucket only counted successful deliveries, a TG-down period
(every send returns 5xx and gets retried up to 3 times) would let the
gate burn through unbounded API calls — defeating the global rate cap.
Failed attempts (transient retries, permanent errors) still count.
Retries within the per-call backoff sequence DO NOT each consume a token
— they're considered part of one logical dispatch attempt.

The refill is *event-driven* — no background timer. Calculation cost is
O(1) per dispatch; no lock needed since notification-gate is a singleton
within a single Node event loop (A-007 single-instance).

## Memory hygiene — cooldown Map sweeper (per gemini #2)

The per-pair cooldown state lives in `Map<pairKey, CooldownEntry>`. Without
maintenance, the Map grows unboundedly over the dashboard's lifetime
(typically months between restarts) — every `(eventType, resourceId)`
pair that ever fired stays in memory, even after the resource is deleted.

**Sweeper**: a `setInterval` running once per hour walks the Map and
removes entries whose `firstSendAt < now - COOLDOWN_WINDOW_MS` (i.e. the
cooldown window has fully elapsed AND any suppression count is no longer
relevant). The interval is `unref()`'d so it doesn't keep the process
alive on graceful shutdown.

```ts
// notification-gate.ts internal
const SWEEPER_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
private sweeperTimer = setInterval(() => this.sweep(), SWEEPER_INTERVAL_MS);
constructor() { this.sweeperTimer.unref(); }

private sweep(): void {
  const cutoff = Date.now() - COOLDOWN_WINDOW_MS;
  for (const [key, entry] of this.cooldownState) {
    if (entry.firstSendAt < cutoff) this.cooldownState.delete(key);
  }
}

stop(): void { clearInterval(this.sweeperTimer); this.cooldownState.clear(); }
```

Same pattern as existing `notifier.ts` `sweepCoalesce` (precedent). Test
in `notification-gate-cooldown.test.ts` (T066) covers it: insert 1000
synthetic entries with `firstSendAt = 0`, advance virtual time past
cutoff, fire sweeper, assert Map is empty.

---

## Configuration

All thresholds are CONSTANTS in `notification-gate.ts`:

```ts
export const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;   // FR-038
export const BUCKET_MAX = 20;                       // FR-038
export const BUCKET_REFILL_PER_MIN = 20;            // FR-038
export const TRANSIENT_BACKOFFS_MS = [1_000, 4_000, 16_000];  // FR-041
```

Not exposed via API in v1 (per spec Out of Scope).
Tests can override via module-private setters
(`__setCooldownWindowForTests(ms)`) to keep test runs fast — pattern
established by feature 006 health-poller tests.

---

## Existing notifier.ts adapter pattern

Existing leaf methods become 5-line wrappers:

```ts
// notifier.ts (modified)
async notifyAppHealthChange(payload: AppHealthChangePayload): Promise<DispatchResult> {
  return gate.dispatch({
    eventType: payload.transition === "to-unhealthy" ? "healthcheck.degraded" : "healthcheck.recovered",
    resourceId: payload.appId,
    payloadFormatter: (suppressed) => this.formatAppHealthChange(payload, suppressed),
  });
}
```

The formatAppHealthChange method (existing) receives the suppressed count
instead of an `occurrences` count — same shape, different interpretation.

The 60s sliding-window coalesce (existing in notifier.ts) is REMOVED
when the gate ships — gate's per-pair cooldown supersedes it. This is a
deliberate simplification: one throttling layer, not two.

---

## Test connection bypass

`POST /api/settings/notifications/telegram/test` calls `TelegramChannel.send`
DIRECTLY — bypasses the gate entirely. Reason: a test message must work
even when no event preferences are enabled (otherwise operator can't
verify config without enabling at least one event). Bypass is
implementation-internal; not exposed via the gate's public API.

```ts
// notification-settings-store.ts
async testConnection(): Promise<TestResult> {
  const settings = await this.load();
  if (!settings.telegramBotTokenEncrypted || !settings.telegramChatId) {
    return { ok: false, classification: "unconfigured" };
  }
  const token = open(settings.telegramBotTokenEncrypted);
  const text = `🔧 Dashboard test connection at ${new Date().toISOString()}`;
  // Single attempt — no retry on Test, operator sees raw error fast
  const cls = await this.telegramChannel.sendOnce(token, settings.telegramChatId, text);
  await this.recordTestOutcome(cls.kind === "success", cls);
  return cls.kind === "success"
    ? { ok: true, testedAt: new Date().toISOString() }
    : { ok: false, classification: cls.kind === "transient" ? "transient" : "permanent",
        httpStatus: ..., tgErrorCode: ..., tgErrorDescription: ... };
}
```
