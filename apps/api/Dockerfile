# ponytail: 单阶段镜像，含 devDeps；ticket 16 部署联调时再精简
FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@warmap/api", "start"]
