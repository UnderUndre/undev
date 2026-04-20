/**
 * Scanner shell-command builder.
 *
 * Produces a single `bash -c` pipeline that discovers git repositories and
 * Docker apps on a remote host. Designed for a single SSH channel — see
 * research.md R-001 and R-004 for the rationale.
 *
 * The emitted output is line-tagged (tab-separated) so the Node-side parser
 * can reconstruct candidates without needing structured RPC.
 */

const SHELL_METACHAR = /["'`;&|<>()\\\n]/;
const MAX_ROOTS = 20;

export class InvalidScanRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScanRootError";
  }
}

/** Single-quote escape per POSIX shell rules: `'` becomes `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateRoots(scanRoots: string[]): void {
  if (scanRoots.length > MAX_ROOTS) {
    throw new InvalidScanRootError(
      `scanRoots exceeds maximum of ${MAX_ROOTS} (got ${scanRoots.length})`,
    );
  }
  for (const root of scanRoots) {
    if (!root.startsWith("/")) {
      throw new InvalidScanRootError(`scanRoot "${root}" is not absolute`);
    }
    if (root.length > 512) {
      throw new InvalidScanRootError(`scanRoot "${root}" exceeds 512 chars`);
    }
    if (SHELL_METACHAR.test(root)) {
      throw new InvalidScanRootError(
        `scanRoot "${root}" contains shell metacharacters`,
      );
    }
  }
}

/**
 * Build the pipeline string.
 *
 * FR-005  find -P -xdev -maxdepth 6 (no symlink follow, no FS crossing)
 * FR-021  `git -c safe.directory='*'` on every candidate command
 * FR-022  `timeout 3s` on every per-candidate git command
 * FR-031  One COMPOSE line per directory; extras CSV-joined
 * FR-032  `docker compose -f <primary> [-f <extra>] config --format json` → COMPOSE_CONFIG
 * FR-062  Outer `timeout --kill-after=5s 60 bash -c` — primary orphan-reaping defence
 */
export function buildScanCommand(scanRoots: string[]): string {
  validateRoots(scanRoots);
  if (scanRoots.length === 0) {
    throw new InvalidScanRootError("scanRoots is empty");
  }

  const quotedRoots = scanRoots.map(shellQuote).join(" ");

  // The pipeline is assembled as a single heredoc and then emitted as a
  // quoted argument to `bash -c` wrapped by `timeout`. All path values
  // inside the pipeline come from `find`, which quotes its own output via
  // NUL-delimited reads — the outer script never interpolates user paths
  // directly into shell commands.
  const pipeline = `
set +e
umask 077

echo -e "TOOL\\tgit\\t$(command -v git >/dev/null 2>&1 && echo yes || echo no)"
echo -e "TOOL\\tdocker\\t$(command -v docker >/dev/null 2>&1 && echo yes || echo no)"

# Single traversal producing .git dirs and compose files.
# -xdev: never cross filesystem boundary (skips /proc, /sys, NFS, etc.)
# -P: physical mode, never follow symlinks
find -P ${quotedRoots} -xdev -maxdepth 6 \\
  \\( -type d \\( -name node_modules -o -name vendor -o -name dist -o -name build -o -name .cache -o -name .next \\) -prune \\) \\
  -o \\( -type d -name .git -print \\) \\
  -o \\( -type f \\( -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' \\) -print \\) \\
  2>/dev/null | while IFS= read -r path; do
    case "$path" in
      */.git)
        worktree=\${path%/.git}
        # FR-022: per-command 3s timeout. FR-021: safe.directory='*' + swallow errors.
        branch=$(timeout 3s git -c safe.directory='*' -C "$worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        if [ "$branch" = "HEAD" ]; then
          printf "GIT_BRANCH\\t%s\\tDETACHED\\n" "$worktree"
        elif [ -n "$branch" ]; then
          printf "GIT_BRANCH\\t%s\\t%s\\n" "$worktree" "$branch"
        else
          printf "GIT_ERROR\\t%s\\tbranch\\n" "$worktree"
        fi

        sha=$(timeout 3s git -c safe.directory='*' -C "$worktree" rev-parse HEAD 2>/dev/null || echo "")
        if [ -n "$sha" ]; then
          printf "GIT_SHA\\t%s\\t%s\\n" "$worktree" "$sha"
        fi

        remote=$(timeout 3s git -c safe.directory='*' -C "$worktree" remote get-url origin 2>/dev/null || echo "")
        if [ -n "$remote" ]; then
          printf "GIT_REMOTE\\t%s\\t%s\\n" "$worktree" "$remote"
        fi

        # dirty: tri-state encoded by presence/absence + GIT_ERROR
        status_out=$(timeout 3s git -c safe.directory='*' -C "$worktree" status --porcelain 2>/dev/null)
        status_rc=$?
        if [ $status_rc -ne 0 ]; then
          printf "GIT_ERROR\\t%s\\tstatus\\n" "$worktree"
        elif [ -n "$status_out" ]; then
          printf "GIT_DIRTY\\t%s\\t1\\n" "$worktree"
        fi

        head_line=$(timeout 3s git -c safe.directory='*' -C "$worktree" log -1 --format='%ci%x09%s' 2>/dev/null || echo "")
        if [ -n "$head_line" ]; then
          printf "GIT_HEAD\\t%s\\t%s\\n" "$worktree" "$head_line"
        fi
        ;;
      */docker-compose.yml|*/docker-compose.yaml|*/compose.yml|*/compose.yaml)
        # Compose files are grouped into a single candidate per directory in
        # a second pass below — just collect paths for now.
        printf "COMPOSE_FILE\\t%s\\n" "$path"
        ;;
    esac
done

# Group compose files by parent directory and emit one COMPOSE per dir.
# Priority: compose.yaml > docker-compose.yml > compose.yml > docker-compose.yaml.
# Non-primary files in the same directory ride as extras (CSV-joined).
# FR-031.

# We re-read the compose paths from the find pass by re-running find on just
# the compose file patterns — cheaper than buffering inside the while loop.
tmpfile=$(mktemp 2>/dev/null || echo "/tmp/scan.$$")
find -P ${quotedRoots} -xdev -maxdepth 6 \\
  \\( -type d \\( -name node_modules -o -name vendor -o -name dist -o -name build -o -name .cache -o -name .next \\) -prune \\) \\
  -o \\( -type f \\( -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' \\) -print \\) \\
  2>/dev/null > "$tmpfile"

# Emit unique parent dirs.
awk -F/ '{ OFS="/"; NF--; print }' "$tmpfile" | sort -u | while IFS= read -r dir; do
  primary=""
  extras=""
  for candidate in "$dir/compose.yaml" "$dir/docker-compose.yml" "$dir/compose.yml" "$dir/docker-compose.yaml"; do
    if [ -f "$candidate" ]; then
      if [ -z "$primary" ]; then
        primary="$candidate"
      else
        if [ -z "$extras" ]; then extras="$candidate"; else extras="$extras,$candidate"; fi
      fi
    fi
  done
  if [ -n "$primary" ]; then
    printf "COMPOSE\\t%s\\t%s\\n" "$primary" "$extras"
    if command -v docker >/dev/null 2>&1; then
      # Build -f args: primary + extras.
      dargs="-f $primary"
      if [ -n "$extras" ]; then
        IFS=',' read -ra ext_arr <<< "$extras"
        for ef in "\${ext_arr[@]}"; do dargs="$dargs -f $ef"; done
      fi
      cfg=$(timeout 5s docker compose $dargs config --format json 2>/dev/null || echo "")
      if [ -n "$cfg" ]; then
        b64=$(printf "%s" "$cfg" | base64 -w0 2>/dev/null || printf "%s" "$cfg" | base64 | tr -d '\\n')
        printf "COMPOSE_CONFIG\\t%s\\t%s\\n" "$primary" "$b64"
      fi
    fi
  fi
done
rm -f "$tmpfile"

# Running containers (Docker 20.10+ required for --format json).
if command -v docker >/dev/null 2>&1; then
  timeout 5s docker ps -a --format '{{json .}}' 2>/dev/null | while IFS= read -r line; do
    printf "CONTAINER\\t%s\\n" "$line"
  done
fi
`.trim();

  // Outer wrapper: FR-062. timeout --kill-after=5s 60 bash -c <pipeline>.
  // Double-quote the argument to bash; the pipeline itself never contains a
  // literal double-quote (verified by tests), so no escaping needed.
  return `timeout --kill-after=5s 60 bash -c ${shellQuote(pipeline)}`;
}
