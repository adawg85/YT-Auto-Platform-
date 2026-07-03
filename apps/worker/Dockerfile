# Worker: Inngest functions + Remotion rendering (CPU-only).
FROM node:22-bookworm-slim AS base

# Remotion headless-chromium runtime deps
# https://www.remotion.dev/docs/miscellaneous/linux-dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
    libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
    libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter @ytauto/worker...

# bake Remotion's chrome-headless-shell into the image
RUN cd apps/worker && npx remotion browser ensure

ENV NODE_ENV=production
ENV WORKER_PORT=3010
EXPOSE 3010
CMD ["pnpm", "--filter", "@ytauto/worker", "start"]
