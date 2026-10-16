import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const nextConfig: NextConfig = {
  output: "standalone",
  // 本地浏览器验收走 127.0.0.1；手机在同一局域网里真机验收走私有网段地址。只影响 next dev，生产由 Caddy 终止。
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.*.*", "10.*.*.*"],
  // 本地代理默认约 30 秒就断开，Radar 扫描、会议创建这类长请求会被误报失败；生产不经过这层代理。
  experimental: { proxyTimeout: 120_000 },
  // 生产由 Caddy 把 /api/* 直接转发到 API；本地 `next dev` 没有边界进程，
  // 因此只在非生产构建里把同源 /api 代理到 API 服务，便于浏览器旅程验证。
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const envPath = resolve(process.cwd(), "../../.env");
    const rootEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
    const api = process.env.API_SERVER_URL ?? rootEnv.API_SERVER_URL ?? "http://localhost:4000";
    const m2 = process.env.M2_SERVER_URL ?? rootEnv.M2_SERVER_URL ?? "http://localhost:4333";
    return [{ source: "/m2/:path*", destination: `${m2}/m2/:path*` }, { source: "/api/:path*", destination: `${api}/api/:path*` }, { source: "/mcp/:path*", destination: `${api}/mcp/:path*` },
      { source: "/.well-known/:path*", destination: `${api}/.well-known/:path*` }];
  },
};

export default nextConfig;
