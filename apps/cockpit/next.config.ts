import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ytauto/db", "@ytauto/core", "@ytauto/providers", "@ytauto/agents"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
