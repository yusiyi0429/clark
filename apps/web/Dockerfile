FROM node:22-alpine AS build
# 大陆网络构建可传国内源（compose 读 .env 的同名变量）；不传则用官方源，与原行为一致
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN npm install -g pnpm@11.20.0
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web/package.json apps/web/
# ts-design 以 vendored tgz 安装（与 clark-main 同一版本），安装前必须在上下文里
COPY apps/web/vendor apps/web/vendor
RUN pnpm_config_registry=$NPM_CONFIG_REGISTRY pnpm install --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @warmap/web gen:client && pnpm --filter @warmap/web build

FROM node:22-alpine
WORKDIR /app
# 非 root：standalone 产物归 node 用户所有
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
