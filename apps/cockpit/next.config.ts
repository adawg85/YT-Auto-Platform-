import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ytauto/db", "@ytauto/core", "@ytauto/providers", "@ytauto/agents"],
  serverExternalPackages: ["postgres"],
  // separate dir for CI/verification builds so `next build` never clobbers a
  // running dev server's .next assets
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
