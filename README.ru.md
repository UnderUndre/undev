# @underundre/undev

Переиспользуемые dev-скрипты, конфиги и шаблоны для Node.js/TypeScript проектов.

[English version](README.md)

## Что внутри

```
configs/                    # Шарируемые конфиги инструментов
  eslint.config.js          #   ESLint flat config (строгий TS)
  prettier.config.js        #   Prettier правила
  tsconfig.base.json        #   TypeScript strict база
  commitlint.config.js      #   Conventional Commits
  .editorconfig             #   Настройки IDE

scripts/                    # Bash-скрипты (параметризованы через env vars)
  common.sh                 #   Общие утилиты (цвета, логирование, confirm, telegram)
  deploy/
    deploy.sh               #   Zero-downtime SSH деплой
    rollback.sh             #   Откат на предыдущий деплой
    logs.sh                 #   Tail логов на проде (pm2/docker/nginx)
  db/
    backup.sh               #   Бэкап PostgreSQL с ротацией
    restore.sh              #   Восстановление PostgreSQL из дампа
  server/
    setup-vps.sh            #   Настройка свежего VPS (юзер, ssh, ufw, node, pm2)
    setup-ssl.sh            #   Let's Encrypt + автообновление
    health-check.sh         #   Проверка диска/памяти/CPU/сервисов
  docker/
    cleanup.sh              #   Очистка images, containers, volumes
  dev/
    setup.sh                #   Клон → установка → .env → миграции → билд
  monitoring/
    security-audit.sh       #   npm audit + сканирование секретов + устаревшие зависимости

templates/                  # Скопировать в свой проект
  .github/workflows/ci.yml #   GitHub Actions CI пайплайн
  .env.example              #   Шаблон переменных окружения
  docker-compose.dev.yml    #   Dev БД (Postgres + Redis)
  package-scripts.jsonc     #   Рекомендуемые npm scripts
```

## Использование: Конфиги

Установить как dev-зависимость:

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

## Использование: Скрипты

Скопировать нужные скрипты в проект:

```bash
# Скопировать скрипты деплоя
cp -r node_modules/@underundre/undev/scripts/deploy ./scripts/deploy
cp node_modules/@underundre/undev/scripts/common.sh ./scripts/

# Или по одному
cp node_modules/@underundre/undev/scripts/db/backup.sh ./scripts/
```

Все скрипты читают конфиг из переменных окружения. Задать в `.env.production` или передать инлайн:

```bash
PROD_SSH_HOST=deploy@myserver.com REMOTE_APP_DIR=/home/deploy/app ./scripts/deploy/deploy.sh
```

### Переменные окружения

| Переменная | Используется | По умолчанию |
|-----------|-------------|-------------|
| `PROD_SSH_HOST` | deploy, rollback, logs | обязательно |
| `REMOTE_APP_DIR` | deploy, rollback | обязательно |
| `POSTGRES_HOST` | db/backup, db/restore | `localhost` |
| `POSTGRES_PORT` | db/backup, db/restore | `5432` |
| `POSTGRES_USER` | db/backup, db/restore | `postgres` |
| `POSTGRES_DB` | db/backup, db/restore | обязательно |
| `BACKUP_DIR` | db/backup | `./backups` |
| `RETENTION_DAYS` | db/backup | `14` |
| `TELEGRAM_BOT_TOKEN` | все (опц. уведомления) | — |
| `TELEGRAM_CHAT_ID` | все (опц. уведомления) | — |

## Использование: Шаблоны

```bash
# CI workflow
cp node_modules/@underundre/undev/templates/.github/workflows/ci.yml .github/workflows/

# Шаблон окружения
cp node_modules/@underundre/undev/templates/.env.example .

# Dev Docker Compose
cp node_modules/@underundre/undev/templates/docker-compose.dev.yml .
```

## npm Scripts

См. `templates/package-scripts.jsonc`. Ключевые:

```json
{
  "validate": "npm run lint && npm run typecheck && npm run format:check",
  "validate:fix": "npm run lint:fix && npm run typecheck && npm run format"
}
```

## Лицензия

MIT
