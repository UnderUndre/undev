/** Feature 010 T045 — typed audit query hook. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export type ResourceTypeFilter = "server" | "application" | "cert" | "bootstrap" | "other";

export interface AuditFilters {
  actor?: string[];
  action?: string[];
  resourceType?: ResourceTypeFilter;
  since?: string;
  until?: string;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  resourceType: ResourceTypeFilter;
  resourceId: string | null;
  resourceLabel: string | null;
  details: unknown;
}

export interface AuditQueryResponse {
  rows: AuditRow[];
  totalCount: number;
  isCapped: boolean;
  page: number;
  pageSize: number;
}

function buildQs(filters: AuditFilters, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  for (const a of filters.actor ?? []) p.append("actor", a);
  for (const a of filters.action ?? []) p.append("action", a);
  if (filters.resourceType) p.set("resourceType", filters.resourceType);
  if (filters.since) p.set("since", filters.since);
  if (filters.until) p.set("until", filters.until);
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p.toString();
}

export function useAuditQuery(
  filters: AuditFilters,
  page: number,
  pageSize: number,
): { data: AuditQueryResponse | null; isLoading: boolean; error: string | null } {
  const [data, setData] = useState<AuditQueryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qs = buildQs(filters, page, pageSize);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    api
      .get<AuditQueryResponse>(`/audit/query?${qs}`)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [qs]);

  return { data, isLoading, error };
}

export function buildAuditCsvHref(filters: AuditFilters): string {
  const p = new URLSearchParams();
  for (const a of filters.actor ?? []) p.append("actor", a);
  for (const a of filters.action ?? []) p.append("action", a);
  if (filters.resourceType) p.set("resourceType", filters.resourceType);
  if (filters.since) p.set("since", filters.since);
  if (filters.until) p.set("until", filters.until);
  return `/api/audit/export.csv?${p.toString()}`;
}
