# Research: Scan Server for Existing Repositories and Docker Apps

**Phase 0 output** | **Date**: 2026-04-20

---

## R-001: Scan Traversal Strategy — One SSH Pipeline vs Many Commands

**Decision**: Build a single bash pipeline, execute via `sshPool.execStream()`, and parse line-tagged output on the Node side.

**Rationale**: SC-002 requires a 200-candidate scan under 15 seconds on a 2-vCPU VPS. Per-candidate SSH round-trips via `sshPool.exec()` cost ~30–100 ms each (channel open + command + close over an already-open connection). 200 candidates × 50 ms ≈ 10 s just in round-trips, leaving no budget for actual work. Folding everything into one shell pipeline eliminates round-trips entirely: one channel, one stream of tagged lines.

**Pipeline shape**:

```bash
set -e
echo "TOOL\tgit\t$(command -v git >/dev/null && echo yes || echo no)"
echo "TOOL\tdocker\t$(command -v docker >/dev/null && echo yes || echo no)"

# 1. Find all .git dirs and compose files under the configured roots (single pass, with prune)
find "$ROOT1" "$ROOT2" ... -maxdepth 6 \
  \( -name node_modules -o -name vendor -o -name dist -o -name build -o -name .cache -o -name .next \) -prune \
  -o \( -type d -name .git -print -o -name docker-compose.yml -print -o -name compose.yaml -print ... \) 2>/dev/null | \
while read -r path; do
  case "$path" in
    */.git)
      worktree=$(dirname "$path")
      # 2. Read git metadata inside a timeout, tolerate errors
      git -C "$worktree" rev-parse --abbrev-ref HEAD 2>/dev/null | sed "s|^|GIT_BRANCH\t$worktree\t|"
      git -C "$worktree" rev-parse HEAD 2>/dev/null       | sed "s|^|GIT_SHA\t$worktree\t|"
      git -C "$worktree" remote get-url origin 2>/dev/null | sed "s|^|GIT_REMOTE\t$worktree\t|"
      git -C "$worktree" status --porcelain 2>/dev/null | head -1 | sed "s|.*|GIT_DIRTY\t$worktree\t1|"
      git -C "$worktree" log -1 --format='%ci%x09%s' 2>/dev/null | sed "s|^|GIT_HEAD\t$worktree\t|"
      ;;
    */docker-compose.yml|*/compose.yaml|*/compose.yml|*/docker-compose.yaml)
      echo "COMPOSE\t$path"
      ;;
  esac
done

# 3. Docker containers (once, at the end)
if command -v docker >/dev/null; then
  docker ps -a --format '{{json .}}' 2>/dev/null | sed "s|^|CONTAINER\t|"
fi
```

**Parsing** (Node side): split on `\n`, split each line on `\t`, dispatch by first field into candidate aggregators keyed by worktree path. O(n) in output size.

**Alternatives considered**:
- **`sshPool.exec()` per candidate**: Simple but blows the 15 s budget on 200 candidates (see numbers above).
- **SFTP directory walk + metadata via `exec`**: SFTP walk is slower than `find` for deep trees, and still needs `exec` for git metadata. No net gain.
- **Install a helper binary on the server**: Violates zero-infra promise of the feature — admins would have to deploy something to use the dashboard.

---

## R-002: Docker Detection Without New Tooling

**Decision**: Reuse the existing `docker ps --format` pattern from `routes/docker.ts` (line 28) and add a compose-file find pass to the same `find` call used for `.git` detection.

**Rationale**: The codebase already shells out to `docker ps` and parses JSON on the Node side. No new pattern, no risk of divergence. Compose files are just filenames, so they can be caught by the same `find` used for git — no second traversal.

**Matching a standalone container to a `remotePath`**: `docker inspect` returns labels; `com.docker.compose.project.working_dir` exists for compose-managed containers and gives us the on-disk location. For non-compose containers we leave `remotePath` blank and let the admin fill it — this is an edge case (SC-006 covers only the compose path).

**One candidate per directory** (FR-031 update): multiple compose files in the same directory are common (`docker-compose.yml` + `docker-compose.prod.yml` + `docker-compose.override.yml`). Emitting three candidates for the same stack spams the UI and creates dedup ambiguity. The pipeline groups by directory, picks a primary file by priority `compose.yaml` > `docker-compose.yml` > `compose.yml` > `docker-compose.yaml`, and passes the rest as additional `-f` flags to `docker compose config` so the merged result is canonical.

**Services detail via docker CLI**: for each primary compose file the scan pipeline runs `docker compose -f <primary> -f <override1> ... config --format json 2>/dev/null` — docker's own YAML parser produces a canonical JSON with `services` object containing service name → image. This is emitted as a tab-safe `COMPOSE_CONFIG\t<primary-path>\t<base64-json>` line. Node side base64-decodes and validates with Zod. Handcrafted awk/grep YAML parsing was rejected as fragile (comments, non-canonical indentation, anchors break it). Any `CONTAINER` whose name matches `<compose-project>_<service>_<N>` or `<compose-project>-<service>-<N>` gets folded into the compose candidate and is **not** reported as a standalone. When docker is unavailable on the server, the `COMPOSE` candidate is still emitted with `services: []` so the admin can still import it — services detail is nice-to-have, not load-bearing.

**Minimum docker version**: `docker compose` as a subcommand (not the legacy `docker-compose` binary) and `--format json` both require Docker Engine ≥ 20.10. Older hosts degrade to `dockerAvailable: false`. Documented in quickstart; not auto-detected (legacy-binary compat adds code for a vanishingly small user population).

**Alternatives considered**:
- **Docker Engine HTTP API over SSH tunnel**: Requires exposing the socket, adds auth complexity. Rejected.
- **Read `/var/lib/docker/containers/*/config.v2.json`**: Fragile, requires root. Rejected.

---

## R-003: Flagging "Do Not Clone on First Deploy"

**Decision**: Add a boolean column `applications.skipInitialClone` (default `false`). Scan-imported apps set it to `true`. The deploy runner checks the flag and skips `git clone`, using `git fetch origin <branch> && git reset --hard FETCH_HEAD` against the existing working tree.

**Rationale**: FR-052 requires that scan-imported apps use the existing working tree. There are three places this could live:

1. **New column on `applications`** — explicit, easy to query, zero ambiguity for the deploy runner. **Chosen.**
2. Detect at deploy time by probing whether `remotePath` already exists and has a `.git` — flaky (race with external actors), needs an extra SSH round-trip every deploy, and changes behaviour for manually-added apps in a surprising way.
3. A separate `applicationImports` audit table — correct for audit purposes but overkill for a single boolean; doesn't remove the need for the deploy runner to know the answer.

Default `false` means existing apps (added before this migration) keep their clone-on-first-deploy behaviour unchanged.

**Alternatives considered**:
- **Sentinel `currentCommit = "SCAN_IMPORT"`**: Overloads a field that's supposed to be a git SHA. Rejected — would break FR-041 validation regex (`^[0-9a-f]{7,40}$`).
- **Infer from `githubRepo IS NULL`**: Wrong — manual-add apps with a non-GitHub repo would also match. Rejected.

---

## R-004: Cancellation Semantics

**Decision**: Four layers of defence against orphaned work:

1. **Client**: `useScan` hook holds an `AbortController`; the modal's Cancel button calls `controller.abort()`, which aborts the `fetch()` to `/api/servers/:id/scan`.
2. **Server route**: listens for `req.on("close")` (fires when the underlying TCP socket closes — same event `fetch` abort produces). On close, calls `kill()` on the saved `ClientChannel` handle.
3. **SSH pool**: `sshPool.execStream()` already returns `{ stream, kill }`. `kill()` sends `SIGKILL` to the remote shell (line 206 in `ssh-pool.ts`) and closes the stream.
4. **Server-side `timeout` wrapper (primary defence)**: the entire pipeline is invoked as `timeout --kill-after=5s 60 bash -c '<pipeline>'` on the remote shell. This guarantees the 60 s bound holds **even if the SSH channel is severed mid-scan** — orphan `find`/`git` descendants would otherwise survive channel kill (especially when stuck in `D`-state on an NFS mount). `timeout` sends `SIGTERM` at 60 s, then `SIGKILL` 5 s later if the pipeline ignores the term.

**Rationale**: SC-003 requires no orphan processes. Relying on SSH-channel kill alone is insufficient — `ssh2` closes the channel, but the remote shell's children are not always reparented and killed cleanly, particularly with processes blocked on network I/O. The server-side `timeout` wrapper is the load-bearing mechanism. The three upstream layers exist for low-latency cancellation (sub-second) and client UX.

**Scoped concurrency lock** (FR-074): a `Map<serverId, { since, userId, abort }>` lives in the scanner module. Entry is set at scan start, deleted in `finally`. A second `POST /api/servers/:id/scan` while the entry exists returns **409 `SCAN_IN_PROGRESS`** with `{ since, byUserId }`. Lock is per-process; a dashboard restart clears all locks — acceptable because the worst case on restart is one stale in-flight scan on a server, which will either finish or hit `timeout 60`.

**Why not a DB-backed lock**: the feature is explicitly scoped to single-instance self-hosted dashboards (see Assumptions). A DB lock would require a new table, cleanup cron, and crash-recovery logic — complexity disproportionate to the protection it adds for this deployment model.

**Edge cases**:
- If the SSH connection drops mid-scan, `stream.on("close")` fires with a non-zero code; the route returns `{ partial: true, error: "SSH disconnected" }`.
- If `kill()` is called on an already-closed stream, `ssh2` is idempotent (no-op).

**Alternatives considered**:
- **Polling endpoint + job id**: Turns a synchronous HTTP call into a workflow. Unnecessary complexity for a 60 s operation.
- **WebSocket for scan progress**: Would be nicer UX (stream candidates as discovered) but doubles the delivery surface and needs reconnection logic. Deferred as a v2 polish.

---

## R-005: Schema Handling for Docker-only Apps

**Decision**: Keep the existing `createAppSchema` strict. Docker-only candidates are imported with `repoUrl = "docker://<absolute-path-or-container-name>"` and `branch = "-"`. The deploy runner recognises the `docker://` prefix and skips all git operations.

**Rationale**: The alternative — making `repoUrl` nullable — forces every consumer (UI list, deploy runner, audit log, deploy-script validator, export) to null-check. The sentinel prefix preserves the uniform shape, is human-readable, and makes the Docker nature of the app visible in any list that prints `repoUrl`.

The regex currently enforced is `z.string().min(1)` — no format constraint. `docker://` trivially satisfies it. The `githubRepo` field stays strict (`owner/repo` regex) and is `null` for Docker apps.

**Alternatives considered**:
- **Polymorphic app type (`kind: "git" | "docker"`)**: Biggest change, broadest surface, biggest test matrix. Rejected — not justified by one feature.
- **Nullable `repoUrl` and `branch`**: Simplest on paper, but forces null-handling everywhere downstream. Rejected.

---

## R-006: Scan Roots Configuration

**Decision**: Add a `scanRoots` jsonb column on `servers` (array of absolute paths). Defaults to `["/opt", "/srv", "/var/www", "/home"]` plus the server's `scriptsPath` (de-duplicated). Admins can edit the list via the existing server edit form.

**Rationale**: FR-004 requires a configurable, whitelisted set. Storing on the server row keeps it co-located with other server-specific config, avoids a new table, and is naturally cleaned up by the existing `ON DELETE CASCADE` chain.

**Validation on write**: each entry must be an absolute path (`/^\//`), have no shell metacharacters (`"';&|`$\\<>()`), and be ≤ 512 chars. This is belt-and-braces — the shell command uses single-quoted arguments anyway.

**Alternatives considered**:
- **Hardcoded list**: Fails FR-004.
- **New `server_scan_config` table**: Overkill for an array of strings.

---

## R-007: Filesystem-Type Guard on `scanRoots`

**Decision**: On server create/update, validate each `scanRoots` entry by running `stat -f -c %T <root>` over SSH and rejecting the write if any root sits on `nfs`, `nfs4`, `cifs`, `smbfs`, or `fuse.sshfs`. Error code: 400 `NON_LOCAL_FS`.

**Rationale**: A `find` walk into a dead NFS mount parks the process in uninterruptible sleep (`D`-state) — no amount of `timeout`, `SIGKILL`, or SSH channel kill can reap it. The only reliable defence is to refuse such roots at validation time. Legitimate use cases for scanning a remote FS are rare; the common case is "admin didn't realise `/home` is NFS-mounted".

**Alternatives considered**:
- **Detect at scan time, skip silently**: misleading — admin thinks `/mnt/nfs` was scanned and no candidates found, but it was silently excluded.
- **Allow with warning**: user clicks past, scan hangs, we're on the hook for diagnosing why `timeout 60` "didn't work".
- **Do nothing**: observed behaviour today. Fails SC-003 in the NFS-mount scenario.

**Path normalisation** (FR-040 related): to prevent cosmetic-difference dedup misses (`/opt/app` vs `/opt/app/`), `applications.remotePath` is normalised on write via `.replace(/\/{2,}/g, "/").replace(/\/+$/, "")`. Symlinks are deliberately not resolved — that would require an extra `readlink -f` SSH call per dedup check and leak FS state into validation. Admins who add the same target under two symlink paths are treated as out-of-contract.

---

## Summary of Unknowns Resolved

| Spec reference | Decision |
|---|---|
| Traversal strategy (FR-003, SC-002) | Single SSH pipeline, line-tagged output, `find -P -xdev -maxdepth 6` (R-001) |
| Docker detection (FR-030..34, one-per-dir grouping) | Reuse `docker ps --format`, compose via same `find`, `docker compose config --format json` for services (R-002) |
| No-clone import (FR-052) | `applications.skipInitialClone` boolean, deploy via `fetch` + `reset --hard FETCH_HEAD` (R-003) |
| Cancellation & no-orphans (FR-062, SC-003) | Server-side `timeout 60 bash -c` + SSH `kill()` + client abort; in-memory per-server concurrency lock (FR-074) (R-004) |
| Docker-only schema (FR-053) | `docker://<path>` sentinel, no schema relaxation (R-005) |
| Configurable roots (FR-004) | `servers.scanRoots jsonb` column with default (R-006) |
| NFS/CIFS guard (FR-073), path normalisation (FR-040) | `stat -f -c %T` probe on write + textual normalisation (R-007) |
