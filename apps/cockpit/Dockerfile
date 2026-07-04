# Cockpit: Next.js UI + BFF.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

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
