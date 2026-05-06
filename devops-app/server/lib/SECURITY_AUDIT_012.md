# Security Audit — Feature 012 Blue/Green Deploy

Mirrors the `SECURITY_AUDIT_011.md` pattern.

## Scope

- `server/services/caddy-upstream-switcher.ts` (T024)
- `server/lib/compose-override-generator.ts` (T009)
- `server/services/slot-namer.ts` (T026)
- `server/services/blue-green-orchestrator.ts` (T028)
- `server/services/drain-timer.ts` (T025)
- `server/routes/blue-green.ts` (T045 + T045a)

## T059 — Caddy admin + override file lifecycle

### Findings

1. **Caddy admin token never logged in cleartext.** `caddy-upstream-switcher.ts`
   delegates to `caddy-admin-client.ts` (feature 008) which routes through
   an SSH tunnel to `127.0.0.1:2019` — no token traverses the wire from
   our process. `getConfig` errors are logged with `{ ctx, serverId, err }`
   but the err object surfaces transport-level failure, not body content.
   `POST /load` body is the full Caddy config — does not include a
   secret token in our deployment model.

2. **Override file path namespace.** `compose-override-generator.ts` writes
   only under `<appDir>/.dashboard/docker-compose.bg-override.yml`. The
   `.dashboard/` dir is the gitignored convention reused from feature 008.
   `appDir` is `applications.remote_path` — operator-supplied at app
   creation, validated by `validate-script-path.ts` for shell-injection
   characters. Path is `shQuote`-escaped before SSH send.

3. **Override file always deleted.** Orchestrator's `runHappyPath` calls
   `deleteOverride` after OUTGOING_STOPPED + on every `handleFailure`
   path. Routes `interrupted/abort-cleanup`, `interrupted/mark-complete`,
   and `abort` also call `deleteOverride` (best-effort, swallow errors).
   Coverage gap: dashboard hard-crash mid-deploy may leave the override
   on disk; operator's `interrupted/*` flows clean it up on next action.

4. **`docker rename` injection guard.** `slot-namer.ts` only renames
   containers whose existing name is discovered via
   `docker compose ps -q <service>` then `docker inspect --format
   '{{.Name}}'`. Both operands are `shQuote`-escaped. The target name
   is built from `applications.upstream_service` (operator config field
   already validated for injection) + a hardcoded color literal. Cannot
   be tricked into renaming an arbitrary container.

5. **`docker stop` + `docker rm -f` operands.** Outgoing-stop in
   orchestrator uses `resolveContainerName(serviceName, color)` —
   serviceName is `upstream_service` from the validated app row. Always
   `shQuote`-escaped. Same guard for `routes/blue-green.ts` candidate
   removal in `abort` and `interrupted/abort-cleanup`.

### Verdict

PASS with one operational footnote: dashboard hard-crash with no operator
follow-up leaves the override file in `.dashboard/`. Mitigation already
in place: every operator-driven recovery action calls `deleteOverride`.

## T060 — Drain timer memory leak audit

### Findings

1. **Map entries cleared on completion.** `start()` registers an entry,
   `setTimeout` callback deletes the entry from the Map AFTER firing
   `onComplete`. Test `drain-timer.test.ts > no leak after 1000 sequential
   start+complete cycles` asserts `Map.size === 0` after 1000 round trips.

2. **`unref()` on every timer.** Both `start()` and `resume()` call
   `handle.unref()` so dashboard graceful shutdown is not blocked by
   pending drain timers. Process can exit cleanly.

3. **Replace-on-collision.** `start()` calls `cancel()` first to prevent
   accumulating multiple timers per app — even if a buggy caller fires
   `start` twice without intervening `cancel`, no timer leaks.

4. **Cancel paths covered.**
   - Happy path: `setTimeout` callback deletes entry.
   - `pause`: deletes entry, returns remainingMs.
   - `cancel`: clearsTimeout + deletes entry.
   - `resume`: calls `cancel()` first to replace any prior entry.
   - Routes `abort` and `interrupted/abort-cleanup` call `drainTimer.cancel()`.
   - Routes `recover-caddy/retry-healthcheck` and `mark-recovered` call
     `start()` which inherently replaces.

### Verdict

PASS. The test suite enforces leak invariant; all known cleanup paths
account for the entry. No memory leak vector identified.

## Cross-cutting

- All Zod-validated route bodies use `.strict()` — unknown keys rejected.
- `confirmAppName` typed-confirm enforced server-side for every
  destructive action (abort, mark-recovered, interrupted/*-cleanup,
  interrupted/mark-complete).
- Audit emit happens inside the same DB transaction as the state update
  (orchestrator `transitionTo`); routes audit on best-effort post-action
  but the operator action itself succeeds atomically.
- No new secrets material introduced. No env-var reads added.
