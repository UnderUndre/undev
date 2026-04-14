import React, { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { useChannel } from "../../hooks/useWebSocket.js";
import type { WsMessage } from "../../lib/ws.js";

interface LogViewerProps {
  serverId: string;
}

interface LogEntry {
  id: number;
  text: string;
  timestamp: string;
}

let entryId = 0;

export function LogViewer({ serverId }: LogViewerProps) {
  const [source, setSource] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldScroll = useRef(true);

  const { data: sources, isLoading: sourcesLoading } = useQuery({
    queryKey: ["server", serverId, "log-sources"],
    queryFn: () => api.get<string[]>(`/servers/${serverId}/logs/sources`),
    enabled: Boolean(serverId),
  });

  const channel = source ? `logs:${serverId}:${source}` : null;
  const { lastMessage } = useChannel(channel);

  // Clear logs when source changes
  useEffect(() => {
    setLogs([]);
    shouldScroll.current = true;
    setIsPaused(false);
  }, [source]);

  // Append log entries from WebSocket
  useEffect(() => {
    if (!lastMessage || isPaused) return;

    const msg = lastMessage as WsMessage;
    const text =
      typeof msg.data === "string"
        ? msg.data
        : (msg.data as { message?: string })?.message ?? JSON.stringify(msg.data);

    setLogs((prev) => {
      const next = [
        ...prev,
        { id: ++entryId, text, timestamp: msg.timestamp },
      ];
      // Keep max 1000 lines in memory
      if (next.length > 1000) return next.slice(-1000);
      return next;
    });
  }, [lastMessage, isPaused]);

  // Auto-scroll
  useEffect(() => {
    if (!shouldScroll.current || isPaused) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, isPaused]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    shouldScroll.current = atBottom;
  };

  const filteredLogs = filter
    ? logs.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Log Viewer</h2>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={source ?? ""}
          onChange={(e) => setSource(e.target.value || null)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          aria-label="Select log source"
        >
          <option value="">Select source...</option>
          {sourcesLoading && <option disabled>Loading...</option>}
          {sources?.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs..."
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 w-48"
          aria-label="Filter log output"
        />

        <button
          onClick={() => {
            setIsPaused((p) => !p);
            if (isPaused) shouldScroll.current = true;
          }}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
            isPaused
              ? "border-yellow-700 bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/50"
              : "border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800"
          }`}
        >
          {isPaused ? "Resume" : "Pause"}
        </button>

        <button
          onClick={() => setLogs([])}
          className="px-3 py-2 rounded-lg text-sm font-medium transition-colors border border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800"
        >
          Clear
        </button>
      </div>

      {/* Log Output */}
      {!source ? (
        <div className="text-center py-12 text-gray-600">
          Select a log source to start streaming.
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="bg-gray-950 border border-gray-800 rounded-lg overflow-auto max-h-[600px] p-4 font-mono text-xs leading-5"
          role="log"
          aria-live="polite"
          aria-label="Log output"
        >
          {filteredLogs.length === 0 && (
            <p className="text-gray-600 animate-pulse">
              Waiting for log entries...
            </p>
          )}
          {filteredLogs.map((entry) => (
            <div key={entry.id} className="text-gray-300 whitespace-pre-wrap break-all">
              <span className="text-gray-600 mr-2 select-none">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              {entry.text}
            </div>
          ))}
        </div>
      )}

      {isPaused && source && (
        <p className="text-xs text-yellow-400">
          Log streaming paused. New entries are buffered.
        </p>
      )}
    </div>
  );
}
