/** Feature 008 T042 — Settings → TLS / ACME section. */
import React, { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";

interface TlsSettings {
  acmeEmail: string | null;
  caddyAdminEndpoint: string;
  updatedAt: string | null;
}

interface TestCaddyResult {
  serverId: string;
  serverLabel: string;
  outcome: "ok" | "unreachable" | "invalid_response";
  latencyMs: number | null;
  caddyVersion: string | null;
  errorMessage: string | null;
}

export function TlsAcmeSection() {
  const [settings, setSettings] = useState<TlsSettings | null>(null);
  const [email, setEmail] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [results, setResults] = useState<TestCaddyResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<TlsSettings>("/settings/tls").then((s) => {
      setSettings(s);
      setEmail(s.acmeEmail ?? "");
    });
  }, []);

  async function save() {
    setEmailErr(null);
    if (email.length > 0 && !/^\S+@\S+\.\S+$/.test(email)) {
      setEmailErr("Must be a valid email address");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.patch<TlsSettings>("/settings/tls", {
        acmeEmail: email.length === 0 ? null : email,
      });
      setSettings(updated);
    } catch (err) {
      if (err instanceof ApiError) setEmailErr(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function testCaddy() {
    setTesting(true);
    try {
      const r = await api.post<{ results: TestCaddyResult[] }>("/settings/tls/test-caddy");
      setResults(r.results);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6 space-y-4">
      <h2 className="text-lg font-semibold">TLS / ACME</h2>

      <label className="block text-sm">
        ACME email
        <input
          type="email"
          className="mt-1 w-full rounded bg-gray-800 border border-gray-700 px-2 py-1 font-mono text-sm"
          placeholder="ops@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {emailErr && <p className="text-sm text-red-400">{emailErr}</p>}
      <button
        type="button"
        className="px-3 py-1 rounded bg-blue-600 text-sm disabled:opacity-50"
        onClick={save}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save"}
      </button>

      <div className="text-sm">
        <span className="text-gray-400">Caddy admin endpoint:</span>{" "}
        <code className="font-mono">{settings?.caddyAdminEndpoint}</code>{" "}
        <span className="text-gray-500 text-xs">(over SSH tunnel — managed automatically)</span>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          className="px-3 py-1 rounded bg-gray-700 text-sm"
          onClick={testCaddy}
          disabled={testing}
        >
          {testing ? "Testing…" : "Test Caddy connectivity"}
        </button>
        {results && (
          <ul className="space-y-1 text-sm">
            {results.map((r) => (
              <li key={r.serverId} className="flex items-center gap-2">
                <span
                  className={
                    r.outcome === "ok"
                      ? "text-green-400"
                      : "text-red-400"
                  }
                >
                  {r.outcome === "ok" ? "✓" : "✗"}
                </span>
                <span className="font-mono">{r.serverLabel}</span>
                {r.latencyMs !== null && <span className="text-gray-500">{r.latencyMs}ms</span>}
                {r.errorMessage && (
                  <span className="text-xs text-red-400">{r.errorMessage}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
