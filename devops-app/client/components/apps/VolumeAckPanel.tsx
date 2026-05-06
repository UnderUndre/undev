/**
 * Feature 012 T020 — VolumeAckPanel.
 *
 * Lists detected compose volumes and a single acknowledgement checkbox.
 * Hint text per spec Q2 clarification:
 *   - Logs OK: shared between blue/green is harmless
 *   - Uploads OK: shared during drain is harmless if writes are idempotent
 *   - DB files NOT OK: never share a sqlite/pg data dir between containers
 */

import React from "react";

export interface DetectedVolume {
  source: string;
  target: string;
  mode: "bind" | "named" | "tmpfs";
}

export interface VolumeAckPanelProps {
  detectedVolumes: DetectedVolume[];
  acknowledged: boolean;
  onAcknowledgeChange: (acknowledged: boolean) => void;
}

export function VolumeAckPanel({
  detectedVolumes,
  acknowledged,
  onAcknowledgeChange,
}: VolumeAckPanelProps) {
  if (detectedVolumes.length === 0) return null;

  return (
    <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg p-3 space-y-2">
      <div className="text-sm text-amber-200 font-medium">
        Volume sharing acknowledgement
      </div>
      <ul className="text-xs text-amber-100/80 space-y-1">
        {detectedVolumes.map((v, idx) => (
          <li key={`${v.source}:${v.target}:${idx}`} className="font-mono">
            {v.source} → {v.target}{" "}
            <span className="text-amber-300/70">({v.mode})</span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-amber-100/70 leading-relaxed">
        Blue and green containers share these mounts during the drain window.
        Logs and idempotent uploads are safe; database files (sqlite, pg data
        dirs, leveldb) are NOT — pick a different storage strategy first.
      </div>
      <label className="flex items-center gap-2 text-xs text-amber-100 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledgeChange(e.target.checked)}
          className="accent-amber-400"
        />
        I understand both containers share these volumes during drain.
      </label>
    </div>
  );
}
