/**
 * Feature 006 T043 — "Check Now" button.
 *
 * POSTs /api/applications/:id/health/check-now (202 Accepted), shows a pending
 * spinner up to 15s, then waits for the next `app-health:<id>` WS event to
 * clear pending state. Disabled when monitoring is off.
 */
import React, { useEffect, useRef, useState } from "react";
import { useAppHealth } from "../../hooks/useAppHealth.js";

export interface CheckNowButtonProps {
  appId: string;
  monitoringEnabled: boolean;
}

export function CheckNowButton({ appId, monitoringEnabled }: CheckNowButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { health } = useAppHealth(appId);
  const lastSeenRef = useRef<string | null | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When pending, watch the health.checkedAt timestamp; first change after we
  // started clears the pending state.
  useEffect(() => {
    if (!pending) return;
    if (lastSeenRef.current === undefined) {
      lastSeenRef.current = health?.checkedAt ?? null;
      return;
    }
    if ((health?.checkedAt ?? null) !== lastSeenRef.current) {
      setPending(false);
      lastSeenRef.current = undefined;
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    }
  }, [pending, health?.checkedAt]);

  async function handleClick() {
    if (pending || !monitoringEnabled) return;
    setError(null);
    setPending(true);
    lastSeenRef.current = health?.checkedAt ?? null;
    try {
      const r = await fetch(`/api/applications/${appId}/health/check-now`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        const code = body?.error?.code;
        if (code === "DEPLOY_IN_PROGRESS") {
          setError("Deploy in progress — try again shortly.");
        } else if (code === "MONITORING_DISABLED") {
          setError("Monitoring is disabled for this app.");
        } else {
          setError(body?.error?.message ?? "Check Now failed.");
        }
        setPending(false);
        return;
      }
      // Cap the spinner at 15s.
      timeoutRef.current = setTimeout(() => {
        setPending(false);
        lastSeenRef.current = undefined;
      }, 15_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
      setPending(false);
    }
  }

  const disabled = pending || !monitoringEnabled;
  const title = !monitoringEnabled
    ? "Re-enable monitoring to use Check Now"
    : pending
      ? "Probe running…"
      : "Run a probe immediately";

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={title}
        className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200"
      >
        {pending ? "Checking…" : "Check Now"}
      </button>
      {error !== null && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
