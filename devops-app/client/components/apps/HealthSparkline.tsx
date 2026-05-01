import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import type { ProbeOutcome, ProbeType } from "../../hooks/useAppHealth.js";

// Feature 006 T024 — inline SVG sparkline of last 24h of probes.
// One tick per probe row; colour-coded by outcome. No chart library, no
// dangerouslySetInnerHTML. role='img' + aria-label for screen readers.

interface SparklineProbe {
  probedAt: string;
  probeType: ProbeType;
  outcome: ProbeOutcome;
  latencyMs?: number | null;
  statusCode?: number | null;
}

interface HistoryResponse {
  appId: string;
  windowStart: string;
  windowEnd: string;
  probes: SparklineProbe[];
}

interface HealthSparklineProps {
  appId: string;
  /** Width in px. Defaults to 320. */
  width?: number;
  /** Height in px. Defaults to 32. */
  height?: number;
}

const OUTCOME_COLOR: Record<ProbeOutcome, string> = {
  healthy: "#22c55e",   // green-500
  unhealthy: "#ef4444", // red-500
  error: "#9ca3af",     // gray-400 — probe couldn't run
};

export function HealthSparkline({ appId, width = 320, height = 32 }: HealthSparklineProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["app", appId, "health", "history"],
    queryFn: () =>
      api.get<HistoryResponse>(`/applications/${appId}/health/history`),
    enabled: Boolean(appId),
  });

  if (isLoading) {
    return (
      <div
        className="rounded bg-gray-900 border border-gray-800 animate-pulse"
        style={{ width, height }}
        aria-label="Loading health history"
      />
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-400" role="alert">
        Failed to load health history.
      </div>
    );
  }

  const probes = data?.probes ?? [];
  if (probes.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-dashed border-gray-700 bg-gray-900/50 text-xs text-gray-500"
        style={{ width, height }}
        role="img"
        aria-label="No probe history yet"
      >
        No probe history yet — check back in 60s
      </div>
    );
  }

  const counts = countOutcomes(probes);
  const summary = `24h health timeline: ${counts.healthy} healthy, ${counts.unhealthy} unhealthy, ${counts.error} error`;

  // Layout: each probe gets a fixed-width tick, packed left-to-right.
  const tickGap = 1;
  const tickWidth = Math.max(1, Math.floor((width - tickGap * (probes.length - 1)) / probes.length));
  const tickHeight = height;

  return (
    <svg
      role="img"
      aria-label={summary}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      <title>{summary}</title>
      {probes.map((probe, idx) => {
        const x = idx * (tickWidth + tickGap);
        const fill = OUTCOME_COLOR[probe.outcome];
        return (
          <rect
            key={`${probe.probedAt}-${idx}`}
            x={x}
            y={0}
            width={tickWidth}
            height={tickHeight}
            fill={fill}
            opacity={probe.probeType === "http" ? 1 : 0.7}
          />
        );
      })}
    </svg>
  );
}

function countOutcomes(probes: readonly SparklineProbe[]): Record<ProbeOutcome, number> {
  const counts: Record<ProbeOutcome, number> = { healthy: 0, unhealthy: 0, error: 0 };
  for (const p of probes) {
    counts[p.outcome] += 1;
  }
  return counts;
}
