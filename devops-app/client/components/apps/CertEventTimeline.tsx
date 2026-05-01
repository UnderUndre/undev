/** Feature 008 T040 — append-only cert event timeline. */
import React from "react";

export interface CertEvent {
  id: string;
  certId: string;
  eventType: string;
  eventData: unknown;
  actor: string;
  occurredAt: string;
}

const ICON: Record<string, string> = {
  issued: "✅",
  renewed: "🔄",
  failed: "❌",
  orphaned: "🟠",
  revoked: "🚫",
  rate_limited: "⏳",
  force_renew_requested: "▶️",
  pending_reconcile_marked: "🟡",
  pending_reconcile_cleared: "✅",
  expiry_alert_fired: "🔔",
  hard_delete_partial: "⚠️",
  orphan_cleaned: "🧹",
};

export function CertEventTimeline({ events }: { events: CertEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-gray-500">No events yet</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3">
          <span aria-hidden="true">{ICON[e.eventType] ?? "•"}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono">{e.eventType}</span>
              <span className="text-xs text-gray-500">{e.actor}</span>
            </div>
            <div className="text-xs text-gray-400">{e.occurredAt}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
