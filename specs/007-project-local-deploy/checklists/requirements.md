# Specification Quality Checklist: Project-Local Deploy Script Dispatch

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-04-23
**Last Updated**: 2026-04-25 (after clarify pass + GPT review pass + Gemini review pass)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

> Note: Spec references `applications.scriptPath`, the `deploy/project-local-deploy` manifest entry, and the `shQuote` helper because they are contractual carriers inherited from features 001 / 004 / 005. Stack-level decisions (UI component, form validator lib, REST endpoint layer) stay for `/speckit.plan`. This matches the convention used in the feature-006 spec.

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (replace builtin, preserve fallback, surface identity, reject unsafe paths, mid-stream switchover)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Spec intentionally constrains v1 to **deploy only** — rollback, first-deploy bootstrap, non-bash scripts, and secret passthrough are explicit Out-of-Scope items. This keeps the surface small enough to ship in one pass and defers compound concerns to follow-up specs.
- U-2 (dry-run), U-3 (failure-state UI banner), U-4 (pre-flight compose detector), and U-5 (migrations tab) from the source handoff are carved out. Each gets its own spec when prioritised — the handoff anticipated this triage.
- **Clarify pass (Session 2026-04-24)** — 5 additional decisions recorded in the spec's `## Clarifications` section. All integrated into FRs / Edge Cases / Key Entities / Out of Scope:
  1. **Rollback UX**: confirmation dialog on Rollback when `scriptPath` is set (FR-024).
  2. **`dangerLevel`**: `"low"` — parity with builtin deploy, no extra friction (FR-011 + Key Entities manifest snippet).
  3. **NULL normalisation**: server trims + converts `""` → NULL before persistence; DB CHECK constraint enforces (FR-001, FR-003, Key Entities).
  4. **Runtime re-validation**: runner re-validates `scriptPath` at every dispatch using FR-003 rules; fails closed, no silent fallback (FR-044, SC-007).
  5. **Scan integration**: scan leaves `scriptPath` NULL for all scan-created rows; no heuristic probing (FR-025, Dependencies, Out of Scope).
- Assumed answers for items that could have been [NEEDS CLARIFICATION] — verify during `/speckit.plan`:
  - Script transport: **target-resident**, invoked via `bash <appDir>/<scriptPath>` over SSH remote-exec.
  - CLI contract: **same flags as the builtin `server-deploy.sh`**.
  - Rollback: **unchanged dispatch + new confirmation dialog** for apps with `scriptPath`.
  - First-deploy bootstrap: **manual**. Dashboard does not auto-clone when `scriptPath` is set.
  - Pre-flight existence check for the script file: **none in v1** — rely on exit 127.
  - Secret parameters: **not extended** — project scripts read secrets from target-side `.env` or their own stores.
- Security validation (FR-003, FR-040, FR-044, SC-006, SC-007) now defines a three-layer defence in testable terms: form validator → API endpoint → runtime runner. Plus DB-layer CHECK constraint for the empty-string invariant. Matches the defence-in-depth pattern of feature 005 FR-011 (`shQuote` + Zod).
- Feature 004's deploy-lock semantics remain the single source of mutual exclusion; no new lock partitioning, no new lock table, no new conflict code.
- Retention / log-file ownership is unchanged: project-local `script_runs` rows follow the same feature 005 FR-042 pruning policy.
- **GPT review pass (Session 2026-04-24)** — 4 additional findings resolved, integrated into spec FR-003 / FR-044 / SC-007 / A-006 and tasks v1.1. All recorded in the spec's `## Clarifications > Session 2026-04-24 (GPT review pass)` subheading:
  1. **Runtime-validation forensics trail**: feature 005's runner throws ZodError before `script_runs` insert, which would have silently violated SC-007. Fixed via pre-insert wrapper `project-local-deploy-runner.ts` (new T014/T015); runner extended with `reuseRunId` option so wrapper-allocated row is updated rather than re-inserted (T013).
  2. **Strict typing**: API route schema is now `z.union([z.string(), z.null()]).optional()` — no coercion. Non-string inputs (`123`, `false`, `{}`, `[]`) return 400 INVALID_PARAMS (T016/T017, tests in T018).
  3. **ASCII-only path policy**: rejects non-printable-ASCII paths, eliminating the bytes-vs-chars trap entirely. `string.length` now equals byte count by construction (FR-003, T003/T004).
  4. **Backslash and `./` policy**: `\` explicitly rejected (Windows-style paths on Linux targets); `./` explicitly allowed (bash handles redundancy). Documented in FR-003 (T003/T004).
  5. **ApplicationDetail visibility**: missing UI surface per FR-002 added — T023 mounts scriptPath display in the detail view.
  6. **Rollback integration test**: promised in plan.md but missing task in v1.0 — added as T026.
  7. **Typed `as any` cleanup**: `renderScriptIdentity` helper uses typed guard (`in` narrowing) instead of unchecked coercion (T030).
  8. **Telegram ownership**: A-006 rewritten — dashboard notifier fires independently of project script; operators receive 1+N messages; quickstart clarified.
- New task count: **35** (T027 intentionally skipped for phase-range preservation). Critical path: **10 tasks** (adds the pre-insert wrapper T014).
- **Gemini review pass (Session 2026-04-25)** — 3 additional findings applied, 3 accepted-as-designed. Recorded in spec's `## Clarifications > Session 2026-04-25 (Gemini review pass)`:
  1. **Zombie-pending-rows fix (P0-1)**: the GPT-pass wrapper only caught `ZodError`, leaving `DeploymentLockedError` / DB errors / network failures / OOM able to orphan rows in `status: pending` forever. Fixed: wrapper now catches ANY exception with a **conditional UPDATE** (`WHERE id=:runId AND status='pending'`). Conditional clause prevents overwriting the runner's own terminal-status write in the race where runner transitions `pending → running` before throwing. Feature 005's startup reaper (`reapZombieScriptRuns`, commit `07386c9`) remains as backstop. FR-044 lifecycle + SC-007 extended; T014 + T015 (4 new test scenarios: DeploymentLocked, DB error, SSH error, runner-owned-terminal race).
  2. **Shebang-ignored UX gap (P1-2)**: operators pasting `scripts/deploy.py` got unexplained "syntax error" spam because `bash <path>` ignores shebangs. Fixed: ScriptPathField helper text (T020) + quickstart Common-pitfalls section now explain the limitation AND give a one-line bash-wrapper example for non-bash entrypoints.
  3. **Non-interactive env vars (P1-3)**: a hung script (missing `-y` on apt, missing `--accept-data-loss` on prisma) burns the full 30-minute timeout. Fixed: `buildProjectLocalCommand` now prepends `NON_INTERACTIVE=1 DEBIAN_FRONTEND=noninteractive CI=true` to every dispatch. FR-013 updated; T011 + T012 (regression assertion on env prefix).
  4. **Globbing chars (`*`, `?`, `[`, `]`) (P2)**: NOT added to blacklist. `shQuote` neutralises them; no security risk; the cases where they'd appear in a legitimate path are vanishingly rare; expanding blacklist without material benefit violates KISS.
  5. **Silent whitespace normalisation (P2)**: accepted as designed. `"   "` → NULL is spec'd behaviour; audit middleware captures the field change so operators can review in audit log.
  6. **False-positive rollback dialog on never-deployed apps (P2)**: accepted as designed. Computing "was the last successful deploy via scriptPath?" requires cross-referencing `script_runs`; too much scope for v1. The over-warning is safer than under-warning.
  7. **Interactive-script timeout (P2)**: 30-min timeout is inherited safety; the new env-var prefix (finding #3) closes the most common cause of hangs.
- **Critical-path unchanged**: all v1.2 edits are within existing tasks (T011/T012/T014/T015/T020). No new tasks, no dependency-graph changes.
