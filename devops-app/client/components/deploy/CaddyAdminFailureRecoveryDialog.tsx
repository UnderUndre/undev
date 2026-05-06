/**
 * Feature 012 T048 — CaddyAdminFailureRecoveryDialog.
 *
 * Renders for state FAILED_CADDY_ADMIN_POST_SWITCH. Three actions:
 *   - Retry healthcheck — POST /recover-caddy/retry-healthcheck
 *   - Mark recovered (typed-confirm) — POST /recover-caddy/mark-recovered
 *   - Abort (typed-confirm) — POST /blue-green/abort
 */

import React, { useState } from "react";

export interface CaddyAdminFailureRecoveryDialogProps {
  appId: string;
  appName: string;
  onDone?: () => void;
}

export function CaddyAdminFailureRecoveryDialog({
  appId,
  appName,
  onDone,
}: CaddyAdminFailureRecoveryDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<null | "retry" | "mark" | "abort">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const armed = typed === appName && appName.length > 0;

  async function call(
    path: string,
    body: Record<string, unknown>,
    label: NonNullable<typeof busy>,
  ): Promise<void> {
    setBusy(label);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(
        `/api/applications/${encodeURIComponent(appId)}/blue-green/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      if (!res.ok) {
        setError(json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(`Action ${label} succeeded.`);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-amber-950/40 border border-amber-700/60 rounded p-3 space-y-2">
      <div className="text-sm text-amber-200 font-medium">
        Caddy admin unreachable after switch — manual recovery required
      </div>
      <p className="text-xs text-amber-100/70">
        Drain timer is paused. Either re-probe the admin API, mark recovered
        after externally verifying Caddy state, or abort and roll back.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => call("recover-caddy/retry-healthcheck", {}, "retry")}
          className="px-2 py-1 rounded bg-blue-700 disabled:opacity-40 text-white text-xs"
        >
          {busy === "retry" ? "Probing…" : "Retry healthcheck"}
        </button>
      </div>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={`Type "${appName}" to enable destructive actions`}
        className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!armed || busy !== null}
          onClick={() =>
            call(
              "recover-caddy/mark-recovered",
              { confirmAppName: typed },
              "mark",
            )
          }
          className="px-2 py-1 rounded bg-amber-600 disabled:opacity-40 text-white text-xs"
        >
          {busy === "mark" ? "Marking…" : "Mark recovered"}
        </button>
        <button
          type="button"
          disabled={!armed || busy !== null}
          onClick={() => call("abort", { confirmAppName: typed }, "abort")}
          className="px-2 py-1 rounded bg-red-700 disabled:opacity-40 text-white text-xs"
        >
          {busy === "abort" ? "Aborting…" : "Abort and roll back"}
        </button>
      </div>
      {info && <div className="text-xs text-green-300">{info}</div>}
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}
