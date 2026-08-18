# syntax=docker/dockerfile:1

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests before source, so the dependency layers are cached independently of
# code changes — editing a route shouldn't reinstall node_modules. The server
# and the frontend have separate manifests and so get separate layers: touching
# a React component must not invalidate the server's dependencies.
COPY package*.json ./
RUN npm ci

COPY web/package*.json ./web/
RUN cd web && npm ci

# The Prisma client is generated from the schema, so it must exist before tsc
# runs or every import of it fails to resolve.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
COPY web ./web

# Built as two explicit steps rather than via `npm run build`, whose build:web
# script runs `npm install` — redundant here, since the layer above already
# installed from the lockfile with `npm ci`.
RUN cd web && npm run build
RUN npm run build:server


# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only — the compiler, linter and test runner have no
# business in a running container.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The built monitor page. Fastify serves it from the same origin as the API,
# which is what allows the refresh cookie to use SameSite=Strict.
COPY --from=builder /app/public ./public

COPY --from=builder /app/prisma ./prisma
COPY prisma.config.ts ./

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# One entrypoint for all three tiers; RELAY_ROLE selects which run. Defaults to
# "all", so the image is usable as a single container without extra wiring —
# docker-compose overrides the role to split them.
CMD ["node", "dist/main.js"]
