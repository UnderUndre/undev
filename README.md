# @underundre/undev

Reusable dev scripts, configs, and templates for Node.js/TypeScript projects.

[Русская версия](README.ru.md)

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
