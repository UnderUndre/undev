/**
 * Feature 012 T019 — DeployStrategySection.
 *
 * Strategy dropdown (recreate / blue_green; latter disabled when proxy_type
 * != 'caddy') + drain seconds + green healthcheck timeout + inline volume
 * ack panel. Controlled inputs only.
 */

import React from "react";
import { VolumeAckPanel, type DetectedVolume } from "./VolumeAckPanel.js";

export type DeployStrategy = "recreate" | "blue_green";

export interface DeployStrategyValues {
  deployStrategy: DeployStrategy;
  drainSeconds: number;
  greenHealthcheckTimeoutSeconds: number;
  acknowledgeVolumeSharing: boolean;
}

export interface DeployStrategySectionProps {
  values: DeployStrategyValues;
  onChange: (patch: Partial<DeployStrategyValues>) => void;
  proxyType: string | null;
  detectedVolumes: DetectedVolume[];
  activeColor: "blue" | "green" | null;
}

const DRAIN_MIN = 0;
const DRAIN_MAX = 600;
const HEALTH_MIN = 10;
const HEALTH_MAX = 1800;

export function DeployStrategySection({
  values,
  onChange,
  proxyType,
  detectedVolumes,
  activeColor,
}: DeployStrategySectionProps) {
  const blueGreenAvailable = proxyType === "caddy";

  return (
    <fieldset className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-3">
      <legend className="text-sm text-gray-300 px-2">Deploy strategy</legend>

      <label className="block">
        <span className="text-xs text-gray-400 mb-1 block">Strategy</span>
        <select
          value={values.deployStrategy}
          onChange={(e) =>
            onChange({ deployStrategy: e.target.value as DeployStrategy })
          }
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
        >
          <option value="recreate">Recreate (default — short downtime)</option>
          <option value="blue_green" disabled={!blueGreenAvailable}>
            Blue/green (zero-drop){blueGreenAvailable ? "" : " — requires Caddy"}
          </option>
        </select>
        {!blueGreenAvailable && (
          <span className="text-xs text-gray-500 mt-1 block">
            Switch proxy_type to 'caddy' to enable blue/green.
          </span>
        )}
      </label>

      {values.deployStrategy === "blue_green" && (
        <>
          {activeColor !== null && (
            <div className="text-xs text-gray-400">
              Currently active slot:{" "}
              <span className="font-mono text-gray-200">{activeColor}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">
                Drain seconds ({DRAIN_MIN}..{DRAIN_MAX})
              </span>
              <input
                type="number"
                min={DRAIN_MIN}
                max={DRAIN_MAX}
                value={values.drainSeconds}
                onChange={(e) =>
                  onChange({
                    drainSeconds: clamp(
                      parseInt(e.target.value, 10) || 0,
                      DRAIN_MIN,
                      DRAIN_MAX,
                    ),
                  })
                }
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">
                Healthcheck timeout sec ({HEALTH_MIN}..{HEALTH_MAX})
              </span>
              <input
                type="number"
                min={HEALTH_MIN}
                max={HEALTH_MAX}
                value={values.greenHealthcheckTimeoutSeconds}
                onChange={(e) =>
                  onChange({
                    greenHealthcheckTimeoutSeconds: clamp(
                      parseInt(e.target.value, 10) || HEALTH_MIN,
                      HEALTH_MIN,
                      HEALTH_MAX,
                    ),
                  })
                }
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
              />
            </label>
          </div>

          <VolumeAckPanel
            detectedVolumes={detectedVolumes}
            acknowledged={values.acknowledgeVolumeSharing}
            onAcknowledgeChange={(b) =>
              onChange({ acknowledgeVolumeSharing: b })
            }
          />
        </>
      )}
    </fieldset>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
