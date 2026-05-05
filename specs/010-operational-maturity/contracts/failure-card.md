# FailureCard Contract

**Date**: 2026-05-05 | **Branch**: `010-operational-maturity` | **Plan**: [../plan.md](../plan.md)

This is the operational contract for `FailureCard` and its typed
`FailureAction` discriminated union — the unified failure surface for
deploy / bootstrap / cert / health failures (US3).

The `kind` discriminator is the single source of UX vocabulary across
the dashboard. Any drift from this contract = TypeScript compile error.

---

## `FailureAction` discriminated union

**Revised per Session 2026-05-05 review G-P1-5**: the `href OR onClick`
mutual-exclusion is now ENFORCED by types via a nested `ActionTrigger`
union. Optional `href?: string; onClick?: () => void` would have allowed
both/neither — typed `trigger: ActionTrigger` allows exactly one.

```ts
// client/components/failure/FailureCard.tsx — exported types

/** Exactly-one-of trigger — types enforce that an action has either
 *  navigation or callback wiring, never both, never neither. */
export type ActionTrigger =
  | { type: "navigate"; href: string }
  | { type: "callback"; onClick: () => void };

/** Subset of triggers allowed for destructive actions. Destructive
 *  actions MUST be callbacks (they open a typed-confirm dialog before
 *  firing — navigation would skip the confirm). */
export type DestructiveTrigger = Extract<ActionTrigger, { type: "callback" }>;

/** Subset for navigation-only actions (e.g. EditConfig, ViewLog). */
export type NavTrigger = Extract<ActionTrigger, { type: "navigate" }>;

export type FailureAction =
  | { kind: "Retry"; trigger: ActionTrigger }
  | { kind: "RetryFromFailedStep"; fromStep: string; trigger: ActionTrigger }
  | { kind: "EditConfig"; trigger: NavTrigger }
  | { kind: "ViewLog"; trigger: NavTrigger }
  | { kind: "HardDelete"; trigger: DestructiveTrigger }
  | { kind: "ForceDelete"; trigger: DestructiveTrigger }
  | { kind: "ForceRenew"; trigger: DestructiveTrigger }
  | { kind: "Custom"; label: string; trigger: ActionTrigger };

// NOTE: `Revoke` REMOVED from FailureAction enum per Session 2026-05-05
// review G-P0-4 + FR-017 fix — Revoke lives on the cert-management UI
// when status is 'active', NOT on FailureCard which only renders for
// failed/rate_limited/pending_reconcile states.
//
// `ForceDelete` ADDED per Session 2026-05-05 review GE-2 — used as a
// recovery action when pre_destroy hook fails, allowing operator to
// explicitly bypass the broken hook. Carries a typed-confirm dialog
// before firing (DestructiveTrigger).
```

### Variant semantics

| Variant | Trigger type | Display label | Visual treatment |
|---|---|---|---|
| `Retry` | `ActionTrigger` (nav or callback) | "Retry" | Primary button |
| `RetryFromFailedStep` | `ActionTrigger` + `fromStep` | "Retry from <step>" (label includes resolved step) | Primary button |
| `EditConfig` | `NavTrigger` (always navigation) | "Edit config" | Secondary button |
| `ViewLog` | `NavTrigger` (always navigation) | "View full log" | Secondary button |
| `HardDelete` | `DestructiveTrigger` (callback only — typed-confirm dialog) | "Hard delete…" | Destructive button (red) |
| `ForceDelete` | `DestructiveTrigger` | "Force delete (bypass hook)" | Destructive button (red), shown ONLY on `pre_destroy_hook_failed` state |
| `ForceRenew` | `DestructiveTrigger` (callback only — interrupts cert lifecycle) | "Force renew" | Destructive button (orange) |
| `Custom` | `ActionTrigger` + freeform `label` | `label` | Secondary button (default) |

**Removed**: `Revoke` (previously P1 of action set per FR-017).
Reason: Revoke is meaningful only when cert is `active`, but
FailureCard only renders for cert *failures*. Logical contradiction
caught in Session 2026-05-05 review G-P0-4. Revoke now lives on the
normal cert-management UI in `DomainTlsSection`.

**Added**: `ForceDelete`. Reason: when `pre_destroy` hook fails (script
gone, syntax error, transient SSH issue), the app would otherwise be
permanently undeletable. Recovery action lets operator explicitly bypass
the hook with audit trail (`app.hard_deleted_force_bypass`).

---

## `FailureCard` component contract

```ts
export interface FailureCardProps {
  state: string;          // context-specific token, e.g. "failed_clone"
                          // (used by failure-state-mapper for icon lookup)
  summary: string;        // one-line human; rendered as <h3>
  details?: ReactNode;    // expandable; long form, log excerpt, stack trace
  actions?: FailureAction[];  // empty array OR omit = no action row
}

export function FailureCard(props: FailureCardProps): JSX.Element;
```

### Visual layout (FR-018)

```
┌────────────────────────────────────────────────┐
│ ⚠ <state-icon> {summary}                       │  ← red border, status icon
├────────────────────────────────────────────────┤
│ {details}                                      │  ← expandable, monospace if pre,
│                                                  │    React tree otherwise
├────────────────────────────────────────────────┤
│            [action 1] [action 2] [destructive] │  ← action bar, destructive far-right
└────────────────────────────────────────────────┘
```

- Red border (`border-red-500` Tailwind) — invariant across all variants
- Status icon driven by `state` token via `FAILURE_STATE_DECLARATIONS`
  on server + `wireActions` on client (clock for rate-limited, network
  for caddy_unreachable, etc — see split server/client registry below)
- Action row hidden when `actions` empty OR omitted
- Destructive variants (`HardDelete`, `ForceDelete`, `ForceRenew`)
  auto-positioned far-right with extra spacing to reduce mis-click

---

## State registry — split server/client (per Session 2026-05-05 review G-P0-2)

The earlier draft put callbacks (`retryDeploy`, `openHardDeleteDialog`,
`href` paths) inside a `server/lib/failure-state-mapper.ts` module —
broken across the server/client boundary (server has no React, no
client routes). Fixed by splitting into two modules:

### Server-side declarations (pure data)

`devops-app/server/lib/failure-state-declarations.ts` — pure data,
zero callbacks, zero React, zero client-route hardcoding. The server
needs this only to (a) emit `state` tokens it knows are renderable,
(b) validate operator-supplied state strings in tests.

```ts
// server/lib/failure-state-declarations.ts

export type FailureActionKind =
  | "Retry"
  | "RetryFromFailedStep"
  | "EditConfig"
  | "ViewLog"
  | "HardDelete"
  | "ForceDelete"
  | "ForceRenew"
  | "Custom";

export type FailureIcon = "clock" | "network" | "shield" | "wrench" | "alert" | "package" | "lock";

export interface FailureStateDeclaration {
  icon: FailureIcon;
  applicableContexts: ("deploy" | "bootstrap" | "cert" | "health")[];
  defaultActionKinds: FailureActionKind[];
  // For RetryFromFailedStep variants — the bootstrap step to resume from.
  fromStep?: string;
  // For Custom variants — the freeform label to render.
  customLabel?: string;
}

export const FAILURE_STATE_DECLARATIONS: Record<string, FailureStateDeclaration> = {
  // Deploy failures (job-status driven)
  "failed": {
    icon: "alert",
    applicableContexts: ["deploy"],
    defaultActionKinds: ["Retry", "ViewLog"],
  },
  "deploy_timeout": {
    icon: "clock",
    applicableContexts: ["deploy"],
    defaultActionKinds: ["Retry", "EditConfig"],
  },

  // Bootstrap failures (feature 009 state machine)
  "failed_clone": {
    icon: "package",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"],
    fromStep: "cloning",
  },
  "failed_compose": {
    icon: "wrench",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"],
    fromStep: "compose_up",
  },
  "failed_healthcheck": {
    icon: "alert",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "ViewLog", "HardDelete"],
    fromStep: "healthcheck",
  },
  "failed_proxy": {
    icon: "network",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig"],
    fromStep: "proxy_applied",
  },
  "failed_cert": {
    icon: "lock",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["RetryFromFailedStep", "EditConfig"],
    fromStep: "cert_issued",
  },
  "failed_clone_pat_expired": {
    icon: "lock",
    applicableContexts: ["bootstrap"],
    defaultActionKinds: ["Custom", "RetryFromFailedStep"],
    fromStep: "cloning",
    customLabel: "Reconnect GitHub",
  },

  // Cert failures (feature 008)
  "cert_failed": {
    icon: "lock",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ForceRenew", "EditConfig"],
    // Note: Revoke INTENTIONALLY excluded — see Session 2026-05-05 review G-P0-4.
  },
  "cert_rate_limited": {
    icon: "clock",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ViewLog"],
    // No Retry — operator must wait out the rate limit window.
  },
  "cert_pending_reconcile": {
    icon: "wrench",
    applicableContexts: ["cert"],
    defaultActionKinds: ["ForceRenew"],
  },

  // Health failures (feature 006)
  "http_probe_blocked": {
    icon: "network",
    applicableContexts: ["health"],
    defaultActionKinds: ["EditConfig", "ViewLog"],
  },
  "caddy_unreachable": {
    icon: "network",
    applicableContexts: ["health"],
    defaultActionKinds: ["Custom"],
    customLabel: "Open Caddy admin",
  },

  // Hard-delete failure recovery (per Session 2026-05-05 review GE-2)
  "pre_destroy_hook_failed": {
    icon: "wrench",
    applicableContexts: ["deploy"],   // surfaces in app-detail / DeployLog area
    defaultActionKinds: ["Retry", "ForceDelete"],
  },
};
```

### Client-side wiring (callbacks + routes)

`devops-app/client/lib/failure-state-wiring.ts` — consumes the server
declarations and produces fully-wired `FailureAction[]` per context.
Lives on the client where React imports + route helpers are available.

```ts
// client/lib/failure-state-wiring.ts

import { FAILURE_STATE_DECLARATIONS, type FailureActionKind, type FailureStateDeclaration } from "@/server-types/failure-state-declarations";

export type FailureContext =
  | { kind: "deploy"; jobId: string; appId: string }
  | { kind: "bootstrap"; appId: string; bootstrapState: string }
  | { kind: "cert"; certId: string; appId: string; certStatus: string }
  | { kind: "health"; appId: string };

/** Wires a declaration's action-kind list to actual callbacks/hrefs. */
export function wireActions(
  state: string,
  ctx: FailureContext,
  callbacks: FailureCallbacks,
): FailureAction[] {
  const declaration = FAILURE_STATE_DECLARATIONS[state];
  if (!declaration) return [];
  if (!declaration.applicableContexts.includes(ctx.kind)) return [];
  return declaration.defaultActionKinds.map((kind) =>
    wireOne(kind, declaration, ctx, callbacks),
  );
}

/** All side-effects the wiring layer can produce — DI'd at component
 *  mount so tests can mock them.  */
export interface FailureCallbacks {
  retryDeploy: (jobId: string) => void;
  retryFromStep: (appId: string, fromStep: string) => void;
  forceRenew: (certId: string) => void;
  openHardDeleteDialog: (appId: string) => void;
  openForceDeleteDialog: (appId: string) => void;
}

function wireOne(
  kind: FailureActionKind,
  declaration: FailureStateDeclaration,
  ctx: FailureContext,
  cb: FailureCallbacks,
): FailureAction {
  switch (kind) {
    case "Retry":
      return ctx.kind === "deploy"
        ? { kind: "Retry", trigger: { type: "callback", onClick: () => cb.retryDeploy(ctx.jobId) } }
        : { kind: "Retry", trigger: { type: "callback", onClick: () => cb.retryFromStep(ctx.appId, "current") } };
    case "RetryFromFailedStep":
      return {
        kind: "RetryFromFailedStep",
        fromStep: declaration.fromStep ?? "current",
        trigger: { type: "callback", onClick: () => cb.retryFromStep(ctx.appId, declaration.fromStep ?? "current") },
      };
    case "EditConfig":
      return { kind: "EditConfig", trigger: { type: "navigate", href: editHrefForCtx(ctx) } };
    case "ViewLog":
      return { kind: "ViewLog", trigger: { type: "navigate", href: logHrefForCtx(ctx) } };
    case "HardDelete":
      return { kind: "HardDelete", trigger: { type: "callback", onClick: () => cb.openHardDeleteDialog(ctx.appId) } };
    case "ForceDelete":
      return { kind: "ForceDelete", trigger: { type: "callback", onClick: () => cb.openForceDeleteDialog(ctx.appId) } };
    case "ForceRenew":
      return ctx.kind === "cert"
        ? { kind: "ForceRenew", trigger: { type: "callback", onClick: () => cb.forceRenew(ctx.certId) } }
        : (() => { throw AppError.internal("ForceRenew_requires_cert_context"); })();
    case "Custom":
      return {
        kind: "Custom",
        label: declaration.customLabel ?? "Action",
        trigger: customTriggerForState(state, ctx),
      };
    default: {
      const _never: never = kind;
      throw AppError.internal(`unhandled_action_kind:${JSON.stringify(_never)}`);
    }
  }
}

// editHrefForCtx, logHrefForCtx, customTriggerForState — pure helpers
// mapping context to client routes. Live in same module.
```

**Why split**: server emits `state` tokens (e.g. `"failed_compose"`)
in API responses + audit entries. Client needs to render those tokens
into action rows. If the server tried to ship pre-wired actions, every
state-to-action change would couple frontend deploys to backend deploys.
Server says WHAT failed; client says WHAT TO DO ABOUT IT.

**Registry invariant**: for every `bootstrap_state` value introduced by
feature 009 that starts with `failed_`, `FAILURE_STATE_DECLARATIONS`
MUST have a corresponding entry. Plus `pre_destroy_hook_failed` per
Session 2026-05-05 review GE-2. Asserted by
`failure-state-declarations.test.ts`.

---

## Mount sites

### `DeployLog.tsx` (FR-015)

```tsx
const callbacks = useFailureCallbacks();  // resolves retryDeploy, openHardDeleteDialog, etc

{job.status === "failed" && (
  <FailureCard
    state={job.failureState ?? "failed"}
    summary={job.summary ?? "Deploy failed"}
    details={<JobLogTail jobId={job.id} />}
    actions={wireActions(job.failureState ?? "failed", { kind: "deploy", jobId: job.id, appId: job.appId }, callbacks)}
  />
)}
```

### `BootstrapStateBadge.tsx` (FR-016)

```tsx
const callbacks = useFailureCallbacks();

{app.bootstrapState.startsWith("failed_") && (
  <FailureCard
    state={app.bootstrapState}
    summary={bootstrapStateSummary(app.bootstrapState)}
    details={<BootstrapEventTail appId={app.id} />}
    actions={wireActions(app.bootstrapState, { kind: "bootstrap", appId: app.id, bootstrapState: app.bootstrapState }, callbacks)}
  />
)}
```

### `DomainTlsSection.tsx` (FR-017)

```tsx
const callbacks = useFailureCallbacks();

{(certStatus === "failed" || certStatus === "rate_limited" || certStatus === "pending_reconcile") && (
  <FailureCard
    state={`cert_${certStatus}`}
    summary={certStatusSummary(certStatus, errorMessage)}
    details={<CertErrorDetail cert={cert} />}
    actions={wireActions(`cert_${certStatus}`, { kind: "cert", certId: cert.id, appId: cert.appId, certStatus }, callbacks)}
  />
)}
```

### Hard-delete failure recovery (FR-010, per Session 2026-05-05 review GE-2)

When `DELETE /api/applications/:id/hard-delete` returns
`pre_destroy_hook_failed`, the calling component (typically
`HardDeleteDialog` or app detail page) renders a FailureCard with
`state="pre_destroy_hook_failed"`. Action set: `Retry` (re-runs
hook, useful for transient SSH issues) + `ForceDelete` (calls
`DELETE ... ?force=true`, audited as `app.hard_deleted_force_bypass`).

### Health probe failure (Apps list / app detail tooltip)

Click on the unhealthy dot navigates to app detail with an anchor that
scrolls to a FailureCard rendered inline (vs current tooltip-only).
Same registry lookup; context `kind: "health"`.

---

## Exhaustive switch enforcement

Renderer in `FailureActionButton.tsx`:

```tsx
import { AppError } from "@/lib/app-error";

function renderTrigger(action: { trigger: ActionTrigger }, label: string, ButtonKind: "primary" | "secondary" | "destructive"): JSX.Element {
  // Helper that renders one button — single nav vs callback decision
  // here, exhaustively. Keeps the per-variant switch focused on labels.
  const Button = ButtonKind === "primary" ? PrimaryButton
               : ButtonKind === "destructive" ? DestructiveButton
               : SecondaryButton;
  switch (action.trigger.type) {
    case "navigate":
      return <Button href={action.trigger.href}>{label}</Button>;
    case "callback":
      return <Button onClick={action.trigger.onClick}>{label}</Button>;
    default: {
      const _never: never = action.trigger;
      throw AppError.internal("unhandled_action_trigger", { action: _never });
    }
  }
}

export function FailureActionButton({ action }: { action: FailureAction }) {
  switch (action.kind) {
    case "Retry":
      return renderTrigger(action, "Retry", "primary");
    case "RetryFromFailedStep":
      return renderTrigger(action, `Retry from ${action.fromStep}`, "primary");
    case "EditConfig":
      return renderTrigger(action, "Edit config", "secondary");
    case "ViewLog":
      return renderTrigger(action, "View full log", "secondary");
    case "HardDelete":
      return renderTrigger(action, "Hard delete…", "destructive");
    case "ForceDelete":
      return renderTrigger(action, "Force delete (bypass hook)", "destructive");
    case "ForceRenew":
      return renderTrigger(action, "Force renew", "destructive");
    case "Custom":
      return renderTrigger(action, action.label, "secondary");
    default: {
      // TypeScript-enforced exhaustiveness — adding a variant without
      // updating the switch fails compile.
      const _never: never = action;
      throw AppError.internal("unhandled_failure_action", { kind: _never });
    }
  }
}
```

The `_never: never` assertion makes adding a 9th variant impossible
without also updating the renderer. The use of `AppError.internal`
(not raw `throw new Error()`) per CLAUDE.md AGCG (per Session
2026-05-05 review G-P1-5).

---

## Test invariants (per `failure-card.test.ts`)

1. Every `FAILURE_STATE_DECLARATIONS` entry has at least one
   `defaultActionKinds` for at least one matching `applicableContexts`
   (no zero-action-by-default states).
2. Every `bootstrap_state` value matching `/^failed_/` from feature 009
   has a declaration entry. Plus `pre_destroy_hook_failed` per
   Session 2026-05-05 review GE-2.
3. `RetryFromFailedStep` declarations always include `fromStep`.
4. Custom declarations always include `customLabel`.
5. Destructive variants (`HardDelete`, `ForceDelete`, `ForceRenew`) when
   wired produce ONLY `DestructiveTrigger` (callback-only) — types
   prevent `href` (would bypass typed-confirm).
6. Renderer's switch is exhaustive (compile-time) AND runtime (the
   `_never` throw never fires under normal operation).
7. `Revoke` is NOT in the `FailureActionKind` enum — Session 2026-05-05
   review G-P0-4 fix; if a future state declares it, typecheck fails.
