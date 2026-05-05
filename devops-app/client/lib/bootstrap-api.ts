/** Feature 009 T023 — typed REST client for the bootstrap surface. */
import { api } from "./api.js";

export type BootstrapState =
  | "init"
  | "cloning"
  | "compose_up"
  | "healthcheck"
  | "proxy_applied"
  | "cert_issued"
  | "active"
  | "failed_clone"
  | "failed_clone_pat_expired"
  | "failed_compose"
  | "failed_healthcheck"
  | "failed_proxy"
  | "failed_cert";

export type BootstrapStep =
  | "cloning"
  | "compose_up"
  | "healthcheck"
  | "proxy_applied"
  | "cert_issued";

export interface BootstrapEvent {
  id: string;
  appId: string;
  fromState: string;
  toState: string;
  occurredAt: string;
  metadata: unknown;
  actor: string;
}

export interface BootstrapStateResponse {
  id: string;
  name: string;
  bootstrapState: BootstrapState;
  createdVia: "manual" | "scan" | "bootstrap";
  domain: string | null;
  upstreamService: string | null;
  upstreamPort: number | null;
  composePath: string;
  events: BootstrapEvent[];
  currentRun: {
    runId: string;
    scriptId: string;
    status: string;
    startedAt: string;
  } | null;
}

export interface ComposeService {
  name: string;
  kind: "ok" | "ambiguous_port" | "no_port";
  exposeOrPorts: number | null;
  rawValue: string | null;
  networkModeHost: boolean;
  replicas: number;
  hasHealthcheck: boolean;
}

export interface ComposeFetchResponse {
  found: boolean;
  path?: string;
  ref?: string | null;
  services?: ComposeService[];
  errors: string[];
  warnings: string[];
}

export interface BootstrapCreateRequest {
  serverId: string;
  githubRepo: string;
  name: string;
  branch: string;
  composePath: string;
  remotePath: string;
  upstreamService: string | null;
  upstreamPort: number | null;
  domain: string | null;
  acmeEmail?: string | null;
  bootstrapAutoRetry?: boolean;
}

export interface BootstrapCreateResponse {
  id: string;
  bootstrapState: BootstrapState;
  createdVia: "bootstrap";
  events: BootstrapEvent[];
}

export interface BootstrapListItem {
  id: string;
  name: string;
  bootstrapState: BootstrapState;
  createdAt: string;
}

export const bootstrapApi = {
  fetchCompose: (
    owner: string,
    repo: string,
    path?: string,
    ref?: string,
  ): Promise<ComposeFetchResponse> => {
    const qs = new URLSearchParams();
    if (path) qs.set("path", path);
    if (ref) qs.set("ref", ref);
    const q = qs.toString();
    return api.get<ComposeFetchResponse>(
      `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compose${q ? `?${q}` : ""}`,
    );
  },
  create: (req: BootstrapCreateRequest): Promise<BootstrapCreateResponse> =>
    api.post<BootstrapCreateResponse>("/applications/bootstrap", req),
  getState: (appId: string): Promise<BootstrapStateResponse> =>
    api.get<BootstrapStateResponse>(`/applications/${appId}/bootstrap-state`),
  retryFromStep: (appId: string, fromStep: BootstrapStep): Promise<{ id: string; bootstrapState: BootstrapState }> =>
    api.post(`/applications/${appId}/bootstrap/retry?from=${fromStep}`),
  editConfig: (
    appId: string,
    cfg: Partial<{
      branch: string;
      composePath: string;
      upstreamService: string | null;
      upstreamPort: number | null;
    }>,
  ): Promise<BootstrapStateResponse> =>
    api.patch<BootstrapStateResponse>(`/applications/${appId}/bootstrap/config`, cfg),
  hardDelete: (
    appId: string,
    confirmName: string,
  ): Promise<{ id: string; removed: { remotePath: string; resolved: string } }> =>
    api.post(`/applications/${appId}/hard-delete`, { confirmName }),
  listForServer: (
    serverId: string,
    status?: "all" | "in_flight" | "failed" | "active",
  ): Promise<{ bootstraps: BootstrapListItem[] }> => {
    const qs = status ? `?status=${status}` : "";
    return api.get(`/servers/${serverId}/bootstraps${qs}`);
  },
};
