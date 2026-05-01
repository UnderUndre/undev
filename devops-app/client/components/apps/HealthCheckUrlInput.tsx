/**
 * Feature 006 T041 + T056 — Health Check URL input.
 *
 * Inline URL parse on blur (T041) + debounced 500ms server-side validation
 * via POST /api/applications/health-url/validate (T056) which runs the same
 * SSRF block list the probe uses (FR-029a/b). The server gate is
 * authoritative — this is UX guidance.
 */
import React, { useEffect, useRef, useState } from "react";

export interface HealthCheckUrlInputProps {
  value: string | null;
  onChange: (next: string | null) => void;
  label?: string;
}

type ServerValidation =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "error"; message: string };

export function HealthCheckUrlInput({
  value,
  onChange,
  label = "Health Check URL",
}: HealthCheckUrlInputProps) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [serverValidation, setServerValidation] = useState<ServerValidation>({
    state: "idle",
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (value === null || value === "") {
      setServerValidation({ state: "idle" });
      return;
    }
    setServerValidation({ state: "checking" });
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch("/api/applications/health-url/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ url: value }),
          });
          const data: { ok: boolean; code?: string } = await r.json();
          if (data.ok) {
            setServerValidation({ state: "ok" });
            return;
          }
          setServerValidation({
            state: "error",
            message:
              data.code === "private_ip"
                ? "This URL resolves to an internal IP — health probes cannot target internal infrastructure."
                : data.code === "nxdomain"
                  ? "DNS resolution failed."
                  : "Invalid URL.",
          });
        } catch {
          // Network error is not the URL's fault — leave UX untouched.
          setServerValidation({ state: "idle" });
        }
      })();
    }, 500);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [value]);

  function handleBlur() {
    if (value === null || value === "") {
      setLocalError(null);
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(value);
      setLocalError(null);
    } catch {
      setLocalError("Not a valid URL.");
    }
  }

  return (
    <label className="block">
      <span className="text-sm text-gray-400 mb-1 block">{label}</span>
      <input
        type="url"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        onBlur={handleBlur}
        placeholder="https://example.com/health"
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-purple"
      />
      <p className="text-xs text-gray-500 mt-1">
        Optional public URL for HTTP probe. Leave empty to use container health
        only. Probes use redirect: manual and a 10s timeout.
      </p>
      {localError !== null && (
        <p className="text-xs text-red-400 mt-1">{localError}</p>
      )}
      {serverValidation.state === "error" && (
        <p className="text-xs text-red-400 mt-1">{serverValidation.message}</p>
      )}
      {serverValidation.state === "checking" && (
        <p className="text-xs text-gray-500 mt-1">Checking URL…</p>
      )}
    </label>
  );
}
