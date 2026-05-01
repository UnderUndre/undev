/**
 * Feature 008 T046 — cert-expiry windowed alerter (US2 / FR-022).
 *
 * Pure: given a cert + now + the set of windows already fired this lifecycle,
 * returns which windows newly cross now. Caller persists the fired-window
 * markers to `app_cert_events` (`expiry_alert_fired`, with `event_data.window`).
 *
 * Windows: 14d / 7d / 3d / 1d. Each fires once per renewal cycle. Recovery
 * (cert renewed past the window) is silent. The lifecycle resets when the
 * cert transitions back to `active` with a fresh `last_renew_at` past the
 * previous threshold (caller computes "lifecycle id" — typically the cert's
 * `last_renew_at` or `issued_at`).
 */

export type AlertWindow = "14d" | "7d" | "3d" | "1d";

const WINDOW_DAYS: Record<AlertWindow, number> = {
  "14d": 14,
  "7d": 7,
  "3d": 3,
  "1d": 1,
};

const ORDER: AlertWindow[] = ["14d", "7d", "3d", "1d"];

export interface AlertableCert {
  expiresAt: string | null;
  status: string;
}

export interface EvaluationOutput {
  windowsToFire: AlertWindow[];
  daysLeft: number | null;
}

/**
 * Returns the set of windows that should fire now. Caller filters out windows
 * already in `firedWindows` (per renewal lifecycle).
 */
export function evaluateAlertWindows(
  cert: AlertableCert,
  now: Date,
  firedWindows: ReadonlySet<AlertWindow>,
): EvaluationOutput {
  if (cert.status !== "active") return { windowsToFire: [], daysLeft: null };
  if (cert.expiresAt === null) return { windowsToFire: [], daysLeft: null };
  const expires = new Date(cert.expiresAt).getTime();
  if (!Number.isFinite(expires)) return { windowsToFire: [], daysLeft: null };
  const ms = expires - now.getTime();
  const days = ms / (24 * 60 * 60 * 1000);

  const fire: AlertWindow[] = [];
  for (const w of ORDER) {
    if (firedWindows.has(w)) continue;
    if (days <= WINDOW_DAYS[w] && days > 0) {
      fire.push(w);
    }
  }
  return { windowsToFire: fire, daysLeft: days };
}
