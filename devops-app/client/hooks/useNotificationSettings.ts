/**
 * Feature 011 T064 — typed hook over /api/settings/notifications.
 *
 * Returns combined TG state + per-event preference list, plus mutation
 * helpers (`updateTelegram`, `testConnection`, `toggleEvent`). Optimistic
 * updates with rollback on error for the per-event toggle.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export type EventCategory = "failure" | "security" | "success" | "operational";

export interface EventPreference {
  type: string;
  description: string;
  category: EventCategory;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface TelegramState {
  botTokenConfigured: boolean;
  chatId: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean;
  updatedAt: string;
}

export interface NotificationSettingsResponse {
  telegram: TelegramState;
  events: EventPreference[];
}

const QUERY_KEY = ["settings", "notifications"] as const;

export function useNotificationSettings() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      api.get<NotificationSettingsResponse>("/settings/notifications"),
  });

  const updateTelegram = useMutation({
    mutationFn: (vars: { botToken: string | null; chatId: string | null }) =>
      api.put<NotificationSettingsResponse>(
        "/settings/notifications/telegram",
        vars,
      ),
    onSuccess: (data) => qc.setQueryData(QUERY_KEY, data),
  });

  const testConnection = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; testedAt: string; classification?: string }>(
        "/settings/notifications/telegram/test",
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const toggleEvent = useMutation({
    mutationFn: (vars: { eventType: string; enabled: boolean }) =>
      api.put<{ eventType: string; enabled: boolean; updatedAt: string }>(
        `/settings/notifications/events/${encodeURIComponent(vars.eventType)}`,
        { enabled: vars.enabled },
      ),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<NotificationSettingsResponse>(QUERY_KEY);
      if (prev) {
        qc.setQueryData<NotificationSettingsResponse>(QUERY_KEY, {
          ...prev,
          events: prev.events.map((e) =>
            e.type === vars.eventType ? { ...e, enabled: vars.enabled } : e,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(QUERY_KEY, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return { query, updateTelegram, testConnection, toggleEvent };
}
