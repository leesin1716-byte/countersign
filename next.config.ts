import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // The agent reads attachment images from disk when it runs live.
  outputFileTracingIncludes: { "/api/**": ["./public/attachments/**"] },
};

export default nextConfig;
