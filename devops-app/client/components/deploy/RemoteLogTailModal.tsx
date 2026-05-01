import { useCallback, useEffect, useRef, useState } from "react";

// Live tail of a remote file via offset-based polling. Used for self-deploy
// scenarios where in-band SSH stdout pipe dies with the dashboard container
// recreate (incident 2026-05-01).
//
// Contract with backend:
//   GET /api/servers/:serverId/file-tail?path=<absolute>&offset=<bytes>
//   →  { chunk: string, newOffset: number, fileSize: number, eof: boolean }

interface Props {
  serverId: string;
  path: string;
  onClose: () => void;
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
}

interface TailResponse {
  chunk: string;
  newOffset: number;
  fileSize: number;
  eof: boolean;
}

interface ApiError {
  error: { code: string; message: string };
}

const DEFAULT_INTERVAL = 2000;

export function RemoteLogTailModal({
  serverId,
  path,
  onClose,
  intervalMs = DEFAULT_INTERVAL,
}: Props) {
  const [content, setContent] = useState("");
  const [offset, setOffset] = useState(0);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [eof, setEof] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setPaused] = useState(false);
  // Status hint surfaces transient retry state distinct from hard errors.
  const [statusHint, setStatusHint] = useState<"tailing" | "retrying" | "eof" | "error">(
    "tailing",
  );

  const offsetRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);
  const inFlightRef = useRef(false);
  const transientFailRef = useRef(0);

  // Pull next chunk. Idempotent — uses ref so concurrent timer ticks coalesce.
  // Transient errors (503/504) get retried silently with the next interval
  // tick; only after 5 consecutive failures do we surface a hard error to UI.
  const fetchTail = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const url = `/api/servers/${encodeURIComponent(serverId)}/file-tail?path=${encodeURIComponent(path)}&offset=${offsetRef.current}`;
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as ApiError | null;
        const msg = body?.error?.message ?? `HTTP ${resp.status}`;
        // 503 (SSH disconnected, lazy-connect mid-flight) and 504 are
        // transient. Surface "retrying" until the count crosses threshold.
        const isTransient = resp.status === 503 || resp.status === 504;
        if (isTransient) {
          transientFailRef.current += 1;
          if (transientFailRef.current < 5) {
            setStatusHint("retrying");
            setError(null);
          } else {
            setError(msg);
            setStatusHint("error");
          }
        } else {
          setError(msg);
          setStatusHint("error");
        }
        return;
      }
      const data = (await resp.json()) as TailResponse;
      if (data.chunk.length > 0) {
        setContent((prev) => prev + data.chunk);
      }
      offsetRef.current = data.newOffset;
      setOffset(data.newOffset);
      setFileSize(data.fileSize);
      setEof(data.eof);
      setError(null);
      setStatusHint(data.eof ? "eof" : "tailing");
      transientFailRef.current = 0;
    } catch (err) {
      // Network error → retry quietly up to threshold.
      transientFailRef.current += 1;
      if (transientFailRef.current < 5) {
        setStatusHint("retrying");
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setStatusHint("error");
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [serverId, path]);

  // Initial fetch + interval.
  useEffect(() => {
    void fetchTail();
    if (isPaused) return;
    const id = window.setInterval(() => {
      void fetchTail();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [fetchTail, isPaused, intervalMs]);

  // Auto-scroll to bottom unless user scrolled up. Sticky-bottom behaviour.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickyBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyBottomRef.current = distanceFromBottom < 24;
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Remote log tail"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-gray-200">Remote log tail</span>
            <code className="text-xs text-gray-500 font-mono">{path}</code>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${
                statusHint === "error"
                  ? "border-red-700 text-red-400 bg-red-950/40"
                  : statusHint === "eof"
                    ? "border-green-700 text-green-400 bg-green-950/40"
                    : statusHint === "retrying"
                      ? "border-orange-700 text-orange-400 bg-orange-950/40 animate-pulse"
                      : "border-yellow-700 text-yellow-400 bg-yellow-950/40 animate-pulse"
              }`}
            >
              {statusHint === "error"
                ? "error"
                : statusHint === "eof"
                  ? "up to date"
                  : statusHint === "retrying"
                    ? "reconnecting…"
                    : "tailing…"}
            </span>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-auto p-4 font-mono text-xs leading-5 bg-gray-950 text-gray-300 whitespace-pre-wrap break-all"
          role="log"
          aria-live="polite"
        >
          {content.length === 0 && !error && (
            <div className="text-gray-600 animate-pulse">
              Waiting for first chunk…
            </div>
          )}
          {content}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-800 text-xs text-gray-500 font-mono">
          <span>
            offset {offset.toLocaleString()}
            {fileSize !== null && ` / ${fileSize.toLocaleString()} bytes`}
          </span>
          {error && <span className="text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}
