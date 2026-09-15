FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @warmap/web gen:client && pnpm --filter @warmap/web build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
