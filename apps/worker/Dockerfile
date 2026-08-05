# Worker: Inngest functions + Remotion rendering (CPU-only).
FROM node:22-bookworm-slim AS base

# Remotion headless-chromium runtime deps + fonts (slim ships none — captions
# need at least one real font family)
# https://www.remotion.dev/docs/miscellaneous/linux-dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
    libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
    libpango-1.0-0 libcairo2 libcups2 libx11-6 libx11-xcb1 libxcb1 \
    libxshmfence1 fontconfig fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# ── dependency layer ────────────────────────────────────────────────────
# MANIFESTS ONLY, before any source. Copying packages/ and apps/worker/
# wholesale (as this did until 2026-08-05) invalidated `pnpm install` AND the
# chromium download on every commit, because any .ts edit changed the layer
# they sat on. With only manifests here the install layer survives until a
# package.json or the lockfile actually changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/agents/package.json ./packages/agents/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/providers/package.json ./packages/providers/
COPY packages/video/package.json ./packages/video/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile --filter @ytauto/worker...

# bake Remotion's chrome-headless-shell into the image. Renders normally go to
# Remotion Lambda, but clearing REMOTION_LAMBDA_FUNCTION_NAME on /account falls
# back to the LOCAL CPU render, so the browser stays baked in — it is the
# escape hatch if Lambda breaks. Sitting on the manifests-only layer above, it
# is now re-fetched only when dependencies actually change.
RUN cd apps/worker && npx remotion browser ensure

# ── source layer ────────────────────────────────────────────────────────
# Sources are workspace-linked TypeScript run through tsx at start (no build
# step), so copying them last is enough.
COPY packages ./packages
COPY apps/worker ./apps/worker

ENV NODE_ENV=production
ENV WORKER_PORT=3010
EXPOSE 3010
CMD ["pnpm", "--filter", "@ytauto/worker", "start"]
