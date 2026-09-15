# TypeScript API 使用 Fastify、TypeBox 和生成客户端

Pi SDK 确定为 TypeScript Runtime 后，独立 API 使用 Fastify，领域 DTO、Card、Action 和 Pi Tool 参数使用 TypeBox 描述并生成 OpenAPI，Web 从 OpenAPI 生成 TypeScript 客户端。这样保持前后端独立部署，同时避免 Python／TypeScript 或前后端各自手写一套易漂移的契约。