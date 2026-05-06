/**
 * Feature 011 T061+T062+T063 — Telegram config + per-event toggles.
 *
 * Single file because the three pieces are tightly coupled and only ever
 * rendered together. If they grow to need separate routing/lazy loading
 * in v2, split then.
 *
 * - TelegramConfigForm: bot token (password style) + chatId + Test button.
 * - EventToggleList:    grouped by category, toggles persist immediately.
 * - NotificationsSection: wrapper with the "needs reconfiguration" banner.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  useNotificationSettings,
  type EventCategory,
  type EventPreference,
} from "../../hooks/useNotificationSettings.js";
import { ApiError } from "../../lib/api.js";

const CATEGORY_LABEL: Record<EventCategory, string> = {
  failure: "Failure",
  security: "Security",
  success: "Success",
  operational: "Operational",
};

const CATEGORY_ORDER: EventCategory[] = [
  "failure",
  "security",
  "operational",
  "success",
];

export function NotificationsSection(): React.JSX.Element {
  const { query, updateTelegram, testConnection, toggleEvent } =
    useNotificationSettings();

  if (query.isLoading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6">
        <h2 className="text-xl font-semibold mb-4">Notifications</h2>
        <p className="text-gray-400">Loading…</p>
      </section>
    );
  }

  if (query.error) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6">
        <h2 className="text-xl font-semibold mb-4">Notifications</h2>
        <p className="text-red-400">
          Failed to load:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      </section>
    );
  }

  const data = query.data;
  if (!data) return <></>;

  const needsConfig =
    !data.telegram.botTokenConfigured ||
    data.telegram.chatId === null ||
    !data.telegram.lastTestOk;

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 md:p-6 space-y-5">
      <h2 className="text-xl font-semibold">Notifications</h2>

      {needsConfig && (
        <div
          className="rounded border border-yellow-800 bg-yellow-950/40 px-3 py-2 text-sm text-yellow-300"
          role="alert"
        >
          Telegram channel not fully configured — notifications are dropped
          until token, chat ID, and a successful Test connection are in place.
        </div>
      )}

      <TelegramConfigForm
        configured={data.telegram.botTokenConfigured}
        chatId={data.telegram.chatId}
        lastTestOk={data.telegram.lastTestOk}
        lastTestAt={data.telegram.lastTestAt}
        onUpdate={(botToken, chatId) =>
          updateTelegram.mutate({ botToken, chatId })
        }
        onTest={() => testConnection.mutate()}
        updating={updateTelegram.isPending}
        testing={testConnection.isPending}
        updateError={updateTelegram.error}
        testError={testConnection.error}
      />

      <EventToggleList
        events={data.events}
        onToggle={(eventType, enabled) =>
          toggleEvent.mutate({ eventType, enabled })
        }
      />
    </section>
  );
}

// ─── Telegram config form ───────────────────────────────────────────────────

interface TelegramConfigFormProps {
  configured: boolean;
  chatId: string | null;
  lastTestOk: boolean;
  lastTestAt: string | null;
  onUpdate: (botToken: string | null, chatId: string | null) => void;
  onTest: () => void;
  updating: boolean;
  testing: boolean;
  updateError: Error | null;
  testError: Error | null;
}

function TelegramConfigForm({
  configured,
  chatId,
  lastTestOk,
  lastTestAt,
  onUpdate,
  onTest,
  updating,
  testing,
  updateError,
  testError,
}: TelegramConfigFormProps): React.JSX.Element {
  const [tokenInput, setTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState(chatId ?? "");
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    setChatIdInput(chatId ?? "");
  }, [chatId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const newToken = tokenInput.trim() === "" ? null : tokenInput.trim();
    const newChat = chatIdInput.trim() === "" ? null : chatIdInput.trim();
    onUpdate(newToken, newChat);
    setTokenInput("");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-sm text-gray-400 mb-1" htmlFor="tg-token">
          Bot token
        </label>
        <div className="flex gap-2">
          <input
            id="tg-token"
            type={reveal ? "text" : "password"}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={
              configured ? "•••••••• (paste new value to replace)" : "123456:ABC-..."
            }
            className="flex-1 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-purple"
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="px-2 text-xs text-gray-400 hover:text-white border border-gray-700 rounded"
          >
            {reveal ? "Hide" : "Reveal"}
          </button>
        </div>
      </div>
      <div>
        <label
          className="block text-sm text-gray-400 mb-1"
          htmlFor="tg-chatid"
        >
          Chat ID
        </label>
        <input
          id="tg-chatid"
          type="text"
          value={chatIdInput}
          onChange={(e) => setChatIdInput(e.target.value)}
          placeholder="@your_channel  or  -1001234567890"
          className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-purple"
        />
      </div>

      {updateError && (
        <p className="text-sm text-red-400" role="alert">
          {updateError instanceof ApiError
            ? updateError.message
            : updateError.message}
        </p>
      )}
      {testError && (
        <p className="text-sm text-red-400" role="alert">
          Test failed: {testError.message}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={updating}
          className="bg-brand-purple hover:bg-purple-600 disabled:opacity-50 px-3 py-1.5 rounded text-sm font-medium"
        >
          {updating ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={testing || !configured}
          className="border border-gray-700 hover:border-gray-500 disabled:opacity-50 px-3 py-1.5 rounded text-sm"
          title={!configured ? "Save token first" : "Send a test message"}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <span className="text-xs text-gray-500">
          {lastTestAt === null
            ? "Not tested yet"
            : `Last test: ${lastTestAt} — ${lastTestOk ? "ok" : "failed"}`}
        </span>
      </div>
    </form>
  );
}

// ─── Event toggle list ──────────────────────────────────────────────────────

interface EventToggleListProps {
  events: EventPreference[];
  onToggle: (eventType: string, enabled: boolean) => void;
}

function EventToggleList({
  events,
  onToggle,
}: EventToggleListProps): React.JSX.Element {
  const grouped = useMemo(() => {
    const out: Record<EventCategory, EventPreference[]> = {
      failure: [],
      security: [],
      success: [],
      operational: [],
    };
    for (const e of events) out[e.category].push(e);
    return out;
  }, [events]);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-gray-300">Per-event delivery</h3>
      {CATEGORY_ORDER.map((cat) => {
        const list = grouped[cat];
        if (list.length === 0) return null;
        return (
          <div key={cat}>
            <h4 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              {CATEGORY_LABEL[cat]}
            </h4>
            <ul className="space-y-1">
              {list.map((e) => (
                <li
                  key={e.type}
                  className="flex items-center justify-between gap-3 py-1"
                >
                  <div>
                    <p className="text-sm text-gray-200">{e.description}</p>
                    <p className="text-xs text-gray-500 font-mono">{e.type}</p>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={e.enabled}
                      onChange={(ev) => onToggle(e.type, ev.target.checked)}
                      className="h-4 w-4 accent-brand-purple"
                      aria-label={`Toggle ${e.type}`}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
