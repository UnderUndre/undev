Viewed api.md:1-319
Viewed failure-card.md:1-314
Viewed data-model.md:1-269
Viewed plan.md:1-407
Viewed quickstart.md:1-271
Viewed research.md:1-413
Viewed spec.md:1-567
Viewed tasks.md:1-363

```markdown
## 🧠 Brainstorm: Operational Maturity (Spec 010) Review

### Context
Reviewing 6 operational user stories (Bootstrap mount, Lifecycle hooks, FailureCard, Cross-server domain, Audit UI, Migration toolkit). 
The architecture is mostly wiring existing features, but there are some gaping holes in the pipes. Let's stress-test the logic before we write code.

---

### 🚨 1. The US6 Path Jail Vulnerability (Critical)
**Issue**: US6 (Migration Toolkit) runs `test -d` on `remotePath`. Unlike feature 009 (Bootstrap), there is no explicit mention of a `realpath` jail check against a safe root (e.g., `/opt/apps`). 
**Consequence**: An operator can adopt `/etc` or `/var/log` as a managed app. If they later hit "Hard Delete", feature 008's `rm -rf` runs on `/etc`. The host is bricked. 
**Idea/Fix**: Port the `realpath` jail validation from feature 009's bootstrap to `migration-toolkit.ts` BEFORE accepting the path. Never trust operator input for root paths.

---

### 🚨 2. The Bricked Hard-Delete (US2)
**Issue**: `pre_destroy` failure ABORTS the hard-delete. 
**Consequence**: If an operator sets `pre_destroy_script_path = "cleanup.sh"`, but the file is accidentally deleted from the server (or has a syntax error), `hardDeleteWithHooks` throws an error. The app is now undeletable. Catch-22.
**Idea/Fix**: 
- **Option A**: If `exitCode === 127` (file not found), skip the hook and proceed with deletion.
- **Option B**: Add a `ForceDelete` variant to `FailureCard` that explicitly passes a `?force=true` flag to the API to bypass hooks if they fail.

---

### 🚨 3. The Blind `on_fail` Hook (US2)
**Issue**: `on_fail` executes if deploy or compose fails. But it receives the same generic env vars (`APP_DIR`, `SECRET_*`).
**Consequence**: The hook script has no idea *what* failed. Was it `git fetch`? Was it `pre_deploy`? Did `docker-compose` crash? An alert webhook script will just send "App failed" with zero context, making it useless for debugging.
**Idea/Fix**: Inject `FAIL_PHASE` (e.g., `pre_deploy`, `compose_up`) and `FAIL_EXIT_CODE` into the environment builder for the `on_fail` hook inside `scripts-runner.ts`.

---

### 🚨 4. CSV Export Zombie Queries (US5)
**Issue**: `GET /api/audit/export.csv` streams up to 10,000 rows in batches of 500 using `res.write()`.
**Consequence**: If the user closes the browser tab mid-download, the Express request drops, but the `while(written < 10000)` loop keeps hitting the database until it finishes. Memory leak / DB connection hog.
**Idea/Fix**: Add an abort listener inside the loop to release DB connections early:
```ts
req.on('close', () => { aborted = true; });
// inside loop: if (aborted) break;
```

---

### 🚨 5. Conflict Race Audit Noise (US4)

**Issue**: The spec says "server re-checks conflicts at write time... Audit `app.cross_server_domain_confirmed` emitted".
**Consequence**: If the conflict resolves *between* dialog open and submit (e.g., the other app is deleted), the write-time check finds 0 conflicts. If the backend blindly logs `cross_server_domain_confirmed` just because the frontend sent `typedConfirmation`, you get false-positive audits.
**Idea/Fix**: Ensure the service layer only emits `app.cross_server_domain_confirmed` if the write-time check *actually* finds >0 conflicts. If 0 conflicts, ignore the `typedConfirmation` and emit a standard `app.domain_changed`.

---

### 🚨 6. Atomic Hook Swapping (US2)

**Issue**: The DB constraint `script_path IS NULL OR (all hooks IS NULL)` prevents overlapping values.
**Consequence**: If a user currently uses `script_path` and wants to switch to hooks, the UI must send `script_path: null` and `pre_deploy: "..."` in the *same* PATCH request. If the UI makes them clear `script_path`, save, and then add hooks, it's terrible UX.
**Idea/Fix**: Ensure the Edit Application form allows clearing `script_path` and populating hooks in one atomic submission.

---

## 💡 Recommendation

The spec is solid on UX, but leaks on defensive systems programming.

**My recommendation:**

1. Fix the **US6 path jail** — this is non-negotiable security.
2. Add the **ForceDelete bypass** or exit 127 handler — you never want an entity that cannot be deleted.
3. Enhance **`on_fail` context** — ops tools are useless without context.
4. Patch the **CSV stream leak**.

Что думаешь? Хочешь чтобы я обновил спеку и план (добавив эти фиксы), или идем сразу в имплементацию, держа эти эдж-кейсы в голове?
