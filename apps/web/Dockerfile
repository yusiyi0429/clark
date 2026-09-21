FROM node:22-alpine AS build
RUN npm install -g pnpm@11.20.0
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

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
