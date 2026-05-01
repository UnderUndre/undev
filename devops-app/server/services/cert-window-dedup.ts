/**
 * Feature 006 T046 — windowed cert-expiry alert dedup (FR-015a + R-007).
 *
 * Cross-spec READ + WRITE boundary with feature 008's `app_cert_events` table.
 * Until 008 ships, the wiring is via dependency-injection hooks: the caller
 * (poller) supplies `hasExpiryAlert` + `recordExpiryAlert` closures. Default
 * no-op hooks make this safe to invoke before 008 lands — every alert simply
 * fires (no dedup). When 008 ships it wires real Drizzle/SQL implementations.
 *
 * Lifecycle semantics:
 *   - `lifecycle_start = MAX(occurred_at) WHERE event_type IN ('issued','renewed')`.
 *   - For window W in {14,7,3,1}, fire at most ONCE per (cert_id, W) since
 *     `lifecycle_start`. Subsequent ticks within the same window are silent.
 *   - Renewal resets the lifecycle — next ≤14d crossing fires again.
 *   - Recovery (cert renewed) is silent per FR-015a — no positive-ack message.
 *
 * Window selection: pick the SMALLEST window that contains `daysLeft`. Order:
 *   daysLeft ≤ 1  → window 1
 *   daysLeft ≤ 3  → window 3
 *   daysLeft ≤ 7  → window 7
 *   daysLeft ≤ 14 → window 14
 *   else          → no alert (returns null).
 *
 * Rationale for "smallest": at daysLeft=6 we want window=7 (7 has not been
 * fired since lifecycle_start yet); at daysLeft=2 we want window=3; etc.
 */

export const CERT_ALERT_WINDOWS = [1, 3, 7, 14] as const;
export type CertAlertWindow = (typeof CERT_ALERT_WINDOWS)[number];

export interface CertWindowDedupDeps {
  /**
   * Returns true if an `expiry_alert` row exists for `(certId, window)` with
   * `occurred_at >= lifecycle_start`. Default: always false (no dedup).
   */
  hasExpiryAlert?: (certId: string, window: CertAlertWindow) => Promise<boolean>;
  /**
   * Persists an `expiry_alert` row for `(certId, window, daysLeft)`. Default:
   * no-op. Idempotent on `(cert_id, window_days)` per cert lifecycle is the
   * caller's contract.
   */
  recordExpiryAlert?: (
    certId: string,
    window: CertAlertWindow,
    daysLeft: number,
  ) => Promise<void>;
}

/**
 * Pure window selection — independent of dedup state. Returns null when
 * `daysLeft` is outside any monitored threshold (>14 or NaN/negative-infinite).
 */
export function selectAlertWindow(daysLeft: number): CertAlertWindow | null {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft <= 1) return 1;
  if (daysLeft <= 3) return 3;
  if (daysLeft <= 7) return 7;
  if (daysLeft <= 14) return 14;
  return null;
}

export interface ShouldFireResult {
  fire: boolean;
  window: CertAlertWindow | null;
  reason: "no-window" | "duplicate" | "fire";
}

/**
 * Decision point: should we fire `notifyCertExpiring` for this observation?
 *
 * Returns `{ fire: true, window: W }` exactly once per `(certId, W)` per cert
 * lifecycle. On `fire: true` the caller MUST persist the alert via
 * `recordExpiryAlert(certId, W, daysLeft)` BEFORE invoking the notifier — that
 * keeps the dedup idempotent under crashes between decision and notify.
 *
 * Caller responsibility: a renewal observation (forward-jump in `validTo`)
 * must INSERT an `event_type='renewed'` row in `app_cert_events`; that resets
 * `lifecycle_start` so the next ≤14d crossing fires again.
 */
export async function shouldFireExpiryAlert(
  certId: string,
  daysLeft: number,
  deps: CertWindowDedupDeps = {},
): Promise<ShouldFireResult> {
  const window = selectAlertWindow(daysLeft);
  if (window === null) {
    return { fire: false, window: null, reason: "no-window" };
  }
  const has = deps.hasExpiryAlert ?? (async () => false);
  const exists = await has(certId, window);
  if (exists) {
    return { fire: false, window, reason: "duplicate" };
  }
  return { fire: true, window, reason: "fire" };
}

/**
 * Convenience: full decision + persist flow. Returns true iff caller should
 * dispatch the Telegram alert. Persists the alert row BEFORE returning true,
 * so a notifier crash doesn't unwind the dedup.
 */
export async function reserveExpiryAlertSlot(
  certId: string,
  daysLeft: number,
  deps: CertWindowDedupDeps = {},
): Promise<{ fired: boolean; window: CertAlertWindow | null }> {
  const decision = await shouldFireExpiryAlert(certId, daysLeft, deps);
  if (!decision.fire || decision.window === null) {
    return { fired: false, window: decision.window };
  }
  const record = deps.recordExpiryAlert ?? (async () => undefined);
  await record(certId, decision.window, daysLeft);
  return { fired: true, window: decision.window };
}
