/**
 * Feature 010 T064 — wire server-side state declarations to client actions.
 *
 * The server's `FAILURE_STATE_DECLARATIONS` is pure data (icons, action
 * kinds). This module sits on the client and produces fully-wired
 * `FailureAction[]` for the four contexts (deploy, bootstrap, cert, health).
 */

import type { FailureAction, NavTrigger } from "../components/failure/FailureCard.js";

// Mirror of the server-side enum + declarations to avoid an import path
// crossing the server/client boundary. Drift is caught by
// `tests/unit/failure-state-declarations.test.ts` invariant assertions.
export type FailureActionKind =
  | "Retry"
  | "RetryFromFailedStep"
  | "EditConfig"
  | "ViewLog"
  | "HardDelete"
  | "ForceDelete"
  | "ForceRenew"
  | "Custom";

export interface FailureStateDeclaration {
  icon: string;
  applicableContexts: ReadonlyArray<"deploy" | "bootstrap" | "cert" | "health">;
  defaultActionKinds: ReadonlyArray<FailureActionKind>;
  fromStep?: string;
  customLabel?: string;
}

// Subset of the server registry used by the client. Synced manually with
// `server/lib/failure-state-declarations.ts`.
export const CLIENT_FAILURE_STATE_DECLARATIONS: Readonly<Record<string, FailureStateDeclaration>> = {
  failed: { icon: "alert", applicableContexts: ["deploy"], defaultActionKinds: ["Retry", "ViewLog"] },
  deploy_timeout: { icon: "clock", applicableContexts: ["deploy"], defaultActionKinds: ["Retry", "EditConfig"] },
  failed_clone: { icon: "package", applicableContexts: ["bootstrap"], defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"], fromStep: "cloning" },
  failed_compose: { icon: "wrench", applicableContexts: ["bootstrap"], defaultActionKinds: ["RetryFromFailedStep", "EditConfig", "HardDelete"], fromStep: "compose_up" },
  failed_healthcheck: { icon: "alert", applicableContexts: ["bootstrap"], defaultActionKinds: ["RetryFromFailedStep", "ViewLog", "HardDelete"], fromStep: "healthcheck" },
  failed_proxy: { icon: "network", applicableContexts: ["bootstrap"], defaultActionKinds: ["RetryFromFailedStep", "EditConfig"], fromStep: "proxy_applied" },
  failed_cert: { icon: "lock", applicableContexts: ["bootstrap"], defaultActionKinds: ["RetryFromFailedStep", "EditConfig"], fromStep: "cert_issued" },
  failed_clone_pat_expired: { icon: "lock", applicableContexts: ["bootstrap"], defaultActionKinds: ["Custom", "RetryFromFailedStep"], fromStep: "cloning", customLabel: "Reconnect GitHub" },
  cert_failed: { icon: "lock", applicableContexts: ["cert"], defaultActionKinds: ["ForceRenew", "EditConfig"] },
  cert_rate_limited: { icon: "clock", applicableContexts: ["cert"], defaultActionKinds: ["ViewLog"] },
  cert_pending_reconcile: { icon: "wrench", applicableContexts: ["cert"], defaultActionKinds: ["ForceRenew"] },
  http_probe_blocked: { icon: "network", applicableContexts: ["health"], defaultActionKinds: ["EditConfig", "ViewLog"] },
  caddy_unreachable: { icon: "network", applicableContexts: ["health"], defaultActionKinds: ["Custom"], customLabel: "Open Caddy admin" },
  pre_destroy_hook_failed: { icon: "wrench", applicableContexts: ["deploy"], defaultActionKinds: ["Retry", "ForceDelete"] },
};

export type FailureContext =
  | { kind: "deploy"; jobId: string; appId: string }
  | { kind: "bootstrap"; appId: string; bootstrapState: string }
  | { kind: "cert"; certId: string; appId: string; certStatus: string }
  | { kind: "health"; appId: string };

export interface FailureCallbacks {
  retryDeploy: (jobId: string) => void;
  retryFromStep: (appId: string, fromStep: string) => void;
  forceRenew: (certId: string) => void;
  openHardDeleteDialog: (appId: string) => void;
  openForceDeleteDialog: (appId: string) => void;
}

function editHrefForCtx(ctx: FailureContext): string {
  switch (ctx.kind) {
    case "deploy":
    case "bootstrap":
    case "cert":
    case "health":
      return `/apps/${ctx.appId}`;
  }
}

function logHrefForCtx(ctx: FailureContext): string {
  switch (ctx.kind) {
    case "deploy":
      return `/apps/${ctx.appId}#deploy-log:${ctx.jobId}`;
    case "bootstrap":
      return `/apps/${ctx.appId}#bootstrap-log`;
    case "cert":
      return `/apps/${ctx.appId}#cert-events:${ctx.certId}`;
    case "health":
      return `/apps/${ctx.appId}#health`;
  }
}

function customNav(state: string, ctx: FailureContext): NavTrigger {
  if (state === "failed_clone_pat_expired") {
    return { type: "navigate", href: "/settings#github" };
  }
  if (state === "caddy_unreachable") {
    return { type: "navigate", href: `/apps/${ctx.kind === "health" ? ctx.appId : (ctx as { appId: string }).appId}#caddy` };
  }
  return { type: "navigate", href: editHrefForCtx(ctx) };
}

function wireOne(
  kind: FailureActionKind,
  declaration: FailureStateDeclaration,
  state: string,
  ctx: FailureContext,
  cb: FailureCallbacks,
): FailureAction {
  switch (kind) {
    case "Retry":
      return ctx.kind === "deploy"
        ? { kind: "Retry", trigger: { type: "callback", onClick: () => cb.retryDeploy(ctx.jobId) } }
        : ctx.kind === "bootstrap"
          ? { kind: "Retry", trigger: { type: "callback", onClick: () => cb.retryFromStep(ctx.appId, declaration.fromStep ?? "current") } }
          : { kind: "Retry", trigger: { type: "navigate", href: editHrefForCtx(ctx) } };
    case "RetryFromFailedStep": {
      const step = declaration.fromStep ?? "current";
      const appId = ctx.kind === "bootstrap" ? ctx.appId : ctx.kind === "deploy" ? ctx.appId : ctx.kind === "cert" ? ctx.appId : ctx.appId;
      return {
        kind: "RetryFromFailedStep",
        fromStep: step,
        trigger: { type: "callback", onClick: () => cb.retryFromStep(appId, step) },
      };
    }
    case "EditConfig":
      return { kind: "EditConfig", trigger: { type: "navigate", href: editHrefForCtx(ctx) } };
    case "ViewLog":
      return { kind: "ViewLog", trigger: { type: "navigate", href: logHrefForCtx(ctx) } };
    case "HardDelete": {
      const appId = ctx.kind === "bootstrap" ? ctx.appId : ctx.kind === "deploy" ? ctx.appId : ctx.kind === "cert" ? ctx.appId : ctx.appId;
      return { kind: "HardDelete", trigger: { type: "callback", onClick: () => cb.openHardDeleteDialog(appId) } };
    }
    case "ForceDelete": {
      const appId = ctx.kind === "bootstrap" ? ctx.appId : ctx.kind === "deploy" ? ctx.appId : ctx.kind === "cert" ? ctx.appId : ctx.appId;
      return { kind: "ForceDelete", trigger: { type: "callback", onClick: () => cb.openForceDeleteDialog(appId) } };
    }
    case "ForceRenew":
      if (ctx.kind === "cert") {
        return { kind: "ForceRenew", trigger: { type: "callback", onClick: () => cb.forceRenew(ctx.certId) } };
      }
      throw new Error("ForceRenew_requires_cert_context");
    case "Custom":
      return {
        kind: "Custom",
        label: declaration.customLabel ?? "Action",
        trigger: customNav(state, ctx),
      };
    default: {
      const _never: never = kind;
      throw new Error(`unhandled_action_kind:${JSON.stringify(_never)}`);
    }
  }
}

export function wireActions(
  state: string,
  ctx: FailureContext,
  callbacks: FailureCallbacks,
): FailureAction[] {
  const declaration = CLIENT_FAILURE_STATE_DECLARATIONS[state];
  if (!declaration) return [];
  if (!declaration.applicableContexts.includes(ctx.kind)) return [];
  return declaration.defaultActionKinds.map((kind) =>
    wireOne(kind, declaration, state, ctx, callbacks),
  );
}
