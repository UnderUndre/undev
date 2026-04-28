# Implementation Plan: Bootstrap Deploy from GitHub Repo

**Branch**: `main` (spec-on-main convention per features 005/006/007/008) | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)

## Summary

Turn "first deploy" into a one-form dashboard wizard. Operator picks a GitHub repo (via the existing feature 002 connection); the dashboard pre-fetches `docker-compose.yml` over the GitHub Contents API, parses services + ports, derives a slug + remote path, and persists an `applications` row in `bootstrap_state = 'init'` before any SSH happens. A new server-side state machine then drives the row through `INIT → CLONING → COMPOSE_UP → HEALTHCHECK → PROXY_APPLIED → CERT_ISSUED → ACTIVE` — each step is a `script_runs` invocation against feature 005's runner with new manifest entries `bootstrap/clone`, `bootstrap/compose-up`, `bootstrap/wait-healthy`, `bootstrap/finalise`. Failures freeze the row at `failed_<step>`; the UI surfaces Retry / Edit Config / Delete actions; nothing on the target gets cleaned up automatically.

The architectural shape is: **DB row = source of truth**, the wizard is a thin live view over `applications.bootstrap_state` + `app_bootstrap_events`, and the orchestrator lives entirely server-side so a closed browser does not abort an in-flight bootstrap. Reverse-proxy + TLS attachment delegates to feature 008's reconciler (FR-006/007 there); healthcheck waits delegate to feature 006's wait-for-healthy (FR-024 there). PAT injection routes through a single-quoted heredoc on the target shell so neither `ps`, `auditd execve`, nor `script_runs.params` ever see the token. Hard-delete is a typed-confirm wizard with an SSH-side `realpath` jail check — the `rm -rf` only fires when the resolved target is genuinely under `${DEPLOY_USER_HOME}/apps/`.

The whole thing is additive over feature 005's runner: zero new transport mechanism, one new YAML dependency (`yaml`, R-002), one new migration (`0009_bootstrap.sql`), four new manifest entries, one new orchestrator service (`bootstrap-orchestrator.ts`), one new background reconciler timer (FR-022), and one new Bootstrap Wizard component group on the frontend.

## Technical Context

**Existing stack** (inherited from 001–008):

- Express 5 + React 19 / Vite 8 / Tailwind 4, drizzle-orm 0.45 + `postgres` (porsager) 3.4
- `sshPool` (`ssh2` 1.17) with `execStream(id, cmd)` (remote-exec) AND `executeWithStdin(id, cmd, buf)` (stdin pipe — feature 005)
- `jobManager` for in-memory job lifecycle + WS event fan-out
- Pino logger with redact config
- Feature 002 `githubService` (`devops-app/server/services/github.ts`) — token storage in `github_connection` singleton, LRU-cached search via Octokit-shaped fetcher
- Feature 003 scan slug + `.git` detection + `skip_initial_clone = true` semantics
- Feature 004 `deployLock` (advisory lock, server-scoped)
- Feature 005 `scriptsRunner.runScript(scriptId, serverId, params, userId, opts)` + `scripts-manifest.ts` + `shQuote` + `resolveDeployOperation`
- Feature 005 `script_runs` table (dual-write with `deployments` for deploy-class scripts)
- Feature 006 wait-for-healthy in-script tail (FR-024 / FR-025 there)
- Feature 008 `app_certs` table, Caddy reconciler, DNS pre-check, ACME email resolver

**New for this feature**:

- `applications` row gains six columns — `bootstrap_state`, `bootstrap_auto_retry`, `upstream_service`, `upstream_port`, `compose_path`, `created_via`. Backfill rules in §Migration plan.
- One new table `app_bootstrap_events` — append-only audit of every state transition.
- One new dependency: **`yaml` 2.x** (~17 kB, MIT) for compose parsing. Approval pending (§ Standing Order #2). Rationale + alternatives in R-002.
- Four new manifest entries — `bootstrap/clone`, `bootstrap/compose-up`, `bootstrap/wait-healthy`, `bootstrap/finalise`. Full Zod schemas in `contracts/api.md` § Manifest entries.
- Four new bash scripts under `scripts/bootstrap/` — `clone.sh`, `compose-up.sh`, `wait-healthy.sh`, `finalise.sh`.
- One new service `server/services/bootstrap-orchestrator.ts` — the state-machine driver. Owns step dispatch, `app_bootstrap_events` writes, retry-step validation, transition to PROXY_APPLIED/CERT_ISSUED via feature 008's reconciler.
- One new helper `server/lib/compose-parser.ts` — YAML load + service detection (`expose:` / `ports:` / `network_mode: host` / `deploy.replicas`).
- One new helper `server/lib/slug.ts` — slug derivation per FR-006 (`^[a-z0-9]+(-[a-z0-9]+)*$`).
- One new helper `server/lib/path-jail.ts` — SSH-side `realpath` resolver + jail check for FR-028.
- One new background timer `server/services/bootstrap-reconciler.ts` — 5-minute cron for `bootstrap_auto_retry = true` rows (FR-022).
- New routes — `POST /api/applications/bootstrap`, `GET /api/applications/:id/bootstrap-state`, `POST /api/applications/:id/bootstrap/retry`, `PATCH /api/applications/:id/bootstrap/config`, `POST /api/applications/:id/hard-delete`, `GET /api/github/repos/:owner/:repo/compose`. The first two carry WS counterparts (`bootstrap.state-changed`, `bootstrap.step-log`).
- One new migration — `devops-app/server/db/migrations/0009_bootstrap.sql` (next sequence after feature 006's `0007_*` and feature 008's `0008_*`; see Migration plan).
- New frontend — `client/components/bootstrap/BootstrapWizard.tsx` (5-step form), `client/components/bootstrap/BootstrapStateBadge.tsx`, `client/components/bootstrap/HardDeleteDialog.tsx`. Apps list integrates `BootstrapStateBadge` next to feature 006's health dot.

**Unknowns resolved in research.md**:

- R-001: GitHub Contents API vs full clone for compose pre-fetch
- R-002: Compose YAML parser library choice
- R-003: PAT injection technique (heredoc vs env-var vs URL-embedded)
- R-004: Slug uniqueness scope (per-server, aligning with feature 008 FR-001)
- R-005: State persistence (single column + audit table)
- R-006: Background reconciler scheduling
- R-007: Retry idempotency for COMPOSE_UP
- R-008: Path jail check via SSH `realpath`
- R-009: GitHub Search API rate-limit accounting
- R-010: WS event contract for live wizard updates
- R-011: Default branch detection — GitHub `default_branch` vs git symbolic-ref
- R-012: Reconciler vs WebSocket race for state-change broadcasts
- R-013: Compose path discovery when default `docker-compose.yml` is absent

## Project Structure

```
undev/
├── scripts/
│   └── bootstrap/                              # [NEW dir]
│       ├── clone.sh                            # [NEW — git clone + idempotent fetch+reset]
│       ├── compose-up.sh                       # [NEW — docker compose -f $COMPOSE_PATH up -d]
│       ├── wait-healthy.sh                     # [NEW — feature 006 FR-025 polling tail]
│       └── finalise.sh                         # [NEW — write current_commit, transition to ACTIVE]
└── devops-app/
    ├── package.json                            # [MODIFIED — add `yaml: ^2.6.0` dependency]
    ├── server/
    │   ├── db/
    │   │   ├── schema.ts                       # [MODIFIED — applications new cols + appBootstrapEvents table]
    │   │   └── migrations/
    │   │       └── 0009_bootstrap.sql          # [NEW — ALTER applications + CREATE app_bootstrap_events]
    │   ├── lib/
    │   │   ├── compose-parser.ts               # [NEW — yaml.parse + service detection]
    │   │   ├── slug.ts                         # [NEW — FR-006 derivation + collision helper]
    │   │   ├── path-jail.ts                    # [NEW — SSH realpath + jail check (FR-028)]
    │   │   └── pat-redact.ts                   # [NEW — extends pino redact for FR-015]
    │   ├── services/
    │   │   ├── bootstrap-orchestrator.ts       # [NEW — state machine driver, owns transitions]
    │   │   ├── bootstrap-reconciler.ts         # [NEW — 5-min cron, FR-022]
    │   │   └── github.ts                       # [MODIFIED — add fetchComposeFile, fetchDefaultBranch]
    │   ├── scripts-manifest.ts                 # [MODIFIED — add 4 bootstrap/* entries]
    │   └── routes/
    │       ├── apps.ts                         # [MODIFIED — bootstrap-related sub-routes]
    │       ├── bootstrap.ts                    # [NEW — orchestrator HTTP surface]
    │       └── github.ts                       # [MODIFIED — add /repos/:owner/:repo/compose]
    ├── client/
    │   ├── components/
    │   │   ├── apps/
    │   │   │   ├── AppsList.tsx                # [MODIFIED — render BootstrapStateBadge + filter dropdown]
    │   │   │   └── ApplicationDetail.tsx       # [MODIFIED — Failed-state action buttons]
    │   │   └── bootstrap/                      # [NEW dir]
    │   │       ├── BootstrapWizard.tsx         # [NEW — 5 steps: Repo, Detect, Domain, Advanced, Review]
    │   │       ├── BootstrapStateBadge.tsx     # [NEW — spinning ring + tooltip]
    │   │       ├── BootstrapProgressView.tsx   # [NEW — live state-changed/step-log subscription]
    │   │       ├── HardDeleteDialog.tsx        # [NEW — typed-confirm cleanup]
    │   │       ├── EditBootstrapConfigDialog.tsx # [NEW — branch/composePath/upstream override]
    │   │       └── ComposeDetectionView.tsx    # [NEW — service picker + warnings]
    │   ├── hooks/
    │   │   └── useBootstrapState.ts            # [NEW — WS subscription + REST fallback poll]
    │   └── pages/
    │       └── ServerPage.tsx                  # [MODIFIED — Bootstrap from GitHub button]
    └── tests/
        ├── unit/
        │   ├── slug.test.ts                    # [NEW — FR-006 + FR-027 metachar suite]
        │   ├── compose-parser.test.ts          # [NEW — service detection, replicas, network_mode: host]
        │   ├── path-jail.test.ts               # [NEW — FR-028 escape attempts: symlink, ../, absolute outside jail]
        │   ├── pat-redact.test.ts              # [NEW — FR-015 redaction at logger + audit + script_runs.params]
        │   ├── bootstrap-state-machine.test.ts # [NEW — valid + invalid transitions]
        │   └── bootstrap-orchestrator.test.ts  # [NEW — step dispatch + retry-from-failed]
        └── integration/
            ├── bootstrap-happy-path.test.ts    # [NEW — full wizard → ACTIVE]
            ├── bootstrap-clone-failure.test.ts # [NEW — PAT scope error → failed_clone → retry succeeds]
            ├── bootstrap-compose-failure.test.ts # [NEW — broken compose → failed_compose → Edit Config → retry]
            ├── bootstrap-hard-delete.test.ts   # [NEW — typed confirm + FR-021 ordering]
            ├── bootstrap-reconciler.test.ts    # [NEW — auto-retry + 3-failure backoff]
            ├── bootstrap-ws-stream.test.ts     # [NEW — bootstrap.state-changed + bootstrap.step-log fan-out]
            └── bootstrap-domain-inline.test.ts # [NEW — FR-012 PROXY_APPLIED + CERT_ISSUED via feature 008]
```

## State Machine

```
                  ┌──────┐
                  │ INIT │  (row inserted by POST /api/applications/bootstrap)
                  └───┬──┘
                      │ orchestrator picks up
                      ▼
                ┌──────────┐
                │ CLONING  │ ── fail ──▶ failed_clone ──┐
                └─────┬────┘                            │
                      │                                 │
                      ▼                                 │
              ┌────────────┐                            │
              │ COMPOSE_UP │ ── fail ──▶ failed_compose─┤
              └─────┬──────┘                            │
                    │                                   │
                    ▼                                   │
            ┌─────────────┐                             │
            │ HEALTHCHECK │ ── fail ──▶ failed_healthcheck ┤
            └─────┬───────┘                             │
                  │                                     │
            ┌─────┴─────┐                               │
            │           │                               │
        domain?        domain?                          │
         (no)         (yes)                             │
            │           │                               │
            │           ▼                               │
            │   ┌──────────────┐                        │
            │   │PROXY_APPLIED │ ── fail ──▶ failed_proxy ┤
            │   └──────┬───────┘                        │
            │          │                                │
            │          ▼                                │
            │   ┌─────────────┐                         │
            │   │CERT_ISSUED  │ ── fail ──▶ failed_cert ┤
            │   └──────┬──────┘                         │
            │          │                                │
            └──────────┴────────┐                       │
                                ▼                       │
                          ┌──────────┐                  │
                          │  ACTIVE  │ ◀──── retry: any ┘
                          └──────────┘     failed_<step>
                                           transitions back
                                           to <step> or
                                           earlier-in-chain
                                           per FR-019
```

Allowed retry transitions (validated by `bootstrap-orchestrator.canTransition()`):

| From | To | Notes |
|------|----|-------|
| `failed_clone` | `cloning` | Idempotent — fetch+reset if `.git` matches |
| `failed_compose` | `compose_up` | `docker compose up -d` is idempotent |
| `failed_compose` | `cloning` | Operator chose to re-clone (e.g. corrupt working tree) |
| `failed_healthcheck` | `compose_up` | Compose may need restart; healthcheck re-runs after |
| `failed_healthcheck` | `healthcheck` | Same restart, just re-poll |
| `failed_proxy` | `proxy_applied` | Caddy reconciler PUT is idempotent |
| `failed_cert` | `cert_issued` | Caddy auto-TLS retry |
| `active` | * | Terminal — no retry; new deploys go via feature 005 runner |

Forbidden: `failed_proxy → cloning`, `failed_cert → compose_up`, etc. (would require Hard Delete + re-bootstrap per FR-020).

State strings stored in `applications.bootstrap_state` are lowercase + snake_case, matching feature 005's `script_runs.status` convention.

## Key Implementation Notes

### Repo selector — `server/services/github.ts` extension + frontend cache

Repo selector backs onto feature 002's `githubService`. The `searchRepos` call is already there (with LRU cache, 5-minute TTL per FR-024 of feature 002). Two new methods:

```ts
// server/services/github.ts
async fetchDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  const r = await this.fetchJson<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`, token,
  );
  return r.default_branch;
}

async fetchComposeFile(
  token: string,
  owner: string,
  repo: string,
  path: string,        // "docker-compose.yml" by default; FR-003 fallback to ".yaml"
  ref?: string,        // branch / commit; default branch when omitted
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}` +
              (ref ? `?ref=${ref}` : "");
  try {
    const r = await this.fetchJson<{ content: string; encoding: "base64" }>(url, token);
    return Buffer.from(r.content, "base64").toString("utf8");
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}
```

Frontend cache: `useGithubReposSearch(query)` uses `@tanstack/react-query` with `staleTime: 60_000` (FR-002a — 60s same-tuple cache). Debounce 300ms (FR-002), minimum 2 chars before issuing the request. Recent-20 list pre-loads on wizard mount (`GET /api/github/repos?sort=pushed&per_page=20` — already exposed by feature 002).

### Compose pre-fetch + parsing — `server/lib/compose-parser.ts`

```ts
import yaml from "yaml";

export interface ComposeService {
  name: string;
  exposeOrPorts: number | null;     // null = service exposes nothing
  networkModeHost: boolean;
  replicas: number;                  // default 1
  hasHealthcheck: boolean;
}

export interface ParsedCompose {
  services: ComposeService[];
  errors: string[];                  // non-fatal warnings
}

export function parseCompose(yamlText: string): ParsedCompose {
  const doc = yaml.parse(yamlText) as { services?: Record<string, unknown> };
  if (!doc?.services || typeof doc.services !== "object") {
    return { services: [], errors: ["No `services:` root key"] };
  }
  const services: ComposeService[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(doc.services)) {
    const svc = raw as {
      expose?: (string | number)[];
      ports?: (string | { target?: number })[];
      network_mode?: string;
      deploy?: { replicas?: number };
      healthcheck?: unknown;
    };
    services.push({
      name,
      exposeOrPorts: pickPort(svc),  // see below
      networkModeHost: svc.network_mode === "host",
      replicas: Math.max(1, Number(svc.deploy?.replicas ?? 1)),
      hasHealthcheck: Boolean(svc.healthcheck),
    });
  }
  return { services, errors };
}
```

`pickPort` priority (per FR-004): `expose:` first (right-hand value); else `ports:` first entry, parse `"3000:3000"` → 3000 (right side = container port), or `{ target: 3000 }` long form. Numbers > 65535 filtered out. Multiple ports → first one (with a non-fatal error logged for the wizard to surface).

Compose pre-fetch is performed by `POST /api/applications/bootstrap` — the wizard's Step 2 calls `GET /api/github/repos/:owner/:repo/compose?path=docker-compose.yml`, which:

1. Calls `githubService.fetchComposeFile(token, owner, repo, path)` → text or `null`.
2. If null AND `path === "docker-compose.yml"`, retry with `path = "docker-compose.yaml"` (FR-003 fallback).
3. Parse with `compose-parser`; return `{ services, errors }` to the client.

### Slug derivation — `server/lib/slug.ts`

```ts
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_CHARS = /[\s/\\.;|&$()`<>"'?*]/;

export function deriveSlug(repoName: string): string {
  return repoName
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function validateSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!SLUG_REGEX.test(slug)) return { ok: false, error: "Slug must match ^[a-z0-9]+(-[a-z0-9]+)*$" };
  if (FORBIDDEN_CHARS.test(slug)) return { ok: false, error: "Slug contains forbidden characters" };
  if (slug.length > 64) return { ok: false, error: "Slug must be ≤64 characters" };
  if (slug.includes("..")) return { ok: false, error: "Slug cannot contain `..`" };
  return { ok: true };
}

export async function isSlugUniqueOnServer(
  serverId: string,
  slug: string,
  excludeAppId?: string,
): Promise<boolean> {
  const rows = await db.select({ id: applications.id })
    .from(applications)
    .where(and(
      eq(applications.serverId, serverId),
      eq(applications.name, slug),
      excludeAppId ? ne(applications.id, excludeAppId) : undefined,
    ));
  return rows.length === 0;
}
```

`validateSlug` is called server-side only (FR-027 — never trust client). The frontend `BootstrapWizard.tsx` performs the same client-side check for fast feedback but the API rejects on server-side.

### Bootstrap orchestrator — `server/services/bootstrap-orchestrator.ts`

State-machine driver. Owns:

- Append-only `app_bootstrap_events` writes for every transition.
- Step dispatch via `scriptsRunner.runScript(...)` for `bootstrap/*` manifest entries.
- Retry-from-failed validation (`canTransition(from, to)`).
- Orchestrating "next step on success" — `CLONING` success → enqueue `COMPOSE_UP`, etc.
- Coordination with feature 008's reconciler for `PROXY_APPLIED` + `CERT_ISSUED`.

Public surface:

```ts
class BootstrapOrchestrator {
  async start(appId: string, userId: string): Promise<void>;            // INIT → CLONING
  async retryFromFailedStep(appId: string, fromStep: BootstrapStep, userId: string): Promise<void>;
  async hardDelete(appId: string, confirmName: string, userId: string): Promise<void>;
  canTransition(from: BootstrapState, to: BootstrapState): boolean;
  // Internal — wired to scriptsRunner.onTerminal for bootstrap/* runs
  private async onStepCompleted(appId: string, step: BootstrapStep, runResult: RunResult): Promise<void>;
}
```

Internal flow of `start(appId, userId)`:

1. Read `applications` row; assert `bootstrap_state = 'init'` and `created_via = 'bootstrap'`.
2. Append `app_bootstrap_events` (`from_state = 'init'`, `to_state = 'cloning'`).
3. Update `applications.bootstrap_state = 'cloning'`.
4. Resolve clone command params (PAT lookup + `repoUrl` injection — see PAT scrubbing pipeline below).
5. Call `scriptsRunner.runScript("bootstrap/clone", serverId, params, userId, { linkAppId: appId })`. The runner inserts a `script_runs` row tagged `script_id = 'bootstrap/clone'`.
6. Subscribe to terminal status via `jobManager.onJobEvent`. On success → `onStepCompleted("cloning", result)`; on failure → transition to `failed_clone` + WS broadcast + Telegram notify (FR-024).

`onStepCompleted` is the dispatch table:

| Completed step | Next state | Next step manifest id |
|----|----|----|
| `cloning` | `compose_up` | `bootstrap/compose-up` |
| `compose_up` | `healthcheck` | `bootstrap/wait-healthy` (skip if no compose healthcheck per FR-011) |
| `healthcheck` | `proxy_applied` if domain else `active` | feature 008 reconciler call OR `bootstrap/finalise` |
| `proxy_applied` | `cert_issued` | feature 008 cert-issuance flow |
| `cert_issued` | `active` | `bootstrap/finalise` |

`bootstrap/finalise` reads `current_commit` from the cloned repo (`git rev-parse HEAD`), persists it to `applications.current_commit`, and emits the success Telegram message (FR-024 there).

### Step runners — `scripts/bootstrap/*.sh`

All four scripts source `scripts/common.sh` and accept the canonical `--name=<value>` argv form per feature 005 R-003. Snippet shapes:

`bootstrap/clone.sh` — invoked via feature 005's `bash -s` stdin pipe:

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

# Args: --remote-path, --repo-url-with-pat, --branch
# PAT is in $SECRET_PAT (env-var, not argv). repo-url-with-pat is `https://${owner}/${repo}.git`
# (no token); we inject the token at exec time via heredoc per FR-029.

REMOTE_PATH=""; REPO_URL=""; BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*) REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --repo-url=*)    REPO_URL="${1#--repo-url=}"; shift ;;
    --branch=*)      BRANCH="${1#--branch=}"; shift ;;
    *) shift ;;
  esac
done

# Idempotency check — match FR-013 CLONING.
if [[ -d "$REMOTE_PATH/.git" ]]; then
  CURRENT_REMOTE=$(git -C "$REMOTE_PATH" -c safe.directory='*' remote get-url origin 2>/dev/null || true)
  if [[ "$CURRENT_REMOTE" == "$REPO_URL" ]] || [[ "${CURRENT_REMOTE/oauth2:*@/}" == "${REPO_URL/oauth2:*@/}" ]]; then
    echo "Repo already cloned — fetching + resetting"
    git -C "$REMOTE_PATH" -c safe.directory='*' fetch origin "$BRANCH"
    git -C "$REMOTE_PATH" -c safe.directory='*' reset --hard "origin/$BRANCH"
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

# Construct authenticated URL via heredoc — PAT never appears in argv / `ps`.
AUTH_URL=$(cat <<EOF
${REPO_URL/https:\/\//https://oauth2:$SECRET_PAT@}
EOF
)
mkdir -p "$(dirname "$REMOTE_PATH")"
git clone --branch "$BRANCH" "$AUTH_URL" "$REMOTE_PATH"
```

`bootstrap/compose-up.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

REMOTE_PATH=""; COMPOSE_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path=*) REMOTE_PATH="${1#--remote-path=}"; shift ;;
    --compose-path=*) COMPOSE_PATH="${1#--compose-path=}"; shift ;;
    *) shift ;;
  esac
done
cd "$REMOTE_PATH"
docker compose -f "$COMPOSE_PATH" up -d --remove-orphans
```

`bootstrap/wait-healthy.sh` — feature 006 FR-025 polling tail. Skips silently when no healthcheck (FR-011 here, FR-028 there).

`bootstrap/finalise.sh` — `git rev-parse HEAD` → stdout last line for `outputArtifact: { type: "json", captureFrom: "stdout-json" }` capture per feature 005's pattern. Orchestrator reads `current_commit` from `script_runs.output_artifact` and persists.

### PAT scrubbing pipeline

Three layers, mirroring feature 005 R-006's defence-in-depth model:

1. **DB write-time masking** — the `applications.bootstrap` route handler accepts a `repoUrl` containing `https://github.com/<owner>/<repo>.git` (no token) and stores it that way. PAT is fetched fresh from `github_connection.token` at orchestrator dispatch time; the token bytes never enter the `applications` row.
2. **Manifest schema** — `bootstrap/clone` declares `pat: z.string().describe("secret")`, routing it through env-var transport per feature 005 R-006: `script_runs.params.pat` is masked to `"***"` at insert; pino redact paths cover `req.body.pat` and `scriptRun.params.pat`.
3. **Heredoc on target shell** — clone command on the target receives `$SECRET_PAT` as an exported env var (feature 005's secret transport mechanism — env, not argv); inside the script, the URL is rebuilt via `cat <<EOF`. The resulting authenticated URL never appears in `ps auxwww` because git uses the URL only as an in-process argument to libcurl.

Verification (test in `tests/integration/bootstrap-pat-leak.test.ts`):

- `SELECT params FROM script_runs WHERE script_id = 'bootstrap/clone'` returns `pat: "***"`.
- `audit_entries.details` returns `pat: "***"`.
- pino captured stream returns no substring matching `ghp_*` or `github_pat_*`.
- A simulated `ps -ef` snapshot during the run finds `bash` and `git` but no `oauth2:ghp_*` substring in argv.

### Hard-delete cleanup wizard with path-jail check

`server/lib/path-jail.ts`:

```ts
import { sshExecutor } from "../services/ssh-executor.js";
import { shQuote } from "./sh-quote.js";

export async function resolveAndJailCheck(
  serverId: string,
  remotePath: string,
  jailRoot: string,             // e.g. /home/deploy/apps
): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  // Use bash builtin readlink -f (or realpath) — both follow symlinks atomically
  // on the target. The check happens IN the same shell that will run the rm,
  // so TOCTOU is bounded to one SSH session.
  const cmd = `readlink -f ${shQuote(remotePath)} 2>/dev/null || realpath ${shQuote(remotePath)} 2>/dev/null`;
  const result = await sshExecutor.execCapture(serverId, cmd);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { ok: false, error: `Could not resolve ${remotePath} on target` };
  }
  const resolved = result.stdout.trim();
  // Jail check: resolved path must equal jailRoot OR be a strict subdirectory.
  // Trailing slash normalisation prevents `/home/deploy/apps2/foo` matching `/home/deploy/apps`.
  const jailWithSep = jailRoot.endsWith("/") ? jailRoot : jailRoot + "/";
  if (!resolved.startsWith(jailWithSep)) {
    return { ok: false, error: `Resolved path ${resolved} is outside the jail root ${jailRoot}` };
  }
  return { ok: true, resolved };
}
```

`bootstrap-orchestrator.hardDelete(appId, confirmName)` ordering per FR-021:

1. Server-side assert `confirmName === application.name` (typed-confirm enforced server-side per FR-027).
2. Compute `jailRoot = ${DEPLOY_USER_HOME}/apps`. Resolve `application.remote_path` via `resolveAndJailCheck`. Refuse on `{ ok: false }`.
3. If `application.domain` is set: call feature 008's hard-delete (revoke cert + remove Caddy site via admin API) per FR-021 step 3.
4. Run `docker compose -f ${remote_path}/${compose_path} down -v` via SSH (timeout 60s).
5. Run `rm -rf ${shQuote(resolved)}` (resolved path from step 2 — guaranteed under jail).
6. Append `app_bootstrap_events` (`to_state = 'hard_deleted'`).
7. `DELETE FROM applications WHERE id = ?` (cascade clears `app_bootstrap_events` per FK ON DELETE CASCADE; clears `app_certs` per feature 008's FK; clears `script_runs.deployment_id` via SET NULL per feature 005's FK).

Hard delete is itself a `script_runs` row tagged `script_id = 'bootstrap/hard-delete'` (added to manifest as a 5th bootstrap entry — see contracts/api.md). `requiresLock: true` so it can't race with a deploy.

### Background reconciler — `server/services/bootstrap-reconciler.ts`

Cron every 5 minutes (`setInterval(5 * 60_000)`, `.unref()`):

```ts
async function reconcile() {
  const failedRows = await db.select({
    id: applications.id,
    bootstrapState: applications.bootstrapState,
    serverId: applications.serverId,
  }).from(applications)
    .where(and(
      sql`${applications.bootstrapState} LIKE 'failed_%'`,
      eq(applications.bootstrapAutoRetry, true),
    ));

  for (const row of failedRows) {
    const recentRetries = await db.select({ count: sql<number>`COUNT(*)` })
      .from(appBootstrapEvents)
      .where(and(
        eq(appBootstrapEvents.appId, row.id),
        sql`${appBootstrapEvents.metadata}->>'reason' = 'auto_retry'`,
        sql`${appBootstrapEvents.occurredAt}::timestamptz > NOW() - INTERVAL '1 hour'`,
      ));
    if (recentRetries[0].count >= 3) {
      // FR-022 — 3 consecutive auto-retries failed; alert + stop
      await notifier.notify("bootstrap-auto-retry-stopped", { appId: row.id });
      await db.update(applications).set({ bootstrapAutoRetry: false }).where(eq(applications.id, row.id));
      continue;
    }
    const fromStep = row.bootstrapState.replace(/^failed_/, "") as BootstrapStep;
    await orchestrator.retryFromFailedStep(row.id, fromStep, "system").catch((err) => {
      logger.warn({ ctx: "bootstrap-reconciler", appId: row.id, err }, "Auto-retry failed");
    });
  }
}
```

Disabled when `BOOTSTRAP_RECONCILER_INTERVAL_MS=0` (operator opt-out).

### UI: Bootstrap Wizard (5 steps)

`client/components/bootstrap/BootstrapWizard.tsx` — modal with 5-step stepper:

1. **Repo** — `<RepoSearch>` from feature 002. On select, `name` field prefills with `deriveSlug(repo.name)` (editable, validated client + server).
2. **Detection** — calls `GET /api/github/repos/:owner/:repo/compose`. Renders `<ComposeDetectionView services={...}>`:
   - 1 service with port → "Detected: `<service>` on port `<port>`. Confirm or override."
   - 2+ services → dropdown "Which service is public?"
   - 0 services → "No service has `expose:` or `ports:`. Provide them in Advanced or post-bootstrap."
   - Warnings: `network_mode: host` → yellow banner; `replicas > 1` → info banner about multi-upstream Caddy directive.
3. **Domain (optional)** — text input + inline DNS pre-check (delegates to feature 008's `/api/dns/precheck` endpoint).
4. **Advanced** (collapsible) — `remotePath` (default `${DEPLOY_USER_HOME}/apps/${slug}` — read-only display, edit via override checkbox), `branch` (prefilled from `fetchDefaultBranch`), `composePath` (default `docker-compose.yml`).
5. **Review** — checklist of "what will happen": `Clone foo/bar @ main → /home/deploy/apps/bar → docker compose up -d → wait for healthy → [if domain] apply Caddy + ACME → ACTIVE`.

Submit calls `POST /api/applications/bootstrap` and switches the modal to `<BootstrapProgressView appId>` which subscribes to WS events. Closing the modal does NOT abort (orchestrator is server-side; FR-007 in spec — wizard is a UI shell).

### Apps list integration

`client/components/apps/AppsList.tsx`:

- Each row gains a `<BootstrapStateBadge state={app.bootstrap_state} />` next to feature 006's health dot.
  - `init/cloning/compose_up/healthcheck/proxy_applied/cert_issued` → spinning ring (yellow, distinct from feature 006's solid yellow).
  - `active` → no badge (default — feature 006's health dot takes over).
  - `failed_*` → red badge with "Failed at <step>" tooltip.
- New filter dropdown `<CreatedViaFilter>` — values `all | manual | scan | bootstrap` (FR-033). Persisted in localStorage.

### Failed-state action buttons — `ApplicationDetail.tsx`

When `bootstrap_state` matches `failed_*`:

- **Retry from <step>** — calls `POST /api/applications/:id/bootstrap/retry?from=<step>`. Disabled while a `script_runs` row is currently running for this app.
- **Edit Config** — opens `<EditBootstrapConfigDialog>`. Per FR-020: only `branch`, `composePath`, `upstream_service`, `upstream_port` are mutable on a failed app. `remotePath` and `repoUrl` are display-only (require Hard Delete + re-bootstrap to change).
- **Delete** — opens `<HardDeleteDialog>` with two radio options (FR-021): "Remove app row only" (default) vs "Remove everything from server" (typed-confirm).

## Migration plan

Migration: `devops-app/server/db/migrations/0009_bootstrap.sql`. Sequence: existing migrations are `0000_initial.sql` through `0006_project_local_deploy.sql`. Feature 006 (App Health Monitoring) lands `0007_app_health_monitoring.sql`. Feature 008 (Domain & TLS) lands `0008_application_domain_and_tls.sql`. This feature lands `0009_bootstrap.sql` — the next free slot.

```sql
-- Feature 009: bootstrap deploy from GitHub repo.
-- Adds six columns to `applications` and creates the `app_bootstrap_events` audit table.

ALTER TABLE "applications" ADD COLUMN "bootstrap_state" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "applications" ADD COLUMN "bootstrap_auto_retry" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "applications" ADD COLUMN "upstream_service" TEXT;
ALTER TABLE "applications" ADD COLUMN "upstream_port" INTEGER;
ALTER TABLE "applications" ADD COLUMN "compose_path" TEXT NOT NULL DEFAULT 'docker-compose.yml';
ALTER TABLE "applications" ADD COLUMN "created_via" TEXT NOT NULL DEFAULT 'manual';

-- Backfill `created_via` per FR-032: scan-imported rows → 'scan'; everything else → 'manual'.
UPDATE "applications" SET "created_via" = 'scan' WHERE "skip_initial_clone" = TRUE;
-- (Default 'manual' covers the rest; no second UPDATE needed.)

-- Constraint: bootstrap_state values must be enum-valid.
ALTER TABLE "applications" ADD CONSTRAINT "applications_bootstrap_state_enum" CHECK (
  "bootstrap_state" IN (
    'init', 'cloning', 'compose_up', 'healthcheck',
    'proxy_applied', 'cert_issued', 'active',
    'failed_clone', 'failed_compose', 'failed_healthcheck',
    'failed_proxy', 'failed_cert'
  )
);

-- Constraint: created_via values must be enum-valid AND immutable post-creation
-- (immutability enforced at the API layer, not DB — see FR-032 last sentence).
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_via_enum"
  CHECK ("created_via" IN ('manual', 'scan', 'bootstrap'));

-- Constraint: upstream_port range.
ALTER TABLE "applications" ADD CONSTRAINT "applications_upstream_port_range"
  CHECK ("upstream_port" IS NULL OR ("upstream_port" >= 1 AND "upstream_port" <= 65535));

CREATE TABLE "app_bootstrap_events" (
  "id" TEXT PRIMARY KEY,
  "app_id" TEXT NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL DEFAULT (NOW()::text),
  "metadata" JSONB,
  "actor" TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX "idx_app_bootstrap_events_app_occurred"
  ON "app_bootstrap_events" ("app_id", "occurred_at" DESC);
CREATE INDEX "idx_app_bootstrap_events_to_state"
  ON "app_bootstrap_events" ("to_state");

-- DOWN migration (manual, operator-gated — destructive):
--   DROP TABLE "app_bootstrap_events";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_bootstrap_state_enum";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_created_via_enum";
--   ALTER TABLE "applications" DROP CONSTRAINT "applications_upstream_port_range";
--   ALTER TABLE "applications" DROP COLUMN "created_via";
--   ALTER TABLE "applications" DROP COLUMN "compose_path";
--   ALTER TABLE "applications" DROP COLUMN "upstream_port";
--   ALTER TABLE "applications" DROP COLUMN "upstream_service";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_auto_retry";
--   ALTER TABLE "applications" DROP COLUMN "bootstrap_state";
```

Drizzle schema fragments — `devops-app/server/db/schema.ts`:

```ts
// On `applications`:
bootstrapState: text("bootstrap_state").notNull().default("active"),
bootstrapAutoRetry: boolean("bootstrap_auto_retry").notNull().default(false),
upstreamService: text("upstream_service"),
upstreamPort: integer("upstream_port"),
composePath: text("compose_path").notNull().default("docker-compose.yml"),
createdVia: text("created_via").notNull().default("manual"),

// New table:
export const appBootstrapEvents = pgTable(
  "app_bootstrap_events",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadata: jsonb("metadata"),
    actor: text("actor").notNull().default("system"),
  },
  (t) => [
    index("idx_app_bootstrap_events_app_occurred").on(t.appId, t.occurredAt),
    index("idx_app_bootstrap_events_to_state").on(t.toState),
  ],
);
```

## Manifest entries

Five new entries appended to `devops-app/server/scripts-manifest.ts` (full Zod schemas in `contracts/api.md` § Manifest entries):

| id | category | locus | requiresLock | dangerLevel | timeout |
|----|----|----|----|----|----|
| `bootstrap/clone` | `deploy` | `target` | true | low | 600_000 |
| `bootstrap/compose-up` | `deploy` | `target` | true | 1_800_000 |
| `bootstrap/wait-healthy` | `deploy` | `target` | false | low | 300_000 |
| `bootstrap/finalise` | `deploy` | `target` | false | low | 60_000 |
| `bootstrap/hard-delete` | `deploy` | `target` | true | high | 600_000 |

`requiresLock: true` for `clone`, `compose-up`, and `hard-delete` because each touches the on-disk repo state or running containers; `wait-healthy` and `finalise` are read-only enough to run alongside other operations on the server (e.g. another app's deploy) without conflict. `dangerLevel: high` on `hard-delete` triggers feature 005's typed-confirm UI (the `RunDialog` requires admin to type the script id) — combined with our typed-app-name confirm at the route layer this is double-confirmation by design.

## Constitution check

| Guardrail | Status | Note |
|----|----|----|
| `process.env.X \|\| "fallback"` → `if (!env.X) throw` | Mixed — see below |
| `as any` | Forbidden | Replaced with typed unions; `parsed as unknown as ProjectLocalParams`-style narrowing (per feature 007 precedent) only when Zod schema has already validated |
| `throw new Error()` | Replaced | New error classes: `BootstrapStateError`, `PathJailEscapeError`, `ComposeFetchError`, `SlugCollisionError` |
| `console.log()` | Forbidden | Pino logger, structured `{ ctx: 'bootstrap-orchestrator', appId, ... }` |
| `catch (e) {}` | Forbidden | Every catch block at minimum logs + rethrows; reconciler explicitly logs and continues per FR-022 |
| `dangerouslySetInnerHTML` | N/A | Wizard renders plain JSX; YAML preview uses `<pre>` with text content only |
| `req.body.field` without Zod | N/A | All bootstrap routes use Zod schemas (full schemas in `contracts/api.md`) |
| `if (x === y) return true` unconditional bypass | N/A | State-machine transitions go through `canTransition(from, to)` table — no shortcuts |

**Env-var fallback note** (memory pattern): the Bootstrap reconciler uses `process.env.BOOTSTRAP_RECONCILER_INTERVAL_MS ?? 5 * 60_000` — fallback chosen to mirror feature 005's `SCRIPT_RUNS_PRUNE_INTERVAL_MS ?? 24 * 3600 * 1000` pattern (consistency over the gemini-rule "no fallback"). `DEPLOY_USER_HOME` has no fallback — `if (!env.DEPLOY_USER_HOME) throw` because the path-jail check is meaningless without it.

**Standing Order #2** (no new packages without approval): `yaml: ^2.6.0` flagged for explicit user approval at task-execution time. Justification + alternatives in R-002.

**Standing Order #5** (no direct migrations): `0009_bootstrap.sql` is reviewable SQL with explicit DOWN migration documented; admin runs `npm run db:migrate` after review.

**Standing Order #6** (no destructive ops without consent): Hard Delete requires typed-confirm of the application name AND `dangerLevel: high` manifest entry. The `rm -rf` is gated by `path-jail.resolveAndJailCheck` which fails closed on any resolution outside `${DEPLOY_USER_HOME}/apps/`.

## Complexity tracking

| Addition | Why needed | Simpler alternative rejected |
|----|----|----|
| `app_bootstrap_events` table | FR-010 — auditable trail per transition; debugging "how did we get to failed_proxy" needs the chain | Single column with JSON array → unbounded growth, no indexable filter on `to_state` |
| `yaml` dependency | R-002 — compose detection without it means hand-rolled regex parsing of YAML, which has known correctness failures (multi-line strings, anchors) | Hand-rolled parser → fragile; missing the `network_mode: host` edge case is the kind of bug R-002 lists as motivation |
| Server-side state machine vs client-driven wizard | FR-007 (closing wizard mid-flow doesn't abort) — the orchestrator MUST live on the server | Client-driven → a closed browser breaks the deploy; that's the regression we're fixing |
| Background reconciler | FR-022 — auto-retry needs a tickless mechanism; without it `bootstrap_auto_retry = true` is a wish, not a behaviour | Per-row timer in JS process → memory grows with failed-app count; a single 5-min poll is bounded |
| 5 new bash scripts in `scripts/bootstrap/` vs inline runner commands | Feature 005's manifest invariant — every `target` entry maps to a script file. Bypassing would create a dispatch path the runner doesn't validate | Dispatch via raw `sshExecutor.execStream` with literal commands → loses retry/audit/log streaming/manifest validation |

## Out of plan

Explicit non-goals (mirror spec § Out of Scope):

- Non-GitHub providers (GitLab, Bitbucket, Gitea)
- Non-compose deployment models (Kubernetes, plain Dockerfile, systemd-only)
- Auto-detection of build secrets / build-args
- Auto-population of `env_vars` from GitHub secrets
- Cross-repo monorepo support
- Bootstrap from a tag instead of a branch
- Server-provisioning bootstrap (Docker / Caddy install) — `setup-vps.sh` remains a prerequisite
- Roll-forward / roll-back during bootstrap

## Post-design constitution re-check

| Principle | Re-check | Note |
|----|----|----|
| No commits/pushes without request | OK | Plan-only artifact |
| No new packages without approval | Pending | `yaml ^2.6.0` flagged for user approval at task time |
| No secrets in code/logs | OK | PAT scrubbing pipeline three layers; tests in plan cover SC-003 zero-leak gate |
| Plan-first if >3 files | OK | 30+ files listed |
| No destructive ops without consent | OK | Hard Delete double-confirmed (typed name + dangerLevel:high); jail check fails closed |
| No raw string interpolation in SQL | OK | Drizzle for app queries; one migration is a static `.sql` file |
| No `any`, no `console.log` | OK | Plan notes enforce these; task list will check |
| State-machine transitions validated | OK | `canTransition` table is the single source of truth; tests assert forbidden transitions throw |
| Three-layer PAT defence | OK | DB write → manifest secret → env-var transport via heredoc |

Proceed to `/speckit.tasks` once `yaml` dependency is approved.
