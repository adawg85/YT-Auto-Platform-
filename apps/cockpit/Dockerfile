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

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/cockpit ./apps/cockpit
RUN pnpm install --frozen-lockfile --filter @ytauto/cockpit...
RUN pnpm --filter @ytauto/cockpit build

FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@ytauto/cockpit", "start"]
