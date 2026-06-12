import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The meridian repo root has its own lockfile; pin tracing to this app so
  // Next doesn't infer the monorepo root and warn.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
