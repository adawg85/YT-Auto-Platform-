# Cockpit: Next.js UI + BFF.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

# Next 15 bakes the Server Actions encryption key into the client bundle at
# BUILD time and reads it again at runtime. Pin it (same value both places) so
# action IDs stay stable across rebuilds — otherwise every `up -d --build`
# regenerates the key and already-open tabs get "Server Action not found".
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

# ── dependency layer ────────────────────────────────────────────────────
# MANIFESTS ONLY, before any source (2026-08-05). Copying packages/ and
# apps/cockpit/ wholesale invalidated `pnpm install` on every commit, because
# any .ts/.tsx edit changed the layer it sat on. With only manifests here the
# install layer survives until a package.json or the lockfile changes, and only
# the Next build below re-runs.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/agents/package.json ./packages/agents/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/providers/package.json ./packages/providers/
COPY packages/video/package.json ./packages/video/
COPY apps/cockpit/package.json ./apps/cockpit/
RUN pnpm install --frozen-lockfile --filter @ytauto/cockpit...

# ── source + build layer ────────────────────────────────────────────────
COPY packages ./packages
COPY apps/cockpit ./apps/cockpit
RUN pnpm --filter @ytauto/cockpit build

FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@ytauto/cockpit", "start"]
