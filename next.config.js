/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bundles only the files needed to run the server,
  // including a minimal subset of node_modules. Used by the Dockerfile to
  // ship a small runtime image (no devDeps, no source maps, no test files).
  output: "standalone",
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000"],
    },
  },
};

module.exports = nextConfig;
