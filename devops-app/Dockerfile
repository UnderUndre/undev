# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY devops-app/package.json devops-app/package-lock.json ./
RUN npm ci --ignore-scripts

# Stage 2: Build client (Vite) + server (tsc)
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY devops-app/ .
RUN npm run build

# Stage 3: Production
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/db/migrations ./server/db/migrations
COPY devops-app/package.json ./

# Bundle repo-root scripts/ — consumed by scripts-runner at runtime (feature 005)
COPY scripts ./scripts

RUN mkdir -p /app/data/logs

EXPOSE 3000
CMD ["node", "dist/server/index.js"]
