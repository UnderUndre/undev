#!/usr/bin/env bash
# Feature 009 / T019 — bootstrap step FINALISE.
#
# Reads `git rev-parse HEAD` from the cloned repo and emits a single JSON
# line on stdout for `outputArtifact: { type: 'json', captureFrom:
# 'stdout-json' }` capture per feature 005's pattern. Orchestrator reads
# `current_commit` from `script_runs.output_artifact` and persists it on
# the application row.
#
# Args:
#   --remote-path=<git working tree>

set -euo pipefail
source "$(dirname "$0")/../common.sh" 2>/dev/null || true

REMOTE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*) REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --json)          shift ;;
    *) shift ;;
  esac
done

if [[ -z "$REMOTE_PATH" ]]; then
  echo "missing required arg: --remote-path" >&2
  exit 64
fi

CURRENT_COMMIT=$(git -C "$REMOTE_PATH" -c safe.directory='*' rev-parse HEAD)
printf '{"currentCommit":"%s"}\n' "$CURRENT_COMMIT"
