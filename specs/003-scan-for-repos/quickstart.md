# Quickstart: Scan Server for Existing Repositories and Docker Apps

**Phase 1 output** | **Date**: 2026-04-20

This feature is backend + UI; no new infrastructure to provision.

---

## Preconditions

- DevOps Dashboard from `001-devops-app` is deployed and reachable.
- At least one server is registered and its SSH status is **online** (green dot in the UI).
- SSH user on the server has **read** access to the default scan roots (`/opt`, `/srv`, `/var/www`, `/home`). Root is not required.
- `git` is installed on the server. `docker` is optional — the scan works without it, Docker section comes back empty.

---

## One-time setup

1. Pull the branch `003-scan-for-repos` and run the migration:
   ```bash
   npm --prefix devops-app run db:migrate
   ```
   This adds:
   - `servers.scan_roots` (jsonb, defaulted)
   - `applications.skip_initial_clone` (boolean, defaulted to false for existing rows)
2. Restart the server process.

No environment variables, no new secrets, no new containers.

---

## Happy path (2 minutes)

1. Open the dashboard, navigate to a server's **Apps** tab.
2. Click **Scan Server**. A modal appears with a spinner.
3. Within ~10 seconds, two lists render:
   - **Git repositories** — each row shows path, branch, short SHA, and a **Dirty** badge if applicable.
   - **Docker apps** — compose stacks and standalone containers with image tags.
4. Click **Import** on the candidate you want.
5. The existing **Add Application** form opens with fields pre-filled. The deploy script field has a suggestion dropdown if the scanner found any `deploy*.sh` in the directory.
6. Review, fill in the deploy script (or pick from the suggestions), click **Save**.
7. The app appears in the Apps list. First deploy will use `git fetch` + `reset --hard` instead of `git clone` — no files are moved or re-cloned.

---

## Verifying the no-clone guarantee

After saving a scan-imported git app:

1. On the server: `touch /opt/your-app/SCAN_IMPORT_SENTINEL`
2. Trigger a deploy from the dashboard.
3. Expected: `SCAN_IMPORT_SENTINEL` is still there after deploy (unless the scanner marked the tree dirty — see below). The deploy log shows `git fetch origin <branch>` followed by `git reset --hard FETCH_HEAD`, never `git clone`.

**Note on dirty trees**: `reset --hard FETCH_HEAD` wipes local uncommitted changes in tracked files. Untracked files (like `SCAN_IMPORT_SENTINEL`) survive. If the working tree had tracked-file modifications, those will be overwritten — the scan UI warns about this via the **Dirty** badge on the candidate.

If `git clone` appears in the log, the `skip_initial_clone` flag did not propagate — check the migration applied and the apps route accepted `source: "scan"`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Scan modal shows `SSH_UNREACHABLE` | Server status flipped to offline during scan, or SSH creds stale | Check server status; re-enter credentials if needed |
| Scan returns `partial: true` with few candidates | 60 s timeout hit on a deep tree | Narrow `scanRoots` for that server (Edit server → Scan Roots), re-run |
| Docker section empty but you have containers | SSH user lacks docker group | Add user to `docker` group on server: `sudo usermod -aG docker <user>` |
| Git candidate found but `remoteUrl` is null | Repo has no `origin` remote set | Either add origin manually on server or skip this candidate |
| Deploy fails with "working tree has uncommitted changes" | Candidate was dirty and you imported anyway | Clean the tree on server (`git stash` / `git reset`) or accept the `reset --hard` which will wipe changes |

---

## Re-running

Scans are idempotent and cheap. Run as often as needed — previously imported candidates are marked **Already added** and disabled automatically.
