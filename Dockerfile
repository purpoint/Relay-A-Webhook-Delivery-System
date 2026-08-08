# syntax=docker/dockerfile:1

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of
# source changes — editing a route shouldn't reinstall node_modules.
COPY package*.json ./
RUN npm ci

# The Prisma client is generated from the schema, so it must exist before tsc
# runs or every import of it fails to resolve.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build


# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only — the compiler, linter and test runner have no
# business in a running container.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY prisma.config.ts ./

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# All three entrypoints share this image; docker-compose overrides the command
# for the scheduler and worker services.
CMD ["node", "dist/server.js"]
