# Inbound request: project-local deploy scripts + migration awareness

**Requested by**: ai-digital-twins feature 133-prod-migration-workflow (2026-04-22)
**Source handoff**: `ai-digital-twins/specs/133-prod-migration-workflow/undev-handoff.md`
**Status**: Incoming — not yet specced / planned in this repo

## Background

On 2026-04-22 the ai-digital-twins production app crashed (`column "knowledge_mode" does not exist`) because the current deploy pipeline through devops-app (this repo's app) runs `git pull + docker compose up` with no database synchronization step. The project historically used its own `scripts/server-deploy-prod.sh` with built-in `drizzle-kit push`, but after switching to devops-app for operational convenience this step was silently dropped.

Root cause is **not** specific to ai-digital-twins: it is the generic gap between a one-size-fits-all deploy orchestrator (this repo) and the project-specific pre/post steps that each consumer needs (migrations, cache warmup, asset sync, etc.).

## Requested capabilities

See the source handoff for full detail. Items in priority order:

| ID  | Title                                                                              | Priority for ai-digital-twins                  |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| U-1 | Project-local deploy script dispatch (`scripts/devops-deploy.sh`) from manifest    | **Blocker for Phase B**                        |
| U-3 | Failure-state UI banner (alongside existing Telegram notifications)                | Nice-to-have for Phase A; required for Phase E |
| U-4 | Generic pre-flight "wrong compose file" detector in `scripts/deploy/pre-flight.sh` | Enhancement                                    |
| U-2 | Dry-run preview before apply                                                       | Enhancement                                    |
| U-5 | Migrations dashboard tab                                                           | Post-Phase E, optional                         |

## Non-asks

- This request does **not** ask undev to learn about Drizzle, Prisma, or any specific ORM. The project-local script (U-1) owns the ORM knowledge; undev just dispatches the script.
- This request does **not** replace the generic `server-deploy.sh` path — projects that don't set `scriptPath` continue to use generic behavior.

## Suggested next step

1. Triage: decide if U-1 is accepted as the minimum-viable slice and the rest get separate specs.
2. If accepted, spec U-1 as feature 007 in this repo with standard flow (`/speckit.specify → .plan → .tasks → .implement`).
3. Coordinate timing: ai-digital-twins Phase A can ship without this (startup-migration fallback); Phase B is blocked on U-1.

## Full handoff document

For the complete rationale and per-item design sketches, see the source handoff file in the requesting repo:

`ai-digital-twins/specs/133-prod-migration-workflow/undev-handoff.md`
