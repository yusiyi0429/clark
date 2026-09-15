# TKOS 前端（clark-main）容器镜像
#
# 注意事项（踩过的坑，改动前先读）：
#   * src/app/fonts/*.woff2 必须进构建上下文。缺了它们 next build 会以一条
#     完全看不出原因的 Turbopack panic 失败（Missing content when trying to
#     generate the content hash for static asset）。.dockerignore 里不要过滤。
#   * 用 output: "standalone"（next.config.ts）。runner 层只拷 standalone +
#     static + public，不带完整 node_modules。
#   * 所有密钥都是运行时注入，没有 NEXT_PUBLIC_ 前缀，所以不需要 build-arg。
#   * /api/chat 是 SSE 长流式。反代（nginx/ALB/CLB）必须关 proxy_buffering，
#     read timeout 要大于工具轮上限（MAX_TOOL_ROUNDS=4）。
#   * lib/asr/relay.ts 与 lib/stage/bus.ts 是进程内内存，语音/舞台链路
#     不支持多副本。这一版 operator 已封存，正常扩容不受影响；若要开语音，
#     单副本部署或 sticky session。
#   * 不用 corepack —— 它写死 registry.npmjs.org，在国内网络下不可达且无法
#     指向镜像源。改用 npm i -g pnpm，registry 由 NPM_REGISTRY 参数控制。
#
# 构建（国内，默认走 npmmirror）：
#   docker build -t tkos-frontend:$(git rev-parse --short HEAD) .
# 构建（境外网络）：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org -t tkos-frontend:dev .

# 国内网络默认走 npmmirror；境外构建覆盖为 https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- base：只装一次 pnpm，deps 与 build 共用 ----------
# 不要在 deps 和 build 里各装一遍 —— buildkit 并行跑这两个 stage，
# 两次并发装同一个包会偶发失败。
FROM node:24-slim AS base
ARG NPM_REGISTRY
RUN npm config set registry "$NPM_REGISTRY" && npm i -g pnpm@11.5.3
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- build ----------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- runner ----------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# ffmpeg / ffprobe：会议录音那条链路的第一步（规整成 16k 单声道 mp3）。
#
# 装在 runner 而不是 build：它是**运行时**才用到的（spawn 一个子进程），build 阶段
# 一次都不叫。装错地方的表现是镜像构得出来、跑起来每一份录音都在第一步倒掉。
#
# --no-install-recommends 省掉一堆 X11 相关的推荐依赖，镜像小几百 MB。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# TTS 预生成会往 demo/audio 写文件；给它一个可写目录，避免只读 cwd 报错。
RUN mkdir -p /app/demo/audio && chown -R nextjs:nodejs /app/demo

# 对象库的落盘快照。挂卷出来，否则容器一重建演示状态就没了。
# 种子一改指纹就对不上，快照会被自动丢弃重建 —— 不用手动清。
ENV TKOS_DATA_DIR=/app/.data
RUN mkdir -p /app/.data && chown -R nextjs:nodejs /app/.data
VOLUME ["/app/.data"]

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
