/** Feature 008 T039 + T073 — typed-confirm domain edit dialog with DNS warning UX + IDN helper. */
import React, { useState } from "react";
import { validateDomain } from "../../lib/domain-validator.js";
import { api, ApiError } from "../../lib/api.js";

export interface DomainEditDialogProps {
  appId: string;
  initialDomain: string | null;
  onClose: () => void;
  onSaved: (newDomain: string | null) => void;
}

interface DnsWarning {
  kind: "cloudflare" | "mismatch";
  resolvedIps: string[];
  serverIp?: string | null;
  remediation?: string;
}

export function DomainEditDialog({ appId, initialDomain, onClose, onSaved }: DomainEditDialogProps) {
  const [domain, setDomain] = useState(initialDomain ?? "");
  const [confirmDnsWarning, setConfirmDnsWarning] = useState(false);
  const [confirmCrossServer, setConfirmCrossServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dnsWarning, setDnsWarning] = useState<DnsWarning | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const localValidation = validateDomain(domain || null);

  async function submit() {
    setError(null);
    if (!localValidation.ok) {
      setError(localValidation.error);
      return;
    }
    setSubmitting(true);
    try {
      await api.patch(`/applications/${appId}/domain`, {
        domain: localValidation.value,
        confirmDnsWarning,
        confirmCrossServer,
      });
      onSaved(localValidation.value);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "DNS_WARNING_REQUIRES_CONFIRM") {
          const d = err.details as DnsWarning;
          setDnsWarning(d);
        } else if (err.code === "DOMAIN_CROSS_SERVER") {
          setError("Domain is on another server. Tick 'Confirm cross-server' to proceed.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit domain"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold">Domain & TLS</h2>

        <label className="block text-sm">
          Domain
          <input
            type="text"
            autoFocus
            className="mt-1 w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 font-mono text-sm"
            placeholder="foo.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </label>
        <p className="text-xs text-gray-500">
          Use punycode for international domains (e.g. <code>xn--mnchen-3ya.de</code>, not{" "}
          <code>münchen.de</code>).
        </p>

        {!localValidation.ok && domain.length > 0 && (
          <p className="text-sm text-red-400">{localValidation.error}</p>
        )}

        {dnsWarning && (
          <div className="rounded border border-yellow-700 bg-yellow-950/40 p-3 text-sm space-y-2">
            <p>
              <strong>DNS warning ({dnsWarning.kind}).</strong> Resolved:{" "}
              <code>{dnsWarning.resolvedIps.join(", ")}</code>
              {dnsWarning.serverIp ? (
                <>
                  ; server IP <code>{dnsWarning.serverIp}</code>.
                </>
              ) : null}
            </p>
            {dnsWarning.remediation && <p className="text-xs">{dnsWarning.remediation}</p>}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmDnsWarning}
                onChange={(e) => setConfirmDnsWarning(e.target.checked)}
              />
              Try anyway (DNS may be propagating, or server is behind LB/NAT)
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={confirmCrossServer}
            onChange={(e) => setConfirmCrossServer(e.target.checked)}
          />
          Confirm cross-server (HA / round-robin scenario)
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1 rounded bg-gray-700 text-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded bg-blue-600 text-sm disabled:opacity-50"
            onClick={submit}
            disabled={submitting || !localValidation.ok}
          >
            {submitting ? "Applying..." : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
