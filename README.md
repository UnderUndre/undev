# @underundre/undev

Reusable dev scripts, configs, and templates for Node.js/TypeScript projects.

[Русская версия](README.ru.md)

## DevOps Dashboard — quickstart on a fresh VPS

The repo also ships a self-hosted DevOps dashboard (`devops-app/`) that
manages git-backed Docker apps, deploys them, watches health, and provisions
TLS via [`caddy-docker-proxy`](https://github.com/lucaslorentz/caddy-docker-proxy).
Bootstrap is a one-shot — once the dashboard is up, **all subsequent deploys
(of any app, including the dashboard itself) go through the UI**.

### 1. Bootstrap

On a fresh Ubuntu/Debian VPS as root:

```bash
# Base setup — Docker, deploy user, firewall, swap.
curl -sL https://raw.githubusercontent.com/UnderUndre/undev/main/scripts/server/setup-vps.sh | bash -s -- deploy

# Switch to the deploy user, then:
git clone https://github.com/UnderUndre/undev.git
cd undev
./bootstrap.sh
```

`bootstrap.sh` is idempotent:
- generates `.env` with random secrets if missing
- installs `caddy-docker-proxy` (creates the shared `ai-twins-network`)
- runs `docker compose up -d` for the dashboard

After it finishes you'll see the dashboard URL — `http://<vps-ip>:3000`.
Reach it directly via the public IP or an SSH tunnel.

### 2. First admin + global settings

1. Open the dashboard URL.
2. Create the first admin account (the page is unauthenticated until
   the first account exists — restrict via firewall if needed).
3. **Settings → TLS** — set the ACME email Let's Encrypt should use.
4. **Settings → Proxy** — set Caddy edge network (`ai-twins-network` if
   you used `bootstrap.sh`). All apps' domains will be exposed via this
   shared network.

### 3. Promote dashboard itself to TLS

The dashboard isn't yet on its own domain — it's still on `:3000` over
the IP. To put it behind a hostname:

1. **Add the dashboard's own server** in the UI (`Servers → Add`) pointing
   at `127.0.0.1` (or the VPS public IP) with the SSH key for the deploy user.
2. **Add an app row** for the dashboard:
   - `repo_url` = `https://github.com/UnderUndre/undev.git`
   - `branch` = `main`
   - `remote_path` = `/home/<deploy_user>/undev/devops-app`
   - `domain` = `dashboard.example.com` (DNS A → VPS IP must be live)
   - `upstream service` = `dashboard` (compose service name)
   - `upstream port` = `3000`
3. Click **Promote to TLS** on the app detail page.
   - Dashboard writes `docker-compose.dashboard.yml` next to the project.
   - Container is recreated with `caddy:` + `caddy.reverse_proxy:` labels.
   - `caddy-docker-proxy` picks them up over the Docker socket and
     requests a Let's Encrypt cert (~10s).
4. The dashboard is now reachable at `https://dashboard.example.com` —
   the `:3000` direct path can be firewalled off.

### 4. Onboard other apps

For every subsequent app (e.g. a sidecar, an internal API, anything with
its own `docker-compose.yml`):

- **Apps → Add** with repo URL, branch, remote path
- Set **domain** + **upstream service** + **upstream port** in the form
- Click **Deploy** — full `git pull` + `docker compose build` + recreate.
  The override file is auto-written before the build runs.
- TLS appears within ~10s of the new container coming up.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_SSL_PROTOCOL_ERROR` after deploy | Caddy didn't see new labels | Click **Promote to TLS** in UI to force-rewrite override + recreate |
| 502 from Caddy | Backend is restarting / failing health check | Check `docker logs <container>` |
| `pending_reconcile` cert status | Stale state from old admin-API reconciler | Cosmetic only — actual TLS is managed by labels-pull now |

## What's Inside

```
configs/                    # Shareable tool configs
  eslint.config.js          #   ESLint flat config (TS strict)
  prettier.config.js        #   Prettier rules
  tsconfig.base.json        #   TypeScript strict base
  commitlint.config.js      #   Conventional Commits
  .editorconfig             #   IDE settings

scripts/                    # Bash scripts (parameterized via env vars)
  common.sh                 #   Shared utils (colors, logging, confirm, telegram)
  deploy/
    deploy.sh               #   Zero-downtime SSH deploy
    rollback.sh             #   Rollback to previous deploy
    logs.sh                 #   Tail prod logs (pm2/docker/nginx)
  db/
    backup.sh               #   PostgreSQL backup with retention
    restore.sh              #   PostgreSQL restore from dump
  server/
    setup-vps.sh            #   Fresh VPS bootstrap (user, ssh, ufw, node, pm2)
    setup-ssl.sh            #   Let's Encrypt + auto-renewal
    health-check.sh         #   Disk/memory/CPU/services check
  docker/
    cleanup.sh              #   Prune images, containers, volumes
  dev/
    setup.sh                #   Clone → install → .env → migrate → build
  monitoring/
    security-audit.sh       #   npm audit + secret scan + outdated deps

templates/                  # Copy into your project
  .github/workflows/ci.yml #   GitHub Actions CI pipeline
  .env.example              #   Environment variables template
  docker-compose.dev.yml    #   Dev DB (Postgres + Redis)
  package-scripts.jsonc     #   Recommended npm scripts reference
```

## Usage: Configs

Install as dev dependency:

```bash
npm i -D @underundre/undev
```

### ESLint

```js
// eslint.config.js
import baseConfig from "@underundre/undev/eslint";
export default [...baseConfig];
```

### TypeScript

```json
// tsconfig.json
{
  "extends": "@underundre/undev/tsconfig",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

### Prettier

```json
// package.json
{ "prettier": "@underundre/undev/prettier" }
```

### Commitlint

```js
// commitlint.config.js
export default { extends: ["@underundre/undev/commitlint"] };
```

## Usage: Scripts

Copy the scripts you need into your project:

```bash
# Copy deploy scripts
cp -r node_modules/@underundre/undev/scripts/deploy ./scripts/deploy
cp node_modules/@underundre/undev/scripts/common.sh ./scripts/

# Or cherry-pick
cp node_modules/@underundre/undev/scripts/db/backup.sh ./scripts/
```

All scripts read config from environment variables. Set them in `.env.production` or pass inline:

```bash
PROD_SSH_HOST=deploy@myserver.com REMOTE_APP_DIR=/home/deploy/app ./scripts/deploy/deploy.sh
```

### Script Config Reference

| Variable | Used by | Default |
|----------|---------|---------|
| `PROD_SSH_HOST` | deploy, rollback, logs | required |
| `REMOTE_APP_DIR` | deploy, rollback | required |
| `POSTGRES_HOST` | db/backup, db/restore | `localhost` |
| `POSTGRES_PORT` | db/backup, db/restore | `5432` |
| `POSTGRES_USER` | db/backup, db/restore | `postgres` |
| `POSTGRES_DB` | db/backup, db/restore | required |
| `BACKUP_DIR` | db/backup | `./backups` |
| `RETENTION_DAYS` | db/backup | `14` |
| `TELEGRAM_BOT_TOKEN` | all (optional notifications) | — |
| `TELEGRAM_CHAT_ID` | all (optional notifications) | — |

## Usage: Templates

```bash
# CI workflow
cp node_modules/@underundre/undev/templates/.github/workflows/ci.yml .github/workflows/

# Environment template
cp node_modules/@underundre/undev/templates/.env.example .

# Dev Docker Compose
cp node_modules/@underundre/undev/templates/docker-compose.dev.yml .
```

## npm Scripts Reference

See `templates/package-scripts.jsonc` for a complete set of recommended scripts. Key ones:

```json
{
  "validate": "npm run lint && npm run typecheck && npm run format:check",
  "validate:fix": "npm run lint:fix && npm run typecheck && npm run format"
}
```

## License

MIT
