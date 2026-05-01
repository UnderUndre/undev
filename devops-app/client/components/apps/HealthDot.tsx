import React from "react";
import { useAppHealth, type HealthProbe, type HealthStatus } from "../../hooks/useAppHealth.js";

// Feature 006 T023 — coloured health indicator with hover tooltip.
// Tailwind colour map per FR-019. role='img' + aria-label for screen readers.
// No dangerouslySetInnerHTML — tooltip content is plain React.

interface HealthDotProps {
  appId: string;
  size?: "sm" | "lg";
}

const SIZE_CLASS: Record<NonNullable<HealthDotProps["size"]>, string> = {
  sm: "w-2.5 h-2.5",
  lg: "w-4 h-4",
};

const STATUS_COLOR: Record<HealthStatus, string> = {
  healthy: "bg-green-500",
  unhealthy: "bg-red-500",
  unknown: "bg-gray-500",
};

const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  unknown: "Unknown — no probe has succeeded yet",
};

export function HealthDot({ appId, size = "sm" }: HealthDotProps) {
  const { health, isLoading } = useAppHealth(appId);

  // While the initial fetch is pending, render a yellow "checking" dot per
  // FR-019. Once we have data, the colour reflects the committed status.
  const status: HealthStatus = health?.status ?? "unknown";
  const colorClass = isLoading && !health ? "bg-yellow-500 animate-pulse" : STATUS_COLOR[status];
  const sizeClass = SIZE_CLASS[size];
  const label = `Health: ${STATUS_LABEL[status]}`;

  const lastProbes = health?.probes ?? [];
  const lastContainer = findLast(lastProbes, (p) => p.probeType === "container");
  const lastHttp = findLast(lastProbes, (p) => p.probeType === "http");

  return (
    <span className="relative inline-flex group/healthdot">
      <span
        role="img"
        aria-label={label}
        className={`inline-block rounded-full ${sizeClass} ${colorClass} cursor-help`}
      />
      <HealthTooltip
        status={status}
        checkedAt={health?.checkedAt ?? null}
        message={health?.message ?? null}
        container={lastContainer}
        http={lastHttp}
      />
    </span>
  );
}

interface HealthTooltipProps {
  status: HealthStatus;
  checkedAt: string | null;
  message: string | null;
  container: HealthProbe | undefined;
  http: HealthProbe | undefined;
}

function HealthTooltip({ status, checkedAt, message, container, http }: HealthTooltipProps) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible group-hover/healthdot:visible group-focus-within/healthdot:visible absolute z-50 left-1/2 -translate-x-1/2 top-full mt-2 w-64 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200 shadow-xl"
    >
      <div className="font-semibold mb-1 text-gray-100">{STATUS_LABEL[status]}</div>
      <div className="space-y-0.5 text-gray-400">
        <div>
          Last check:{" "}
          <span className="text-gray-200">
            {checkedAt ? formatRelative(checkedAt) : "never"}
          </span>
        </div>
        {message && (
          <div>
            Message: <span className="text-gray-200">{message}</span>
          </div>
        )}
        {container && (
          <div>
            Container:{" "}
            <span className="text-gray-200">
              {container.containerStatus ?? container.outcome}
              {container.latencyMs !== null && ` (${container.latencyMs}ms)`}
            </span>
          </div>
        )}
        {http && (
          <div>
            HTTP:{" "}
            <span className="text-gray-200">
              {http.statusCode ?? http.outcome}
              {http.latencyMs !== null && ` (${http.latencyMs}ms)`}
            </span>
            {http.errorMessage && (
              <div className="text-red-300">{http.errorMessage}</div>
            )}
          </div>
        )}
        {!container && !http && (
          <div className="text-gray-500">No probes yet.</div>
        )}
      </div>
    </span>
  );
}

function findLast<T>(arr: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item !== undefined && pred(item)) return item;
  }
  return undefined;
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleString();
}
