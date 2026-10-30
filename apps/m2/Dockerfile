FROM node:24-alpine AS build
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN npm install -g pnpm@11.20.0
WORKDIR /repo
ARG M2_BUILD_COMMIT
ARG M2_BUILD_ENV
ENV M2_BUILD_COMMIT=$M2_BUILD_COMMIT M2_BUILD_ENV=$M2_BUILD_ENV
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/m2 apps/m2
RUN pnpm_config_registry=$NPM_CONFIG_REGISTRY pnpm install --frozen-lockfile && pnpm --filter @warmap/m2 build
FROM node:24-alpine
RUN apk add --no-cache python3
WORKDIR /repo/apps/m2
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/apps/m2 ./
RUN mkdir -p .runtime && chown node:node .runtime
ENV NODE_ENV=production M2_BIND_HOST=0.0.0.0 PORT=4333 DECODING_DISABLE_LOCAL_KEY=1
USER node
EXPOSE 4333
CMD ["node", "server.mjs"]
