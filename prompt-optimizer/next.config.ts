import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Externalize packages that cause issues with Turbopack/webpack
  serverExternalPackages: ["braintrust", "autoevals"],

  // Empty turbopack config to silence webpack warning
  turbopack: {},
};

export default nextConfig;
