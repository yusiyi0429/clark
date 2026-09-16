# ponytail: 单阶段镜像，含 devDeps（tsx 直接跑 TS）；Ticket 16 只保证可重复构建与非 root 运行
FROM node:22-alpine
RUN npm install -g pnpm@11.20.0
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
# 非 root：node 用户只读访问代码与只读挂载的 backend/seed；镜像内不写业务文件
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@warmap/api", "start"]
