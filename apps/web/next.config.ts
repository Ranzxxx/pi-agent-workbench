import type { NextConfig } from "next";

const apiPort = Number(process.env.API_PORT ?? 2027);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) throw new Error("API_PORT must be a valid TCP port");

const nextConfig: NextConfig = {
  transpilePackages: ["@pi-workbench/protocol"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `http://127.0.0.1:${apiPort}/api/:path*` }];
  },
};

export default nextConfig;
