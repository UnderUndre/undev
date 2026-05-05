# API Contracts: Blue/Green Deploy with Connection Drain

**Date**: 2026-05-05 | **Branch**: `012-blue-green-deploy` | **Plan**: [../plan.md](../plan.md)

All endpoints under `/api`. JSON bodies. Auth via existing session
middleware. All mutations emit `audit_entries`. Bodies validated with
Zod (CLAUDE.md AGCG); shown schemas are the contract — route Zod MUST
match exactly.

---

## US1 — Configure deploy strategy

### `PATCH /api/applications/:id` — extended for blue-green fields

Existing endpoint. This feature extends body validation:

**Request body (extension)**:

```ts
const BlueGreenFields = z.object({
  deployStrategy: z.enum(["recreate", "blue_green"]).optional(),
  drainSeconds: z.number().int().min(0).max(600).optional(),
  greenHealthcheckTimeoutSeconds: z.number().int().min(10).max(1800).optional(),
  acknowledgeVolumeSharing: z.boolean().optional(),
});
```

**Validator pipeline** (`blue-green-validator.ts`):

When PATCH body sets `deployStrategy = 'blue_green'` (or app already
has `blue_green` and PATCH modifies any related field), validator
performs cross-field checks:

1. **Caddy required** (FR-006): app's `proxy_type` MUST be `'caddy'`.
   Mismatch → 400 `blue_green_requires_caddy`.
2. **Single replica** (FR-007): parsed compose
   `services.<upstream_service>.deploy.replicas` MUST be 1 or unset.
   Mismatch → 400 `blue_green_replicas_not_supported_v1`.
3. **No network_mode host** (FR-008): parsed compose
   `services.<upstream_service>.network_mode` MUST NOT be `'host'`.
   Mismatch → 400 `blue_green_incompatible_compose` with
   `reason: 'network_mode_host'`.
4. **No host port pins** (FR-008): parsed compose
   `services.<upstream_service>.ports[]` entries MUST NOT pin host ports
   (e.g. `"8080:80"`). `expose:` is OK. Mismatch → 400
   `blue_green_incompatible_compose` with `reason: 'host_port_pins'`.
5. **Healthcheck required** (A-003): parsed compose
   `services.<upstream_service>.healthcheck` MUST be defined.
   Mismatch → 400 `blue_green_incompatible_compose` with
   `reason: 'no_healthcheck'`.
6. **Volume acknowledgement** (FR-008a): if parsed compose
   `services.<upstream_service>.volumes` is non-empty, `acknowledgeVolumeSharing`
   MUST be `true`. Mismatch → 400 `volume_sharing_unacknowledged` with
   response payload listing detected volumes for UI display.

**Response 400** — any of the above:

```ts
const Response400 = z.discriminatedUnion("error", [
  z.object({ error: z.literal("blue_green_requires_caddy"), message: z.string(), requestId: z.string() }),
  z.object({ error: z.literal("blue_green_replicas_not_supported_v1"), message: z.string(), detectedReplicas: z.number(), requestId: z.string() }),
  z.object({
    error: z.literal("blue_green_incompatible_compose"),
    reason: z.enum(["network_mode_host", "host_port_pins", "no_healthcheck"]),
    message: z.string(),
    detail: z.unknown(),
    requestId: z.string(),
  }),
  z.object({
    error: z.literal("volume_sharing_unacknowledged"),
    detectedVolumes: z.array(z.object({ source: z.string(), target: z.string(), mode: z.enum(["bind", "named", "tmpfs"]) })),
    message: z.string(),
    requestId: z.string(),
  }),
]);
```

**Side effects on success**:

- DB UPDATE applies the new fields. If `deployStrategy` toggled from
  `recreate` to `blue_green`, leave `active_color` NULL until first
  blue/green deploy. If toggled `blue_green` to `recreate`, clear
  `active_color` to NULL.
- Audit `app.deploy_strategy_changed` with full diff payload (including
  list of acknowledged volumes if applicable).
- Active deploys NOT affected — PATCH while deploy is in-flight blocked
  by deploy_lock per existing feature 004 semantics.

---

## US2 — Deploy execution (no new endpoint)

The deploy entry point (existing `POST /api/applications/:id/deploy`)
bifurcates server-side on `applications.deploy_strategy`. No URL or
body change visible to operators. Live progress streams via existing
WS event channel (`script.run.tail` / `bootstrap.state-changed` reused
with new event names).

**Live progress events** (added by this feature):

```ts
// New WS event types (extending existing deploy event family)
type BlueGreenStateChangedEvent = {
  topic: "blue_green.state-changed";
  appId: string;
  fromState: string | null;     // null when entering CANDIDATE_STARTING
  toState: string;               // any phase token
  occurredAt: string;
  metadata?: {
    candidateColor?: 'blue' | 'green';
    drainRemainingMs?: number;   // populated during OUTGOING_DRAINING
    candidateName?: string;
  };
};
```

UI subscribes per app via `useBlueGreenDeployState(appId)` hook.

---

## US3 / US4 — Manual recovery RPCs

All under `routes/blue-green.ts` (per plan D3). 6 endpoints:

### `POST /api/applications/:id/blue-green/abort`

**Operator action**: clicks "Abort and rollback" during
`OUTGOING_DRAINING` phase.

**Request body**:

```ts
const Body = z.object({
  typedConfirmation: z.string(),  // MUST equal app.name exactly
});
```

**Response 200**:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  abortedFromPhase: z.string(),
  abortedAtIso: z.string(),
});
```

**Response 400** — `typed_confirmation_mismatch`:

```ts
const Response400 = z.object({
  error: z.literal("typed_confirmation_mismatch"),
  message: z.literal("typed app name does not match"),
  requestId: z.string(),
});
```

**Response 409** — abort window has passed (deploy_state advanced past
`OUTGOING_DRAINING` per FR-025):

```ts
const Response409 = z.object({
  error: z.literal("too_late_to_abort"),
  currentPhase: z.string(),
  message: z.string(),
  requestId: z.string(),
});
```

**Side effects**:

- Caddy upstream switches BACK to outgoing color via
  `caddy-upstream-switcher.ts`.
- Candidate container stopped + removed.
- `deploy_state` → `FAILED_DRAIN_ABORT` → cleared to NULL.
- Override compose file deleted.
- Audit `deploy.aborted` emitted.
- Notification `deploy.aborted` dispatched (security-class, default ON).

### `POST /api/applications/:id/blue-green/recover-caddy/retry-healthcheck`

**Operator action**: clicks "Retry healthcheck" on the
`caddy_admin_failure_post_switch` FailureCard.

**Request body**: empty.

**Response 200** — admin API recovered:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  caddyAdminReachable: z.literal(true),
  resumeFromPhase: z.literal("OUTGOING_DRAINING"),
  drainRemainingMs: z.number().int(),
});
```

**Response 503** — admin API still down:

```ts
const Response503 = z.object({
  error: z.literal("caddy_admin_still_unreachable"),
  httpStatus: z.number().nullable(),
  errorMessage: z.string(),
  message: z.string(),
  requestId: z.string(),
});
```

**Side effects on success**: drain timer resumes from paused position
via `drainTimer.resume(appId, remainingMs, onComplete)`. State machine
transitions back to `OUTGOING_DRAINING`. Audit
`deploy.caddy_admin_recovered_via_retry`.

### `POST /api/applications/:id/blue-green/recover-caddy/mark-recovered`

**Operator action**: clicks "Mark recovered" on the same FailureCard
after externally verifying Caddy state matches dashboard's intent.

**Request body**:

```ts
const Body = z.object({
  typedConfirmation: z.string(),  // MUST equal app.name exactly
});
```

**Response 200**:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  resumeFromPhase: z.literal("OUTGOING_DRAINING"),
  drainRemainingMs: z.number().int(),
});
```

**Side effects**: drain timer resumes from paused position. Audit
`deploy.caddy_admin_marked_recovered_by_operator` with operator id +
external-verification timestamp.

### `POST /api/applications/:id/blue-green/interrupted/resume`

**Operator action**: on the "Interrupted deploys" panel, clicks
"Resume from <phase>" for an interrupted-by-restart deploy.

**Request body**:

```ts
const Body = z.object({
  resumeFromPhase: z.enum([
    "CANDIDATE_STARTING",
    "CANDIDATE_HEALTHY",
    "SWITCHING",
    "OUTGOING_DRAINING",
    "OUTGOING_STOPPED",
  ]),
  typedConfirmation: z.string(),  // MUST equal app.name
});
```

**Response 200**:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  resumedAtPhase: z.string(),
  sanityProbeResults: z.object({
    candidateContainerState: z.string(),
    outgoingContainerState: z.string(),
    caddyReachable: z.boolean(),
  }),
});
```

**Side effects**:

- Sanity probe runs FIRST (docker inspect both containers + caddy admin
  ping). If probe results are inconsistent with `resumeFromPhase`
  (e.g. resume from OUTGOING_DRAINING but candidate container is
  exited), reject with 422 `inconsistent_state_for_resume`.
- State machine re-enters at `resumeFromPhase`. Side-effects of that
  phase re-execute (e.g. resuming OUTGOING_DRAINING starts a fresh
  drain timer with full `drain_seconds` — NOT the remaining time
  from before, since dashboard restart lost that).
- Audit `deploy.interrupted_resumed` with phase + sanity probe results.

**Response 422** — sanity probe inconsistent:

```ts
const Response422 = z.object({
  error: z.literal("inconsistent_state_for_resume"),
  expectedAtPhase: z.string(),
  actualState: z.object({
    candidateContainerState: z.string(),
    outgoingContainerState: z.string(),
    caddyReachable: z.boolean(),
  }),
  recommendation: z.string(),  // human hint, e.g. "Use Abort instead"
  requestId: z.string(),
});
```

### `POST /api/applications/:id/blue-green/interrupted/abort-cleanup`

**Operator action**: on "Interrupted deploys" panel, clicks "Abort and
clean up candidate" — operator decides not to resume; just clean up
the half-built candidate container.

**Request body**:

```ts
const Body = z.object({
  typedConfirmation: z.string(),  // MUST equal app.name
});
```

**Response 200**:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  candidateRemovedName: z.string().nullable(),  // null if no candidate found
  outgoingPreserved: z.boolean(),
});
```

**Side effects**:

- Candidate container force-stopped + removed (if running). Outgoing
  container LEFT ALIVE.
- `deploy_state` cleared to NULL. `active_color` UNCHANGED (the
  pre-deploy active color stays as-is).
- Override compose file deleted if present.
- Audit `deploy.interrupted_aborted_cleanup` with cleanup details.

### `POST /api/applications/:id/blue-green/interrupted/mark-complete`

**Operator action**: on "Interrupted deploys" panel, clicks "Mark
complete" — operator externally verified that the deploy actually
completed (e.g. swap finished and outgoing was already stopped, just
DB column wasn't updated when dashboard crashed).

**Request body**:

```ts
const Body = z.object({
  finalActiveColor: z.enum(["blue", "green"]),  // operator's externally-verified color
  typedConfirmation: z.string(),  // MUST equal app.name
});
```

**Response 200**:

```ts
const Response200 = z.object({
  ok: z.literal(true),
  finalActiveColor: z.enum(["blue", "green"]),
});
```

**Side effects**:

- `active_color` set to operator-provided value.
- `deploy_state` cleared to NULL.
- Override compose file deleted if present.
- Audit `deploy.interrupted_marked_complete_by_operator` with operator
  id + verified color.

---

## Restart-recovery panel data

### `GET /api/applications/interrupted-deploys`

Reads from in-memory cache populated at boot per R-006.

**Query**: empty.

**Response 200**:

```ts
const Response200 = z.object({
  rows: z.array(z.object({
    appId: z.string(),
    appName: z.string(),
    serverId: z.string(),
    serverLabel: z.string(),
    lastPhase: z.string(),
    lastPhaseStartedAt: z.string(),
    activeColor: z.enum(["blue", "green"]).nullable(),
    candidate: z.object({
      name: z.string(),
      state: z.enum(["running", "exited", "missing", "unhealthy"]),
      exitCode: z.number().int().optional(),
    }),
    outgoing: z.object({
      name: z.string(),
      state: z.enum(["running", "exited", "missing"]),
    }),
  })),
});
```

Empty `rows` array = no interrupted deploys. UI hides the panel.

---

## Shared types

### `ApplicationSerialised` — extension

Existing shape per features 001-011 plus:

```ts
const ApplicationSerialised = z.object({
  // ... existing fields ...
  deployStrategy: z.enum(["recreate", "blue_green"]),
  drainSeconds: z.number().int(),
  greenHealthcheckTimeoutSeconds: z.number().int(),
  activeColor: z.enum(["blue", "green"]).nullable(),
  deployState: z.string().nullable(),  // any phase token or null
  deployStateStartedAt: z.string().nullable(),
});
```

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
| `blue_green_requires_caddy` | PATCH /apps/:id | proxy_type != 'caddy' |
| `blue_green_replicas_not_supported_v1` | PATCH /apps/:id | replicas > 1 |
| `blue_green_incompatible_compose` | PATCH /apps/:id | network_mode:host, host port pins, OR no healthcheck |
| `volume_sharing_unacknowledged` | PATCH /apps/:id | volumes detected, ack=false |
| `typed_confirmation_mismatch` | abort / recover / cleanup / mark-complete | typed app name does not match |
| `too_late_to_abort` | POST /abort | deploy_state advanced past OUTGOING_DRAINING |
| `caddy_admin_still_unreachable` | POST /recover-caddy/retry-healthcheck | admin API still down on retry |
| `inconsistent_state_for_resume` | POST /interrupted/resume | sanity probe rejects requested resume phase |

Per CLAUDE.md AGCG: never `throw new Error()` raw; use existing
`AppError.*` factory methods.
