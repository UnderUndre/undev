# Data Model: Scan Server for Existing Repositories and Docker Apps

**Phase 1 output** | **Date**: 2026-04-20

---

## Persistent Changes

### Extended Entity: `servers` (add column)

```ts
// Added to existing Server interface:
interface Server {
  // ... existing fields ...
  scanRoots: string[];   // absolute paths to traverse during scan; jsonb in DB
}
```

**Rules**:
- Default on insert: `["/opt", "/srv", "/var/www", "/home", <scriptsPath if set and not already in list>]`
- Each entry:
  - Starts with `/` (absolute path)
  - No shell metacharacters: `"';&|` `` ` `` `\` `<>()` `\n`
  - Length ≤ 512 chars
- Array length ≤ 20 — keeps the `find` command under shell argv limits
- Deduplicated on write (case-sensitive, exact match)

**Migration** (`0003_scan.sql`):
```sql
ALTER TABLE servers
  ADD COLUMN scan_roots JSONB NOT NULL DEFAULT '["/opt","/srv","/var/www","/home"]'::jsonb;
```

### Extended Entity: `applications` (add column)

```ts
// Added to existing Application interface:
interface Application {
  // ... existing fields ...
  skipInitialClone: boolean;   // true when the remotePath already has a working tree (scan imports)
}
```

**Rules**:
- Default on insert: `false` — preserves existing manual-add behaviour.
- Set to `true` **only** by the scan import path in `routes/apps.ts` when the request body has `source: "scan"`. The field is not exposed on the normal Create/Update form.
- When `true`, deploy runner skips `git clone` and uses `git fetch origin <branch> && git reset --hard FETCH_HEAD` instead. `FETCH_HEAD` (not `origin/<branch>` with a checkout) avoids failures on local divergence or detached HEAD.
- For Docker-only imports (`repoUrl` starts with `docker://`), the deploy runner skips all git operations regardless of the flag — the flag is still set to `true` for consistency in audit logs.

**Migration** (`0003_scan.sql` continues):
```sql
ALTER TABLE applications
  ADD COLUMN skip_initial_clone BOOLEAN NOT NULL DEFAULT FALSE;
```

### Existing fields reused without change

The scan import flow writes to existing columns as follows:

| Column | Source |
|---|---|
| `name` | Directory basename (git) or compose project name / container name (docker) |
| `repoUrl` | `git remote get-url origin` output, or `docker://<compose-file-absolute-path>`, or `docker://<container-name>` |
| `branch` | `git rev-parse --abbrev-ref HEAD` output, or `"-"` for Docker-only |
| `remotePath` | Absolute directory of the worktree, or directory containing compose file, or empty for standalone containers (admin fills in) |
| `deployScript` | Admin picks from suggested list (or types own) — never auto-saved blank |
| `currentCommit` | `git rev-parse HEAD` output, or `null` for Docker |
| `githubRepo` | Normalised `owner/repo` when `repoUrl` matches a GitHub URL |

---

## Transient Entities (API response only — not persisted)

### ScanResult

Returned by `POST /api/servers/:id/scan`. Ephemeral — re-computed on every call.

```ts
interface ScanResult {
  gitCandidates: GitCandidate[];
  dockerCandidates: DockerCandidate[];
  gitAvailable: boolean;       // false if `git` not installed on server
  dockerAvailable: boolean;    // false if `docker` not installed on server
  partial: boolean;            // true if the 60s timeout expired
  durationMs: number;
}
```

### GitCandidate

```ts
interface GitCandidate {
  path: string;                // absolute worktree path on server
  remoteUrl: string | null;    // origin URL, null if no origin set
  githubRepo: string | null;   // "owner/repo" normalised from remoteUrl, null otherwise
  branch: string;              // HEAD branch; "HEAD" for detached
  commitSha: string;           // full 40-char SHA
  commitSubject: string;       // first line of HEAD commit message
  commitDate: string;          // ISO 8601 from `git log -1 --format=%ci`
  dirty: boolean;              // true if `git status --porcelain` had any output
  suggestedDeployScripts: string[];  // absolute paths to deploy*.sh found inside `path`
  alreadyImported: boolean;    // matches an existing applications row on this server
  existingApplicationId: string | null;
}
```

### DockerCandidate

```ts
interface DockerCandidate {
  kind: "compose" | "container";
  path: string | null;         // compose file path for "compose"; null for standalone "container"
  name: string;                // compose project name, or container name
  services: Array<{
    name: string;              // service name (compose) or container name (container)
    image: string;             // image tag (e.g. "nginx:1.27")
    running: boolean;
  }>;
  alreadyImported: boolean;
  existingApplicationId: string | null;
}
```

**Invariants**:
- For `kind: "compose"`: `path` is non-null, `services.length ≥ 1`.
- For `kind: "container"`: `path` is null, `services.length === 1`.
- A running container whose name matches `<composeName>_<service>_N` or `<composeName>-<service>-N` is folded into the compose candidate and is **not** emitted as a standalone container.

---

## State Transitions

### Scan-imported application

```
(candidate detected) 
  → (admin clicks Import) 
  → (form opens prefilled) 
  → (admin confirms → POST /api/servers/:id/apps with source="scan") 
  → applications row created with skipInitialClone = true
  → (first deploy uses fetch+reset, not clone) 
  → applications.currentCommit updated from deploy result
  → skipInitialClone stays true for this row forever (informational — does not re-trigger anything)
```

The `skipInitialClone` flag is **set once, read many**. It is never flipped back to `false`, because once a working tree exists at `remotePath`, re-cloning over it would destroy local state without benefit.

### Server scanRoots

```
(server created) → scanRoots = defaults ∪ {scriptsPath}
(admin edits server) → scanRoots replaced with new validated array
(server deleted) → rows cascade-deleted (no scanRoots-specific cleanup needed)
```
