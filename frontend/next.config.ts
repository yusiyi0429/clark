import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 容器化：只把运行时真正需要的东西产出到 .next/standalone，
  // 镜像里不带完整 node_modules。
  output: "standalone",

  /*
   * 产出目录可以由环境变量挪开。**只为一件事存在：同一个目录同时跑两个 dev。**
   *
   * Next 16 起 `next dev` 会在 `<distDir>/dev` 上加一把锁，同一个目录第二个 dev 直接
   * 退出（`build/lockfile.js`）。而这个仓库经常有两条线同时在改（并行的会话各自要一台
   * 起着的服务去验自己那一版），撞上这把锁之后第二条线就只能去动别人那一台。
   *
   * 不写就是原来的 `.next`，所以 `pnpm dev`、`pnpm build`、镜像构建一个字都不用变。
   * 要开第二台：`NEXT_DIST_DIR=.next-alt`，再配一个自己的端口和自己的 `TKOS_DATA_DIR`。
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  /*
   * `prompts/` 是运行时读盘的，没有任何 import 指向它，所以文件追踪看不见它 ——
   * 不加这一条，容器里跑起来每次都是「没有工程段模板」，而本地 dev 一切正常。
   * 键是路由 glob，值是从项目根解析的文件 glob（见
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md）。
   */
  outputFileTracingIncludes: {
    // unpdf 是 `research/fetch.ts` 里用变量名 import 的可选依赖（抓 PDF），文件追踪同样看不见它；
    // 不加这一条，standalone 镜像里永远是「这台机器没装」而本地 dev 能抓（2026-09-04）。
    "/*": ["./prompts/**/*.md", "./node_modules/unpdf/**"],
  },

  // SSE（/api/chat）在反代后面必须关缓冲。路由里已设 X-Accel-Buffering: no，
  // 这里补一层通用响应头，避免中间层自作主张压缩流式响应。
  async headers() {
    return [
      {
        source: "/api/chat",
        headers: [
          { key: "Cache-Control", value: "no-store, no-transform" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
    ];
  },
};

export default nextConfig;
