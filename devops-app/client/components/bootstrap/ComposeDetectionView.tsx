/** Feature 009 T025 — compose service picker + warning banners. */
import React from "react";
import type { ComposeService } from "../../lib/bootstrap-api.js";

export interface ComposeDetectionViewProps {
  services: ComposeService[];
  warnings: string[];
  errors: string[];
  selectedService: string | null;
  selectedPort: number | null;
  onChange: (service: string | null, port: number | null) => void;
}

export function ComposeDetectionView({
  services,
  warnings,
  errors,
  selectedService,
  selectedPort,
  onChange,
}: ComposeDetectionViewProps) {
  const ok = services.filter((s) => s.kind === "ok");
  const ambiguous = services.filter((s) => s.kind === "ambiguous_port");
  const noPort = services.filter((s) => s.kind === "no_port");

  const onSelectService = (svc: ComposeService) => {
    if (svc.kind === "ok") onChange(svc.name, svc.exposeOrPorts);
    else onChange(svc.name, null);
  };

  return (
    <div className="space-y-3">
      {errors.length > 0 && (
        <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <ul className="list-disc pl-5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded border border-yellow-700 bg-yellow-950/30 px-3 py-2 text-sm text-yellow-300">
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {services.length === 0 ? (
        <div className="text-sm text-gray-400">
          No services detected. You can still proceed and configure upstream
          service + port manually below.
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs uppercase text-gray-400">Public service</label>
          <div className="grid gap-2">
            {services.map((svc) => (
              <label
                key={svc.name}
                className={`flex items-start gap-2 rounded border px-3 py-2 text-sm cursor-pointer ${
                  selectedService === svc.name
                    ? "border-blue-500 bg-blue-950/30"
                    : "border-gray-700 bg-gray-900"
                }`}
              >
                <input
                  type="radio"
                  name="upstream-service"
                  checked={selectedService === svc.name}
                  onChange={() => onSelectService(svc)}
                  className="mt-1"
                />
                <span className="flex-1">
                  <code className="font-mono">{svc.name}</code>
                  {svc.kind === "ok" && (
                    <span className="ml-2 text-xs text-green-400">
                      port {svc.exposeOrPorts}
                    </span>
                  )}
                  {svc.kind === "ambiguous_port" && (
                    <span className="ml-2 text-xs text-yellow-400">
                      port from env (`{svc.rawValue}`) — enter manually
                    </span>
                  )}
                  {svc.kind === "no_port" && (
                    <span className="ml-2 text-xs text-gray-500">no port declared</span>
                  )}
                  {svc.networkModeHost && (
                    <span className="ml-2 text-xs text-yellow-400">network_mode: host</span>
                  )}
                  {svc.replicas > 1 && (
                    <span className="ml-2 text-xs text-blue-400">×{svc.replicas} replicas</span>
                  )}
                  {svc.hasHealthcheck && (
                    <span className="ml-2 text-xs text-gray-400">healthcheck ✓</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className="block text-xs uppercase text-gray-400 mb-1">Service name</label>
          <input
            type="text"
            className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1"
            value={selectedService ?? ""}
            onChange={(e) => onChange(e.target.value || null, selectedPort)}
            placeholder="(blank = no proxy)"
          />
        </div>
        <div>
          <label className="block text-xs uppercase text-gray-400 mb-1">Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            className="w-full rounded bg-gray-800 border border-gray-700 px-2 py-1"
            value={selectedPort ?? ""}
            onChange={(e) => {
              const n = e.target.value === "" ? null : Number(e.target.value);
              onChange(selectedService, Number.isFinite(n) ? (n as number) : null);
            }}
          />
        </div>
      </div>
      {(ok.length > 0 || ambiguous.length > 0 || noPort.length > 0) && (
        <p className="text-xs text-gray-500">
          {ok.length} resolved, {ambiguous.length} ambiguous, {noPort.length} without port.
        </p>
      )}
    </div>
  );
}
