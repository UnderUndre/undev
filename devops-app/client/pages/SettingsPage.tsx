import React, { useState } from "react";
import {
  useGitHubConnection,
  useConnectGitHub,
  useDisconnectGitHub,
  useGitHubRateLimit,
} from "../hooks/useGitHub.js";
import { TlsAcmeSection } from "../components/settings/TlsAcmeSection.js";

export function SettingsPage() {
  const { data: connection, isLoading } = useGitHubConnection();
  const { data: rateLimit } = useGitHubRateLimit();
  const connectMutation = useConnectGitHub();
  const disconnectMutation = useDisconnectGitHub();

  const [token, setToken] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    connectMutation.mutate(token.trim(), {
      onSuccess: () => setToken(""),
    });
  };

  const handleDisconnect = () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    disconnectMutation.mutate(undefined, {
      onSettled: () => setConfirmDisconnect(false),
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <TlsAcmeSection />

      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6">
        <h2 className="text-xl font-semibold mb-4">GitHub Integration</h2>

        {isLoading && <p className="text-gray-400">Loading…</p>}

        {!isLoading && !connection && (
          <form onSubmit={handleConnect} className="space-y-4">
            <p className="text-sm text-gray-400">
              Paste a Fine-grained Personal Access Token with read access to the
              repositories you want to deploy.
            </p>
            <div>
              <label className="block text-sm font-medium mb-2" htmlFor="gh-token">
                GitHub Token
              </label>
              <input
                id="gh-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_..."
                className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-md text-white focus:outline-none focus:border-brand-purple"
              />
            </div>

            <p className="text-xs text-amber-400 bg-amber-950/40 border border-amber-900 rounded-md px-3 py-2">
              Warning: All dashboard users will access repositories available to
              this GitHub account.
            </p>

            {connectMutation.error && (
              <p className="text-sm text-red-400">
                {(connectMutation.error as Error).message}
              </p>
            )}

            <button
              type="submit"
              disabled={connectMutation.isPending || !token.trim()}
              className="px-4 py-2 bg-brand-purple text-white rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {connectMutation.isPending ? "Validating…" : "Connect"}
            </button>
          </form>
        )}

        {!isLoading && connection && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <img
                src={connection.avatarUrl}
                alt={connection.username}
                className="w-12 h-12 rounded-full border border-gray-700"
              />
              <div>
                <div className="font-medium">Connected as @{connection.username}</div>
                <div className="text-sm text-gray-400">
                  {formatExpiry(connection.tokenExpiresAt)}
                </div>
              </div>
            </div>

            {rateLimit && rateLimit.limit > 0 && (
              <div className="text-sm text-gray-400">
                Rate limit: <span className="text-white">{rateLimit.remaining}</span>{" "}
                / {rateLimit.limit} (resets{" "}
                {new Date(rateLimit.resetAt).toLocaleTimeString()})
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending}
                className="px-4 py-2 bg-red-900/50 hover:bg-red-900 border border-red-800 text-red-200 rounded-md disabled:opacity-50"
              >
                {disconnectMutation.isPending
                  ? "Disconnecting…"
                  : confirmDisconnect
                    ? "Confirm disconnect?"
                    : "Disconnect"}
              </button>
              {confirmDisconnect && (
                <button
                  onClick={() => setConfirmDisconnect(false)}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-md"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "Token does not expire";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Token expired";
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  return `Expires in ${days} day${days === 1 ? "" : "s"} (${new Date(iso).toLocaleDateString()})`;
}
