/** Feature 010 T037 — debounced cross-server domain conflict lookup. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export interface DomainConflict {
  appId: string;
  appName: string;
  serverId: string;
  serverLabel: string;
  domain: string;
  certStatus: string | null;
}

const DEBOUNCE_MS = 300;

export function useCrossServerDomainCheck(
  domain: string | null,
  excludeAppId: string | null,
): { conflicts: DomainConflict[]; isLoading: boolean; error: string | null } {
  const [conflicts, setConflicts] = useState<DomainConflict[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domain || !excludeAppId) {
      setConflicts([]);
      setError(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setIsLoading(true);
      api
        .get<DomainConflict[]>(
          `/applications/cross-server-domain-check?domain=${encodeURIComponent(domain)}&excludeAppId=${encodeURIComponent(excludeAppId)}`,
        )
        .then((res) => {
          if (cancelled) return;
          setConflicts(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setConflicts([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [domain, excludeAppId]);

  return { conflicts, isLoading, error };
}
