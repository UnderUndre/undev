/** Feature 009 T070 — server-scoped bootstrap history table. */
import React, { useEffect, useState, useCallback } from "react";
import { wsClient } from "../../lib/ws.js";
import {
  bootstrapApi,
  type BootstrapListItem,
  type BootstrapState,
} from "../../lib/bootstrap-api.js";
import { BootstrapStateBadge } from "./BootstrapStateBadge.js";
import { BootstrapProgressView } from "./BootstrapProgressView.js";
import { EditBootstrapConfigDialog } from "./EditBootstrapConfigDialog.js";
import { HardDeleteDialog } from "./HardDeleteDialog.js";

export interface BootstrapHistoryPanelProps {
  serverId: string;
}

const IN_FLIGHT: BootstrapState[] = [
  "init",
  "cloning",
  "compose_up",
  "healthcheck",
  "proxy_applied",
  "cert_issued",
];

export function BootstrapHistoryPanel({ serverId }: BootstrapHistoryPanelProps) {
  const [rows, setRows] = useState<BootstrapListItem[]>([]);
  const [filter, setFilter] = useState<"all" | "in_flight" | "failed" | "active">("all");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editInitial, setEditInitial] = useState<{
    branch: string;
    composePath: string;
    upstreamService: string | null;
    upstreamPort: number | null;
    remotePath: string;
    repoUrl: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await bootstrapApi.listForServer(serverId, filter);
      setRows(res.bootstraps);
    } catch {
      /* surfaced upstream */
    }
  }, [serverId, filter]);

  useEffect(() => {
    void refresh();
    const unsub = wsClient.subscribe("bootstrap", (msg) => {
      if (msg.type === "bootstrap.state-changed") void refresh();
    });
    return unsub;
  }, [refresh]);

  const openEdit = async (id: string) => {
    const s = await bootstrapApi.getState(id);
    setEditInitial({
      branch: "main", // server doesn't expose it on the state shape; admin re-types
      composePath: s.composePath,
      upstreamService: s.upstreamService,
      upstreamPort: s.upstreamPort,
      remotePath: "",
      repoUrl: "",
    });
    setEditId(id);
  };

  return (
    <section className="border border-gray-800 rounded p-3 bg-gray-950 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Bootstrap history</h3>
        <select
          className="bg-gray-800 border border-gray-700 rounded text-xs px-2 py-1"
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="all">All</option>
          <option value="in_flight">In flight</option>
          <option value="failed">Failed</option>
          <option value="active">Active</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-500">No bootstrapped apps on this server.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="py-1">Name</th>
              <th>State</th>
              <th>Created</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const inflight = IN_FLIGHT.includes(r.bootstrapState);
              const failed = r.bootstrapState.startsWith("failed_");
              return (
                <tr key={r.id} className="border-t border-gray-800">
                  <td className="py-1 font-mono">{r.name}</td>
                  <td>
                    <BootstrapStateBadge state={r.bootstrapState} />
                    {!inflight && !failed && r.bootstrapState === "active" && (
                      <span className="text-green-400">active</span>
                    )}
                  </td>
                  <td className="text-gray-500">{r.createdAt.slice(0, 19).replace("T", " ")}</td>
                  <td className="text-right space-x-2">
                    {inflight && (
                      <button
                        type="button"
                        className="px-2 py-0.5 rounded bg-gray-700"
                        onClick={() => setResumeId(r.id)}
                      >
                        Resume
                      </button>
                    )}
                    {failed && (
                      <>
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded bg-blue-700"
                          onClick={() => setResumeId(r.id)}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded bg-gray-700"
                          onClick={() => void openEdit(r.id)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded bg-red-700"
                          onClick={() => setDeleteId(r.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {r.bootstrapState === "active" && (
                      <a
                        href={`/apps/${r.id}`}
                        className="px-2 py-0.5 rounded bg-gray-700 inline-block"
                      >
                        View app
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {resumeId && <BootstrapProgressView appId={resumeId} onClose={() => setResumeId(null)} />}
      {editId && editInitial && (
        <EditBootstrapConfigDialog
          appId={editId}
          initial={editInitial}
          onClose={() => setEditId(null)}
          onSaved={() => {
            setEditId(null);
            void refresh();
          }}
        />
      )}
      {deleteId && (
        <HardDeleteDialog
          appId={deleteId}
          appName={rows.find((r) => r.id === deleteId)?.name ?? ""}
          onClose={() => setDeleteId(null)}
          onDeleted={() => {
            setDeleteId(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
