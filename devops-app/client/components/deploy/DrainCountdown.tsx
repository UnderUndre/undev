/**
 * Feature 012 T037 — drain countdown.
 *
 * Real-time 1s-tick countdown driven by `drainRemainingMs` from WS.
 * Pauses with a red banner when phase transitions to
 * FAILED_CADDY_ADMIN_POST_SWITCH.
 */

import React, { useEffect, useState } from "react";

export interface DrainCountdownProps {
  drainRemainingMs: number | null;
  phase: string | null;
}

const TICK_MS = 1_000;

export function DrainCountdown({ drainRemainingMs, phase }: DrainCountdownProps) {
  const [displayMs, setDisplayMs] = useState<number | null>(drainRemainingMs);

  useEffect(() => {
    setDisplayMs(drainRemainingMs);
  }, [drainRemainingMs]);

  useEffect(() => {
    if (phase !== "OUTGOING_DRAINING") return;
    if (displayMs === null) return;
    const t = setInterval(() => {
      setDisplayMs((prev) => {
        if (prev === null) return null;
        const next = Math.max(0, prev - TICK_MS);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(t);
  }, [phase, displayMs]);

  if (phase === "FAILED_CADDY_ADMIN_POST_SWITCH") {
    return (
      <div className="bg-red-950/50 border border-red-800/60 rounded p-2 text-xs text-red-200">
        PAUSED — Caddy admin recovery in progress. Drain timer will resume
        after operator action.
      </div>
    );
  }

  if (phase !== "OUTGOING_DRAINING" || displayMs === null) return null;
  const seconds = Math.ceil(displayMs / 1000);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-2 text-xs text-gray-300 flex items-center justify-between">
      <span>Draining outgoing slot…</span>
      <span className="font-mono text-base text-gray-100">{seconds}s</span>
    </div>
  );
}
