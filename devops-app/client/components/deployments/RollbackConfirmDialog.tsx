import React, { useEffect, useRef } from "react";

export interface RollbackConfirmDialogProps {
  scriptPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RollbackConfirmDialog({
  scriptPath,
  onConfirm,
  onCancel,
}: RollbackConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rollback-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 max-w-md w-full space-y-3">
        <h2
          id="rollback-confirm-title"
          className="text-lg font-semibold text-white"
        >
          Rollback uses the builtin rollback script
        </h2>
        <p className="text-sm text-gray-300">
          This app runs a project-local deploy script (
          <code className="font-mono text-gray-100">{scriptPath}</code>) that
          may apply database migrations, cache warmups, or other changes that
          can&apos;t be undone by a simple <code>git reset</code>.
        </p>
        <p className="text-sm text-gray-300">
          The builtin rollback only reverts the git state and restarts
          containers. Any migrations or side-effects from the last deploy will
          remain.
        </p>
        <p className="text-sm text-gray-300">Continue anyway?</p>
        <div className="flex justify-end gap-3 pt-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-300 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors"
          >
            Rollback
          </button>
        </div>
      </div>
    </div>
  );
}
