# Quickstart: DevOps Dashboard

## Prerequisites

- Docker + Docker Compose
- SSH key that can access your target servers

## Start the Dashboard

```bash
# Clone
git clone https://github.com/UnderUndre/undev.git
cd undev/devops-app

# Configure
cp .env.example .env
# Edit .env: set ADMIN_USER, ADMIN_PASSWORD_HASH

# Generate password hash:
node -e "import('bcrypt').then(b => b.hash('your-password', 10).then(console.log))"

# Start
docker compose up -d

# Open
open http://localhost:3000
```

## Add a Server

1. Log in with admin credentials
2. Go to **Servers** → **Add Server**
3. Enter: label, host, SSH user, port
4. Click **Verify** — dashboard checks SSH connectivity
5. Server appears on the dashboard with health status

## Deploy an Application

1. Go to **Servers** → select your server → **Applications** → **Add App**
2. Enter: name, git repo URL, branch, remote path, deploy script path
3. Click **Deploy**
4. Watch real-time logs in the browser
5. On success: green badge, new commit shown

## Backup Database

1. Go to **Servers** → select server → **Backups**
2. Click **Create Backup**
3. Select database name
4. Watch progress in real-time
5. Backup appears in list with size and date

## Monitor Health

Server health auto-refreshes every 60 seconds on the server page. Metrics: CPU, memory, disk, swap, Docker containers, services (nginx, pm2).

## View Logs

1. Go to any **Application** → **Logs**
2. Select source: pm2, docker, nginx-access, nginx-error
3. Logs stream in real-time
4. Use search bar to filter
5. Click pause to freeze the stream

## Docker Compose Reference

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: dashboard
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: dashboard
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dashboard"]
      interval: 5s
      timeout: 5s
      retries: 5

  dashboard:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./data/logs:/app/data/logs
      - ~/.ssh:/app/.ssh:ro
    environment:
      - DATABASE_URL=postgresql://dashboard:${POSTGRES_PASSWORD}@db:5432/dashboard
      - ADMIN_USER=admin
      - ADMIN_PASSWORD_HASH=$2b$10$...
      - TELEGRAM_BOT_TOKEN=       # optional
      - TELEGRAM_CHAT_ID=         # optional
    restart: unless-stopped

volumes:
  pgdata:
```
