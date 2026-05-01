import React, { useEffect, useMemo, useRef, useState } from "react";
import { useJob, type JobProgress } from "../../hooks/useJob.js";
import { RemoteLogTailModal } from "./RemoteLogTailModal.js";

interface DeployLogProps {
  jobId: string;
  /**
   * Optional — when set, enables the "Stream remote log" affordance for
   * self-deploy scenarios. The DeployLog scans incoming lines for the
   * detach marker emitted by `scripts/deploy/server-deploy.sh` and surfaces
   * a button to live-tail the on-target log file via /file-tail endpoint.
   */
  serverId?: string;
}

// Marker emitted by server-deploy.sh when it self-detaches. Format:
//   🔌 Self-deploy detected (<project>) — handing off ... tail <ABS_PATH> for progress
// We parse the absolute log path off the trailing "tail <path> for progress" tail.
const SELF_DEPLOY_MARKER_REGEX = /Self-deploy detected.*tail\s+(\/[\x20-\x7E]+?\.log)\b/;

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-900/50 text-blue-400 border-blue-700",
  success: "bg-green-900/50 text-green-400 border-green-700",
  failed: "bg-red-900/50 text-red-400 border-red-700",
  cancelled: "bg-yellow-900/50 text-yellow-400 border-yellow-700",
  idle: "bg-gray-800 text-gray-400 border-gray-600",
};

const ANSI_COLORS: Record<string, string> = {
  "30": "text-gray-500",
  "31": "text-red-400",
  "32": "text-green-400",
  "33": "text-yellow-400",
  "34": "text-blue-400",
  "35": "text-purple-400",
  "36": "text-cyan-400",
  "37": "text-gray-200",
  "90": "text-gray-500",
  "91": "text-red-300",
  "92": "text-green-300",
  "93": "text-yellow-300",
  "94": "text-blue-300",
  "95": "text-purple-300",
  "96": "text-cyan-300",
  "97": "text-white",
  "1": "font-bold",
};

function parseAnsiLine(line: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // eslint-disable-next-line no-control-regex
  const regex = /\x1b\[(\d+(?:;\d+)*)m/g;
  let lastIndex = 0;
  let activeClasses: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    // Push text before this escape
    if (match.index > lastIndex) {
      const text = line.slice(lastIndex, match.index);
      parts.push(
        activeClasses.length > 0 ? (
          <span key={lastIndex} className={activeClasses.join(" ")}>
            {text}
          </span>
        ) : (
          text
        ),
      );
    }

    const codes = match[1]!.split(";");
    for (const code of codes) {
      if (code === "0") {
        activeClasses = [];
      } else {
        const cls = ANSI_COLORS[code];
        if (cls) activeClasses.push(cls);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < line.length) {
    const text = line.slice(lastIndex);
    parts.push(
      activeClasses.length > 0 ? (
        <span key={lastIndex} className={activeClasses.join(" ")}>
          {text}
        </span>
      ) : (
        text
      ),
    );
  }

  return parts.length > 0 ? parts : [line];
}

function ProgressSteps({ steps }: { steps: JobProgress[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {steps.map((step, i) => {
        const isComplete = step.status === "complete" || step.status === "done";
        const isRunning = step.status === "running" || step.status === "in_progress";
        const isFailed = step.status === "failed" || step.status === "error";

        let dotClass = "bg-gray-600";
        if (isComplete) dotClass = "bg-green-500";
        else if (isRunning) dotClass = "bg-blue-500 animate-pulse";
        else if (isFailed) dotClass = "bg-red-500";

        return (
          <div
            key={i}
            className="flex items-center gap-1.5 text-xs text-gray-400"
          >
            <span className={`w-2 h-2 rounded-full ${dotClass}`} />
            <span className={isComplete ? "text-green-400" : isFailed ? "text-red-400" : ""}>
              {step.step}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DeployLog({ jobId, serverId }: DeployLogProps) {
  const { status, logs, progress, error } = useJob(jobId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tailOpen, setTailOpen] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  // Detect "Self-deploy detected" marker in any line; capture the log path.
  // Memoised — re-scans only when log volume or serverId changes.
  const remoteLogPath = useMemo(() => {
    if (!serverId) return null;
    for (const line of logs) {
      const m = SELF_DEPLOY_MARKER_REGEX.exec(line);
      if (m) return m[1] ?? null;
    }
    return null;
  }, [logs, serverId]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-300">Job</span>
          <code className="text-xs text-gray-500 font-mono">{jobId.slice(0, 8)}</code>
        </div>
        <div className="flex items-center gap-2">
          {remoteLogPath && serverId && (
            <button
              type="button"
              onClick={() => setTailOpen(true)}
              className="text-xs px-2 py-0.5 rounded border border-purple-700 text-purple-300 hover:bg-purple-950/40"
              title={`Live tail ${remoteLogPath} via /file-tail`}
            >
              📜 Stream remote log
            </button>
          )}
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] ?? STATUS_STYLES.idle}`}
          >
            {status}
          </span>
        </div>
      </div>

      <ProgressSteps steps={progress} />

      <div
        ref={scrollRef}
        className="overflow-auto max-h-96 p-4 font-mono text-xs leading-5 bg-gray-950"
        role="log"
        aria-live="polite"
        aria-label="Deployment log output"
      >
        {logs.length === 0 && status === "running" && (
          <div className="text-gray-600 animate-pulse">Waiting for output...</div>
        )}
        {logs.map((line, i) => (
          <div key={i} className="text-gray-300 whitespace-pre-wrap break-all">
            {parseAnsiLine(line)}
          </div>
        ))}
      </div>

      {error && (
        <div className="px-4 py-2 border-t border-red-900/50 bg-red-950/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {status === "success" && (
        <div className="px-4 py-2 border-t border-green-900/50 bg-green-950/30 text-green-400 text-sm">
          {remoteLogPath
            ? "Detached — see Stream remote log for actual progress"
            : "Deployment completed successfully"}
        </div>
      )}

      {tailOpen && remoteLogPath && serverId && (
        <RemoteLogTailModal
          serverId={serverId}
          path={remoteLogPath}
          onClose={() => setTailOpen(false)}
        />
      )}
    </div>
  );
}
