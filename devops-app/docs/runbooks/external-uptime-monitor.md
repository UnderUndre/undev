# External Uptime Monitor for the Dashboard

> Feature 006 — User Story 5 (out-of-tooling). This runbook is the spec's
> explicit ask: an external observer for the dashboard itself.

## Why

An observer cannot observe its own death. Feature 006's health monitoring
(per-app probes, Caddy admin probe, cert sweep, Telegram dispatch) is a
process running **inside** the dashboard. If the dashboard process or its
host VPS dies, every internal probe dies with it — and no Telegram alert
will ever fire about that fact.

To detect "the watcher itself is down" you need a watcher *outside* the
dashboard's network and host. That watcher is intentionally NOT shipped
in-tree — it is operator-configured at a third-party provider so its
availability is independent of every component this codebase manages.

## Recommended providers (free tier sufficient)

| Provider | Free tier | Notes |
|---|---|---|
| **UptimeRobot** | 50 monitors, 5-min cadence | Most common choice. Telegram integration via webhook. |
| **BetterStack (Better Uptime)** | 10 monitors, 30-sec cadence | More polished UI, richer alerting routing. |
| **freshping** | 50 monitors, 1-min cadence | Simple, no-frills, stable. |

Pick one. Don't bikeshed. If you already have a status-page provider, use it.

## What to monitor

**Exactly one URL: the dashboard's public origin.**

Concretely:

- HTTP GET `https://dashboard.example.com/healthz`
  (or just `/` — any cheap 200-OK route works)
- Cadence: **1 minute** (faster is noise; slower misses short outages).
- Failure threshold: **2 consecutive failures** before alerting.
  Mirrors feature 006's debounce logic — single-tick blips happen.
- Timeout: **10 seconds**.
- Method: GET. Don't use POST/HEAD — some providers handle them oddly.
- Expected status: 2xx OR 3xx. Same policy feature 006's HTTP probe uses.

## Alert destination

Route the external monitor's alerts to the **same operations Telegram
group** that feature 006 uses. The point is that one channel sees both
"the dashboard says X is down" *and* "an outsider says the dashboard is
down" — operators correlate at a glance.

Most providers expose a generic webhook. Either:

- Point it at the existing Telegram bot's `/sendMessage` URL with the ops
  group's `chat_id`, OR
- Add a second Telegram bot dedicated to external-monitor alerts (clearer
  attribution; the cost is one extra `BOT_FATHER` registration).

## What NOT to monitor externally

Do not duplicate feature 006's probes from outside:

- **Per-app health URLs** — feature 006 covers these with debounce, mute,
  and history persistence. Adding an external probe creates two alert
  channels with different debounce semantics, guaranteed to disagree under
  load.
- **Container health** — only reachable via the host's docker socket; not
  externally observable anyway.
- **Caddy admin endpoint** (`127.0.0.1:2019`) — never exposed publicly.
  Feature 006's Caddy probe is the only correct observer.
- **Certificate expiry** — feature 006's cert sweep runs daily and writes
  `app_cert_events` for the dedup-windowed alerts (FR-015a). External
  cert-expiry monitors will fire redundantly out of phase.

## Verification

After setup:

1. Trigger a controlled dashboard outage (e.g., `docker compose stop` on
   the staging instance).
2. Wait 2 minutes.
3. Confirm the external monitor's Telegram alert arrives in the ops group.
4. Restore the dashboard and confirm the recovery message arrives.

If steps 3 or 4 don't fire, fix the external monitor's webhook before you
rely on it. A silent monitor is worse than no monitor.

## Maintenance

- Re-verify the alert path after every dashboard domain change or TLS
  rotation. The external monitor pins on hostname; CN/SAN drift will
  silently break it.
- Audit the monitor's URL annually — make sure it still points at a route
  whose 200-OK actually proves the dashboard is reachable (not, e.g., a
  static landing page served by Caddy when the Node process is dead).
