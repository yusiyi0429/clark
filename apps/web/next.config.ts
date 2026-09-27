import type { NextConfig } from "next";

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
    const api = process.env.API_SERVER_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
