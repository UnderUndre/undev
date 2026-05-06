/** Feature 010 T043 — resource cell renderer with deleted-fallback. */
import React from "react";
import type { AuditRow } from "../../hooks/useAuditQuery.js";

export function ResourceLink({ row }: { row: AuditRow }) {
  if (!row.resourceId) {
    return <span className="text-gray-500">{row.resourceType}</span>;
  }
  // Build deeplink per type. Falls back to plain text for `other`.
  const href =
    row.resourceType === "server"
      ? `/servers/${row.resourceId}`
      : row.resourceType === "application" || row.resourceType === "bootstrap"
        ? `/apps/${row.resourceId}`
        : null;
  const label = row.resourceLabel ?? row.resourceId;
  if (href) {
    return (
      <a href={href} className="text-blue-300 hover:underline font-mono text-xs">
        {label}
      </a>
    );
  }
  return <span className="text-gray-300 font-mono text-xs">{label}</span>;
}
