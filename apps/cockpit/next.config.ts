import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  transpilePackages: ["@ytauto/db", "@ytauto/core", "@ytauto/providers", "@ytauto/agents"],
  serverExternalPackages: ["postgres"],
  // separate dir for CI/verification builds so `next build` never clobbers a
  // running dev server's .next assets
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // pin the workspace root to this monorepo so Next doesn't infer it from an
  // unrelated lockfile elsewhere on the machine
  outputFileTracingRoot: join(__dirname, "../.."),
};

export default nextConfig;
