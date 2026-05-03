/**
 * Feature 008 T038 + T053 (grace banner) + T059 (force renew) + T065 (DNS recheck UI).
 *
 * Three render states:
 *   - no domain         → Add domain button
 *   - domain + active   → cert widget + Change/Force renew/Revoke
 *   - domain + pending  → status banner + force renew
 */
import React, { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { DomainEditDialog } from "./DomainEditDialog.js";
import { CertEventTimeline, type CertEvent } from "./CertEventTimeline.js";

export interface AppForDomainSection {
  id: string;
  name: string;
  domain: string | null;
  acmeEmail: string | null;
}

interface CertRow {
  id: string;
  appId: string;
  domain: string;
  status: string;
  issuer: string;
  issuedAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  retryAfter: string | null;
  orphanedAt: string | null;
  orphanReason: string;
  pendingDnsRecheckUntil: string | null;
  events?: CertEvent[];
}

const RENEWABLE = new Set(["failed", "expired", "rate_limited"]);

export function DomainTlsSection({ app }: { app: AppForDomainSection }) {
  const [editing, setEditing] = useState(false);
  const [certs, setCerts] = useState<CertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const data = await api.get<{ certs: CertRow[] }>(
          `/applications/${app.id}/certs?includeEvents=true`,
        );
        if (!cancel) setCerts(data.certs);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [app.id, refreshTick]);

  const live = certs.find(
    (c) => c.status !== "orphaned" && c.status !== "revoked",
  );
  const orphaned = certs.find(
    (c) => c.status === "orphaned" && c.orphanReason === "domain_change",
  );

  const refresh = () => setRefreshTick((t) => t + 1);

  async function forceRenew(certId: string) {
    setActionError(null);
    try {
      await api.post(`/applications/${app.id}/certs/${certId}/renew`);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Force renew failed");
    }
  }

  async function cancelRecheck(certId: string) {
    setActionError(null);
    try {
      await api.delete(`/applications/${app.id}/certs/${certId}/dns-recheck`);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Cancel failed");
    }
  }

  async function revokeNow(certId: string) {
    setActionError(null);
    try {
      await api.post(`/applications/${app.id}/certs/${certId}/revoke`, {});
      setRevokeConfirmId(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Revoke failed");
    }
  }

  // Phase 3 — Promote to TLS: write override + recreate without full
  // server-deploy. For self-promote (this dashboard) the connection drops
  // briefly while the container restarts.
  const [promoting, setPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState<string | null>(null);
  async function promoteToTls() {
    setActionError(null);
    setPromoteResult(null);
    setPromoting(true);
    try {
      const r = await api.post<{ kind: string; note?: string; overridePath?: string }>(
        `/applications/${app.id}/promote-tls`,
        {},
      );
      setPromoteResult(
        r.kind === "self-promote-scheduled"
          ? `Scheduled — connection will drop briefly. ${r.note ?? ""}`
          : `Promoted. Override at ${r.overridePath ?? "?"}`,
      );
      setTimeout(refresh, 5000);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Promote failed");
    } finally {
      setPromoting(false);
    }
  }

  return (
    <section
      aria-label="Domain & TLS"
      className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide">Domain & TLS</h3>
        <button
          type="button"
          className="text-xs underline text-blue-400"
          onClick={() => setEditing(true)}
        >
          {app.domain ? "Change domain" : "Add domain"}
        </button>
      </header>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !app.domain ? (
        <p className="text-sm text-gray-500">No domain set</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div>
            <span className="text-gray-400">Domain:</span>{" "}
            <a
              href={`https://${app.domain}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-blue-300 underline"
            >
              {app.domain}
            </a>
          </div>
          {live && (
            <CertWidget
              cert={live}
              onForceRenew={() => forceRenew(live.id)}
              onCancelRecheck={() => cancelRecheck(live.id)}
            />
          )}
          {orphaned && orphaned.orphanedAt && (
            <GraceBanner
              domain={orphaned.domain}
              orphanedAt={orphaned.orphanedAt}
              certId={orphaned.id}
              confirming={revokeConfirmId === orphaned.id}
              onRevokeRequest={() => setRevokeConfirmId(orphaned.id)}
              onRevokeConfirm={() => revokeNow(orphaned.id)}
              onRevokeCancel={() => setRevokeConfirmId(null)}
            />
          )}
          {actionError && (
            <p className="text-sm text-red-400" role="alert">
              {actionError}
            </p>
          )}
          {promoteResult && (
            <p className="text-sm text-green-400" role="status">
              {promoteResult}
            </p>
          )}
          <div className="pt-2">
            <button
              type="button"
              onClick={promoteToTls}
              disabled={promoting}
              className="text-xs px-2 py-1 rounded border border-blue-700 bg-blue-950/40 hover:bg-blue-900/40 disabled:opacity-50"
              title="Write Caddy labels override + recreate the upstream container without a full git+build deploy. Use this after first bootstrap to enable TLS, or to apply edited domain/upstream-port/upstream-service settings."
            >
              {promoting ? "Promoting…" : "Promote to TLS"}
            </button>
          </div>
        </div>
      )}

      {live?.events && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-400">Event timeline</summary>
          <div className="pt-2">
            <CertEventTimeline events={live.events} />
          </div>
        </details>
      )}

      {editing && (
        <DomainEditDialog
          appId={app.id}
          initialDomain={app.domain}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function CertWidget({
  cert,
  onForceRenew,
  onCancelRecheck,
}: {
  cert: CertRow;
  onForceRenew: () => void;
  onCancelRecheck: () => void;
}) {
  const renewable = RENEWABLE.has(cert.status);
  const recheckPending =
    cert.status === "pending" &&
    cert.pendingDnsRecheckUntil !== null &&
    new Date(cert.pendingDnsRecheckUntil).getTime() > Date.now();

  return (
    <div className="space-y-1">
      <div>
        <span className="text-gray-400">Status:</span>{" "}
        <StatusPill status={cert.status} />
      </div>
      <div>
        <span className="text-gray-400">Issuer:</span> {cert.issuer}
      </div>
      {cert.expiresAt && (
        <div>
          <span className="text-gray-400">Expires:</span> {cert.expiresAt}
        </div>
      )}
      {cert.errorMessage && (
        <div className="text-yellow-400">⚠ {cert.errorMessage}</div>
      )}
      {recheckPending && (
        <div className="rounded border border-blue-800 bg-blue-950/40 p-2 text-xs flex items-center justify-between">
          <span>Validating DNS… (~2 min)</span>
          <button
            type="button"
            className="underline text-blue-300"
            onClick={onCancelRecheck}
          >
            Cancel
          </button>
        </div>
      )}
      {renewable && (
        <button
          type="button"
          className="text-xs underline text-blue-400"
          onClick={onForceRenew}
        >
          Force renew
        </button>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-green-900 text-green-300"
      : status === "pending" || status === "pending_reconcile"
        ? "bg-yellow-900 text-yellow-300"
        : status === "failed" || status === "rate_limited" || status === "revoked" || status === "expired"
          ? "bg-red-900 text-red-300"
          : "bg-gray-800 text-gray-300";
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

function GraceBanner({
  domain,
  orphanedAt,
  certId: _certId,
  confirming,
  onRevokeRequest,
  onRevokeConfirm,
  onRevokeCancel,
}: {
  domain: string;
  orphanedAt: string;
  certId: string;
  confirming: boolean;
  onRevokeRequest: () => void;
  onRevokeConfirm: () => void;
  onRevokeCancel: () => void;
}) {
  const expiry = new Date(new Date(orphanedAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  return (
    <div className="rounded border border-orange-700 bg-orange-950/30 p-2 text-xs space-y-1">
      <div>
        Old domain <code>{domain}</code> kept for rollback until {expiry.toISOString().slice(0, 10)}.
      </div>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span>Revoke now?</span>
          <button type="button" className="underline text-red-300" onClick={onRevokeConfirm}>
            Yes, revoke
          </button>
          <button type="button" className="underline" onClick={onRevokeCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="underline" onClick={onRevokeRequest}>
          Revoke now
        </button>
      )}
    </div>
  );
}
