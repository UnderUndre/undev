# Ops Verification: Feature 005

**Date**: 2026-04-22 | **Verifier**: devops-engineer (pending release-time run)

## Commands

From `devops-app/`:

```sh
docker compose build
docker run --rm devops-app-dashboard ls /app/scripts/common.sh /app/scripts/deploy /app/scripts/db
```

## Expected outcomes

- `docker compose build` succeeds using `context: ..` + `dockerfile: devops-app/Dockerfile`.
- `/app/scripts/common.sh` present inside the image.
- `/app/scripts/deploy/` contains `deploy.sh`, `deploy-docker.sh`, `rollback.sh`, `env-setup.sh`, `logs.sh`.
- `/app/scripts/db/` contains `backup.sh`, `restore.sh`, `pre-migration-005-audit.sh`.

## Size & build-time delta (SC-007 target)

| Metric | Pre-005 | Post-005 | Delta | Target |
|---|---|---|---|---|
| Image compressed size | _TBD at release_ | _TBD_ | _TBD_ | ≤ +200 KB |
| `docker compose build` wall time | _TBD_ | _TBD_ | _TBD_ | ≤ +3 s |

Admin fills in once the release candidate builds in CI/local.
