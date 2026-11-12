import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 本地浏览器验收走 127.0.0.1；手机在同一局域网里真机验收走私有网段地址。只影响 next dev，生产由 Caddy 终止。
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.*.*", "10.*.*.*"],
  // 本地代理默认约 30 秒就断开，Radar 扫描、会议创建这类长请求会被误报失败；生产不经过这层代理。
  experimental: { proxyTimeout: 900_000 },
  // 老界面的地址挪进新首页以后一直留着跳转：飞书推送、对话记录里存的老链接都还指着老地址。查询参数 Next 会原样带过去。
  async redirects() {
    return [{ source: "/me/meetings/:id", destination: "/me/work/meetings/:id", permanent: false }];
  },
  // 生产由 Caddy 把 /api/* 直接转发到 API；本地 `next dev` 没有边界进程，
  // 因此只在非生产构建里把同源 /api 代理到 API 服务，便于浏览器旅程验证。
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const api = process.env.API_SERVER_URL ?? "http://localhost:4000";
    return [{ source: "/m2/:path*", destination: `${process.env.M2_SERVER_URL ?? "http://localhost:4333"}/m2/:path*` }, { source: "/api/:path*", destination: `${api}/api/:path*` }, { source: "/mcp/:path*", destination: `${api}/mcp/:path*` },
      { source: "/.well-known/:path*", destination: `${api}/.well-known/:path*` }];
  },
};

export default nextConfig;
