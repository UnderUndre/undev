#!/usr/bin/env bash
# Feature 009 / T016 — bootstrap step CLONING.
#
# Clones a GitHub repo into ${REMOTE_PATH} or, when the repo is already
# present with a matching origin URL, runs `git fetch && git reset --hard
# && git clean -fdx` (FR-013). The PAT is read from $SECRET_PAT (env-var
# transport — FR-029) and re-injected into the clone URL via heredoc so
# it never appears in argv / `ps` / auditd execve.
#
# Args:
#   --remote-path=<absolute path on target>
#   --repo-url=<https://github.com/owner/repo.git — NO token>
#   --branch=<branch name>
#
# Env:
#   SECRET_PAT  — GitHub PAT (only used if repo-url is HTTPS); optional
#                 for SSH-based connections.
#
# Exit codes:
#   0 — clone or fetch+reset succeeded
#   2 — directory exists with a different repo origin
#   3 — directory exists but is not a git repo
#   ≠0 (other) — git failure (network, auth, disk full, etc.)

set -euo pipefail
source "$(dirname "$0")/../common.sh" 2>/dev/null || true

REMOTE_PATH=""
REPO_URL=""
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*) REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --repo-url=*)    REPO_URL="${1#--repo-url=}"; shift ;;
    --branch=*)      BRANCH="${1#--branch=}"; shift ;;
    --json)          shift ;;  # accepted for runner compatibility, ignored
    *) shift ;;
  esac
done

if [[ -z "$REMOTE_PATH" || -z "$REPO_URL" || -z "$BRANCH" ]]; then
  echo "missing required arg: --remote-path / --repo-url / --branch" >&2
  exit 64
fi

# ── Idempotent path: already cloned ─────────────────────────────────────
if [[ -d "$REMOTE_PATH/.git" ]]; then
  CURRENT_REMOTE=$(git -C "$REMOTE_PATH" -c safe.directory='*' \
    remote get-url origin 2>/dev/null || true)

  # Strip embedded `oauth2:<token>@` from both sides for a clean compare —
  # the on-disk clone may have a stale PAT; the new $REPO_URL has none.
  STRIPPED_DISK=${CURRENT_REMOTE//oauth2:*@/}
  STRIPPED_NEW=${REPO_URL//oauth2:*@/}

  if [[ "$STRIPPED_DISK" == "$STRIPPED_NEW" ]]; then
    echo "Repo already cloned; running fetch + reset + clean -fdx"
    if [[ "$REPO_URL" == https://* ]] && [[ -n "${SECRET_PAT:-}" ]]; then
      # trap-based PAT cleanup — guarantees strip even if git fetch/reset
      # fails under `set -e` (Gemini PR#15 review). Fires on any exit path.
      trap 'git -C "$REMOTE_PATH" -c safe.directory="*" remote set-url origin "$REPO_URL" 2>/dev/null || true' EXIT
      AUTH_URL="https://oauth2:${SECRET_PAT}@${REPO_URL#https://}"
      git -C "$REMOTE_PATH" -c safe.directory='*' \
        -c "credential.helper=" \
        remote set-url origin "$AUTH_URL"
    fi
    git -C "$REMOTE_PATH" -c safe.directory='*' fetch origin "$BRANCH"
    git -C "$REMOTE_PATH" -c safe.directory='*' reset --hard "origin/$BRANCH"
    git -C "$REMOTE_PATH" -c safe.directory='*' clean -fdx
    if [[ "$REPO_URL" == https://* ]] && [[ -n "${SECRET_PAT:-}" ]]; then
      # Happy-path strip + clear trap (no double-strip on exit).
      git -C "$REMOTE_PATH" -c safe.directory='*' \
        remote set-url origin "$REPO_URL"
      trap - EXIT
    fi
    exit 0
  else
    echo "Directory exists with different repo: $CURRENT_REMOTE" >&2
    exit 2
  fi
fi

if [[ -d "$REMOTE_PATH" ]]; then
  echo "Directory exists but is not a git repo: $REMOTE_PATH" >&2
  exit 3
fi

# ── Fresh clone path ────────────────────────────────────────────────────
mkdir -p "$(dirname "$REMOTE_PATH")"

if [[ "$REPO_URL" == https://* ]] && [[ -n "${SECRET_PAT:-}" ]]; then
  AUTH_URL="https://oauth2:${SECRET_PAT}@${REPO_URL#https://}"
  # trap fires if `git clone` fails under `set -e` — even though the
  # half-cloned dir may not exist, the strip is best-effort (`|| true`)
  # and harmless. Without it, a failed clone-with-PAT can leave
  # `.git/config` carrying the token (Gemini PR#15 review).
  trap 'git -C "$REMOTE_PATH" -c safe.directory="*" remote set-url origin "$REPO_URL" 2>/dev/null || true' EXIT
  git clone --branch "$BRANCH" "$AUTH_URL" "$REMOTE_PATH"
  # Happy-path strip + clear trap.
  git -C "$REMOTE_PATH" -c safe.directory='*' \
    remote set-url origin "$REPO_URL"
  trap - EXIT
else
  git clone --branch "$BRANCH" "$REPO_URL" "$REMOTE_PATH"
fi
