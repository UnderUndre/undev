# API Contracts: Operational Maturity

**Date**: 2026-05-05 | **Branch**: `010-operational-maturity` | **Plan**: [../plan.md](../plan.md)

All endpoints under `/api`. JSON bodies. Auth via existing session
middleware. All mutations emit `audit_entries`. Bodies validated with
Zod (CLAUDE.md AGCG); shown schemas are the contract — route Zod MUST
match exactly.

---

## US2 — Lifecycle hooks

### `PATCH /api/applications/:id` — extended for hooks

Existing endpoint (feature 007 added `script_path` field). This feature
extends body validation:

**Request body (extension)**:

```ts
const HookFields = z.object({
  scriptPath: z.string().min(1).max(256).regex(SCRIPT_PATH_REGEX).nullable(),  // existing
  preDeployScriptPath: z.string().min(1).max(256).regex(SCRIPT_PATH_REGEX).nullable(),
  postDeployScriptPath: z.string().min(1).max(256).regex(SCRIPT_PATH_REGEX).nullable(),
  onFailScriptPath: z.string().min(1).max(256).regex(SCRIPT_PATH_REGEX).nullable(),
  preDestroyScriptPath: z.string().min(1).max(256).regex(SCRIPT_PATH_REGEX).nullable(),
}).superRefine((data, ctx) => {
  // FR-013a layer 2 — mutual exclusion
  const hasHooks =
    data.preDeployScriptPath ||
    data.postDeployScriptPath ||
    data.onFailScriptPath ||
    data.preDestroyScriptPath;
  if (data.scriptPath !== null && hasHooks) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scriptPath"],
      message: "script_path_hooks_mutually_exclusive",
    });
  }
});
```

`SCRIPT_PATH_REGEX` = `/^(?!\/)(?!.*\.\.)(?!.*[;|&$()<>{}[\]\\]).*\.sh$/`
(reused from feature 007).

**Response 400** when mutual exclusion violated:

```ts
{
  error: "script_path_hooks_mutually_exclusive",
  message: "Pick either script_path (full replace) OR lifecycle hooks, not both.",
  details: {
    setScriptPath: string,
    setHooks: Array<"preDeploy" | "postDeploy" | "onFail" | "preDestroy">,
  },
  requestId: string,
}
```

**Side effects**:

- Audit `app.hooks_changed` with key lists (paths included; paths are
  not secret per FR-014 + audit-redact policy).

---

## US4 — Cross-server domain check

### `GET /api/applications/cross-server-domain-check` — new endpoint

**Query**:

```ts
const Query = z.object({
  domain: z.string().min(1).max(253),
  excludeAppId: z.string().min(1),
});
```

**Response 200**:

```ts
const Response200 = z.array(z.object({
  appId: z.string(),
  appName: z.string(),
  serverId: z.string(),
  serverLabel: z.string(),
  domain: z.string(),
  certStatus: z.enum(["pending", "active", "expired", "revoked", "rate_limited", "failed", "orphaned", "pending_reconcile"]).nullable(),
}));
```

Empty array = no conflicts (operator may proceed without confirmation).

**Side effects**: read-only, no audit.

### `POST /api/applications/:id/domain` — extended (US4 typed-confirm)

Existing endpoint (feature 008). Extension:

**Request body (added field)**:

```ts
const Body = z.object({
  domain: z.string().min(1).max(253),
  acmeEmail: z.string().email().nullable(),
  // NEW per FR-021 — required when cross-server conflicts exist
  typedConfirmation: z.string().nullable(),
});
```

**Server-side flow**:

1. Re-run cross-server check at write time (not just on dialog open).
2. If conflicts present:
   - `typedConfirmation` MUST equal `domain` exactly (case-sensitive).
   - Mismatch or null → 400 `domain_confirmation_required`.
3. Conflicts absent: `typedConfirmation` ignored.

**Side effects**: audit `app.cross_server_domain_confirmed` with the
conflict snapshot when typed-confirm proceeded; existing
`app.domain_changed` regardless.

---

## US5 — Audit log

### `GET /api/audit` — paginated faceted query

**Query**:

```ts
const ResourceTypeFilter = z.enum(["server", "application", "cert", "bootstrap", "other"]);

const Query = z.object({
  actor: z.array(z.string()).optional(),         // multi-select; empty = all
  action: z.array(z.string()).optional(),
  resourceType: ResourceTypeFilter.optional(),    // includes 'other' to match response domain (per Session 2026-05-05 review G-P1-7)
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
});
```

**Response 200**:

```ts
const Response200 = z.object({
  rows: z.array(z.object({
    id: z.string(),
    occurredAt: z.string(),         // ISO-8601 UTC
    actor: z.string(),               // user email or "system"
    action: z.string(),              // canonical action token
    resourceType: ResourceTypeFilter,
    resourceId: z.string().nullable(),
    resourceLabel: z.string().nullable(),  // last-known label, may be plaintext if resource deleted
    details: z.unknown(),            // JSON, secrets pre-redacted at write time
  })),
  totalCount: z.number().int(),      // capped at 10000 per FR-025
  isCapped: z.boolean(),             // true when actual matching rows ≥ 10000 (UI shows "≥10000 — narrow filter") per Session 2026-05-05 review G-P1-7
  page: z.number().int(),
  pageSize: z.number().int(),
});
```

### `GET /api/audit/export.csv` — streaming CSV

**Query**: same as `GET /api/audit` MINUS `page` / `pageSize`.

**Response**: `200 text/csv` with `Content-Disposition: attachment;
filename="audit-<ISO timestamp>.csv"`. Streams via `res.write` chunks
(server never buffers the full dataset). Hard-capped at 10,000 rows
(FR-027). Row format:

**Abort handling** (per Session 2026-05-05 review GE-4): the streaming
implementation MUST register `req.on("close", ...)` and check the
abort flag at every cursor-batch boundary (every 500 rows). When the
client closes the connection mid-download, the loop breaks at the
next batch and releases the DB cursor — NOT runs to the 10k cap.
Without this, a closed-tab download holds the DB connection until the
loop finishes naturally.

```
timestamp,actor,action,resource_type,resource_id,resource_label,details_json
2026-05-05T14:23:01.123Z,alice@example.com,app.domain_changed,application,app_xyz,"my-cool-app","{""newDomain"":""example.com""}"
```

CSV escaping: standard double-quote with internal `""`. JSON details
serialised on a single line.

---

## US6 — Migration toolkit

### `POST /api/applications/migrate` — new endpoint

**Request body**:

```ts
const Body = z.object({
  serverId: z.string().min(1),
  remotePath: z.string().min(1).max(512),       // operator-supplied target dir
  composePath: z.string().min(1).max(256).default("docker-compose.yml"),
  healthUrl: z.string().url().nullable(),       // optional initial health check URL
  domain: z.string().min(1).max(253).nullable(),// optional initial domain
  // Per Session 2026-05-05 review G-P0-1 + G-E-9: typed-confirm REQUIRED
  // when domain is non-null AND cross-server check returns conflicts.
  // Server re-runs cross-server check at write time (race protection);
  // emits app.cross_server_domain_confirmed only when conflicts ACTUALLY
  // present at write time (per GE-5 — no false-positive audits when
  // conflicts resolved between dialog and submit).
  domainTypedConfirmation: z.string().nullable().default(null),
  // Hooks intentionally NOT in this body per Session 2026-05-05 review
  // G-P0-3 — operator configures hooks via EditAppForm AFTER migration
  // succeeds, keeping FR-013a invariant simple.
});
```

**Path-jail validation** (per Session 2026-05-05 review GE-1, MUST
happen before any DB write): server resolves `remotePath` to its
absolute canonical path via SSH `realpath`, asserts the resolved path
is rooted under one of the server's `scan_roots` (default `/opt`,
`/srv`, `/var/www`, `/home/<deployUser>/apps`). Out-of-jail paths
(e.g. `/etc`, `/var/log`, `/`) MUST reject with 422
`target_path_jail_violation` BEFORE the row is created. Reuses
feature 009's `path-jail.ts` `realpath` helper. Without this check,
adopting `/etc` followed by Hard Delete would `rm -rf` the host's
config directory.

**Response 201** — new INSERT (no scan-row collision):

```ts
const Response201Insert = z.object({
  app: ApplicationSerialised,
  branch: z.literal("insert"),
  detected: z.object({
    repoUrl: z.string().nullable(),     // null if not a git repo
    composeServices: z.array(z.string()),
    upstreamService: z.string().nullable(),
    upstreamPort: z.number().int().nullable(),
  }),
});
```

**Response 200** — PATCH-promote (scan-row collision):

```ts
const Response200Patch = z.object({
  app: ApplicationSerialised,
  branch: z.literal("patch_promote"),
  addedFields: z.array(z.string()),     // fields that went from NULL to non-NULL
  preservedCreatedVia: z.literal("scan"),
});
```

**Response 409** — path already managed by non-scan row:

```ts
const Response409 = z.object({
  error: z.literal("path_already_managed"),
  existingAppId: z.string(),
  existingAppName: z.string(),
  existingCreatedVia: z.enum(["manual", "bootstrap", "migrate"]),
  detail: z.string(),                   // user-facing message + deeplink hint
});
```

**Response 422** — operator-supplied path invalid or jail violation:

```ts
const Response422 = z.object({
  error: z.enum(["target_path_invalid", "target_path_jail_violation"]),
  reason: z.enum([
    "not_a_directory",
    "ssh_unreachable",
    "permission_denied",
    "outside_scan_roots",       // path resolved outside server.scan_roots — per GE-1
  ]),
  resolvedPath: z.string().optional(),    // absolute path after realpath, present on jail violation
  allowedRoots: z.array(z.string()).optional(),  // server's scan_roots, present on jail violation
  detail: z.string(),
});
```

**Response 409 (cross-server domain conflict, missing typed-confirm)**:

```ts
const Response409Domain = z.object({
  error: z.literal("domain_confirmation_required"),
  conflicts: z.array(z.object({
    appId: z.string(),
    appName: z.string(),
    serverId: z.string(),
    serverLabel: z.string(),
    domain: z.string(),
    certStatus: z.string().nullable(),
  })),
  detail: z.string(),
});
```

Returned when `domain` is non-null AND cross-server check finds
conflicts AND `domainTypedConfirmation` is null OR doesn't match
domain exactly. Per Session 2026-05-05 review G-P0-1.

**Side effects**:

- INSERT branch: audit `app.migrated` with detected snapshot.
- PATCH branch: audit `app.migrated_from_scan` with `addedFields`.
- Both branches: audit `app.cross_server_domain_confirmed` ONLY when
  cross-server check at write time actually found conflicts AND
  operator typed-confirmed (per GE-5 — no false-positive audits when
  conflicts resolved between dialog and submit).
- Both branches: optionally trigger first health probe if `healthUrl`
  provided (reuses feature 006's `app-health-poller.ts` immediate-probe
  helper).
- Both branches: optionally trigger Caddy reconcile if `domain` provided
  (reuses feature 008's reconciler entry-point).

---

## US3 / US1 / US2 — no new HTTP endpoints

US1 (Bootstrap mount): purely frontend, calls existing feature 009
endpoints. US3 (FailureCard): pure presentation layer over existing
state. US2 (hooks): consumed in `scripts-runner.ts` dispatch flow,
no new HTTP surface beyond the PATCH extension above.

## Cross-feature extension: feature 009 `POST /api/applications/bootstrap`

Per Session 2026-05-05 review G-P0-1 + G-E-9: feature 009's bootstrap
endpoint MUST be extended (in feature 009's contracts, with
back-reference here) to accept `domainTypedConfirmation: string | null`
in its body and apply the same cross-server check + typed-confirm flow
as `POST /api/applications/migrate` and `POST /api/applications/:id/domain`.
The invariant — "explicit decision before HA-style domain attach" —
applies at every domain entry point, not only edit. Implementation
note: a shared helper `domain-attach-validator.ts` should encode the
check logic so all three callers consume the same code path.

## Hard-delete with `pre_destroy` — `POST /api/applications/:id/hard-delete?force=true`

Existing feature 008 hard-delete route extended (per Session 2026-05-05
review GE-2) to accept an optional `force=true` query param. Default
behaviour (no `force`) wraps via `hard-delete-with-hooks.ts`: invokes
`pre_destroy` first, aborts on non-zero. With `force=true`: skips the
hook entirely, audited as `app.hard_deleted_force_bypass` (separate
event type from regular `app.hard_deleted` for forensic clarity).
Frontend surfaces `force=true` only via the `ForceDelete` action on
the FailureCard rendered after a hook failure — never on the normal
delete flow.

---

## Shared types

### `ApplicationSerialised`

Existing shape per features 001-009 plus:

```ts
const ApplicationSerialised = z.object({
  // ... existing fields ...
  preDeployScriptPath: z.string().nullable(),
  postDeployScriptPath: z.string().nullable(),
  onFailScriptPath: z.string().nullable(),
  preDestroyScriptPath: z.string().nullable(),
  createdVia: z.enum(["manual", "scan", "bootstrap", "migrate"]),
});
```

Hook script CONTENTS never serialised — only the relative path strings.
Operator views the script via separate file-tail endpoint after invoking
it.

---

## Error response convention

All 4xx/5xx responses follow existing `AppError` shape (feature 001):

```ts
{
  error: string,                   // canonical error code
  message: string,                 // human-readable
  detail?: unknown,                // structured context
  requestId: string,
}
```

New error codes introduced by this feature:

| Code | Where | Meaning |
|---|---|---|
| `script_path_hooks_mutually_exclusive` | PATCH /apps/:id | FR-013a invariant violation |
| `domain_confirmation_required` | POST /apps/:id/domain, POST /apps/migrate, POST /apps/bootstrap | US4 typed-confirm missing/wrong on cross-server conflict (per Session 2026-05-05 review G-P0-1, applies at all 3 domain entry points) |
| `path_already_managed` | POST /apps/migrate | US6 non-scan row at target path |
| `target_path_invalid` | POST /apps/migrate | US6 SSH check failed for path |
| `target_path_jail_violation` | POST /apps/migrate | US6 path resolves outside server's scan_roots — per Session 2026-05-05 review GE-1 (security) |
| `pre_destroy_hook_failed` | DELETE /apps/:id/hard-delete | Hard-delete blocked by failed pre_destroy hook; FailureCard surfaces Retry + ForceDelete actions per FR-010 |

Per CLAUDE.md AGCG: never `throw new Error()` raw; use existing
`AppError.badRequest()`, `AppError.notFound()`, `AppError.conflict()`,
`AppError.internal()` factory methods.
