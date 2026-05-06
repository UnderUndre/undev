/**
 * Feature 011 T021 + T053 + T054 — Compatibility report UI.
 *
 * Pure presentational component. Renders:
 *   - Provider hint banners (T053+T054).
 *   - Per-row pass / warn / fail with detail and optional remediation.
 *   - Per-warn-row checkbox for explicit acknowledgement (FR-022).
 *
 * No `dangerouslySetInnerHTML`, no third-party deps, controlled inputs.
 */

import React from "react";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CompatibilityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  autoFixableByInitialise: boolean;
  action?: "initialise" | "edit-server" | "manual";
}

export interface CompatibilityReportData {
  overall: CheckStatus;
  checks: CompatibilityCheck[];
  hints: string[];
}

interface Props {
  report: CompatibilityReportData;
  acknowledgedWarnings: ReadonlySet<string>;
  onAcknowledgeWarning: (checkId: string, ack: boolean) => void;
  onRemediation?: (action: NonNullable<CompatibilityCheck["action"]>) => void;
}

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
};

const STATUS_COLOR: Record<CheckStatus, string> = {
  pass: "text-green-400",
  warn: "text-yellow-400",
  fail: "text-red-400",
};

export function CompatibilityReport({
  report,
  acknowledgedWarnings,
  onAcknowledgeWarning,
  onRemediation,
}: Props): React.JSX.Element {
  return (
    <section className="border border-gray-800 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">
          Compatibility report
        </h3>
        <span
          className={`text-xs font-mono uppercase ${STATUS_COLOR[report.overall]}`}
        >
          {STATUS_ICON[report.overall]} {report.overall}
        </span>
      </div>

      {/* T053 + T054 — provider hint banners */}
      {report.hints.length > 0 && (
        <ul className="space-y-1">
          {report.hints.map((h, i) => (
            <li
              key={i}
              className="text-xs text-blue-300 bg-blue-950/40 border border-blue-900 rounded px-2 py-1"
              role="note"
            >
              ℹ {h}
            </li>
          ))}
        </ul>
      )}

      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500">
            <th className="text-left pb-1 w-8"></th>
            <th className="text-left pb-1">Check</th>
            <th className="text-left pb-1">Detail</th>
            <th className="text-right pb-1 w-24">Acknowledge</th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.id} className="border-t border-gray-800 align-top">
              <td className={`py-1 font-mono ${STATUS_COLOR[c.status]}`}>
                {STATUS_ICON[c.status]}
              </td>
              <td className="py-1 pr-2">
                <span className="font-medium text-gray-200">{c.label}</span>
                <p className="text-[10px] font-mono text-gray-500">{c.id}</p>
              </td>
              <td className="py-1 pr-2 text-gray-400">
                {c.detail}
                {c.action && c.status !== "pass" && (
                  <button
                    type="button"
                    onClick={() => onRemediation?.(c.action!)}
                    className="ml-2 underline text-blue-400 hover:text-blue-300"
                  >
                    {c.action === "initialise"
                      ? "Initialise"
                      : c.action === "edit-server"
                        ? "Edit server"
                        : "Manual fix"}
                  </button>
                )}
              </td>
              <td className="py-1 text-right">
                {c.status === "warn" ? (
                  <label className="inline-flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acknowledgedWarnings.has(c.id)}
                      onChange={(e) =>
                        onAcknowledgeWarning(c.id, e.target.checked)
                      }
                      className="h-3 w-3 accent-brand-purple"
                      aria-label={`Acknowledge warning ${c.label}`}
                    />
                    <span className="text-gray-500">ack</span>
                  </label>
                ) : (
                  <span className="text-gray-700">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
