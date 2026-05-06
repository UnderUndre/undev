/**
 * Feature 012 T035 — BlueGreenDeployLog.
 *
 * Replaces standard DeployLog when `app.deploy_strategy === 'blue_green'`.
 * Composes <BlueGreenPhaseIndicator>, <DrainCountdown>, and surfaces any
 * recovery dialogs.
 */

import React from "react";
import { BlueGreenPhaseIndicator } from "./BlueGreenPhaseIndicator.js";
import { DrainCountdown } from "./DrainCountdown.js";
import { AbortDuringDrainDialog } from "./AbortDuringDrainDialog.js";
import { CaddyAdminFailureRecoveryDialog } from "./CaddyAdminFailureRecoveryDialog.js";
import { useBlueGreenDeployState } from "../../hooks/useBlueGreenDeployState.js";

export interface BlueGreenDeployLogProps {
  appId: string;
  appName: string;
}

export function BlueGreenDeployLog({ appId, appName }: BlueGreenDeployLogProps) {
  const { phase, drainRemainingMs, candidateColor, error } =
    useBlueGreenDeployState(appId);

  const showAbort = phase === "OUTGOING_DRAINING";
  const showCaddyRecovery = phase === "FAILED_CADDY_ADMIN_POST_SWITCH";

  return (
    <div className="space-y-3">
      <BlueGreenPhaseIndicator
        currentPhase={phase}
        candidateColor={candidateColor ?? undefined}
      />
      <DrainCountdown drainRemainingMs={drainRemainingMs} phase={phase} />
      {showAbort && <AbortDuringDrainDialog appId={appId} appName={appName} />}
      {showCaddyRecovery && (
        <CaddyAdminFailureRecoveryDialog appId={appId} appName={appName} />
      )}
      {error && (
        <div className="text-xs text-red-300">WS error: {error}</div>
      )}
    </div>
  );
}
