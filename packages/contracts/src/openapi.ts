import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  ActionDescriptor,
  ApiError,
  Card,
  CardCollection,
  ExecuteActionRequest,
  ConversationHistory,
  ConversationMessageRequest,
  ConversationSseEvent,
  HealthResponse,
  LoginRequest,
  SessionResponse,
} from "./index.js";

const errorResponse = {
  description: "ApiError 统一错误",
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
} satisfies OpenAPIV3.ResponseObject;

const jsonBody = (schema: JsonSchema) => ({
  required: true,
  content: { "application/json": { schema } },
});

export function buildOpenApiDocument(): OpenAPIV3.Document {
  return {
    openapi: "3.1.0",
    info: {
      title: "CEO WarMap API",
      version: "0.1.0",
      description: "Card envelope、Action、鉴权与健康的公开契约",
    },
    servers: [{ url: "/" }],
    paths: {
      "/api/auth/login": {
        post: {
          operationId: "login",
          summary: "CEO 登录，签发 HttpOnly session cookie",
          requestBody: jsonBody({ $ref: "#/components/schemas/LoginRequest" }),
          responses: {
            "200": {
              description: "已登录",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
            "401": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/auth/logout": {
        post: {
          operationId: "logout",
          summary: "注销当前 session",
          responses: {
            "200": {
              description: "已注销",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
          },
        },
      },
      "/api/auth/session": {
        get: {
          operationId: "getSession",
          summary: "查询当前登录状态",
          responses: {
            "200": {
              description: "登录状态",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
          },
        },
      },
      "/api/cards/home": {
        get: {
          operationId: "getHomeCards",
          summary: "首页 Card 集合（无副作用）",
          responses: {
            "200": {
              description: "Card 集合",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } },
              },
            },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/issues/{id}": {
        get: {
          operationId: "getIssueCard",
          summary: "读取 Issue Card（Ticket 04 最小 fixture）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/messages": {
        get: {
          operationId: "getConversationMessages",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "读取独立 scope 的原始 Conversation 消息",
          responses: {
            "200": { description: "Conversation 历史", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationHistory" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "sendConversationMessage",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "发送消息并通过 SSE 返回 Pi 运行事件",
          requestBody: jsonBody({ $ref: "#/components/schemas/ConversationMessageRequest" }),
          responses: {
            "200": { description: "SSE 事件流", content: { "text/event-stream": { schema: { $ref: "#/components/schemas/ConversationSseEvent" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/actions/execute": {
        post: {
          operationId: "executeAction",
          summary: "执行 Action：fingerprint 幂等优先，再校验 version",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteActionRequest" }),
          responses: {
            "200": {
              description: "执行成功或幂等重放，返回当前 Card",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } },
              },
            },
            "401": errorResponse,
            "404": errorResponse,
            "409": {
              description: "version 冲突，携带 latestCard",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
            },
          },
        },
      },
      "/healthz": {
        get: {
          operationId: "health",
          summary: "健康检查，无副作用",
          responses: {
            "200": {
              description: "健康状态",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Card: Card as JsonSchema,
        CardCollection: CardCollection as JsonSchema,
        ActionDescriptor: ActionDescriptor as JsonSchema,
        ApiError: ApiError as JsonSchema,
        LoginRequest: LoginRequest as JsonSchema,
        SessionResponse: SessionResponse as JsonSchema,
        ExecuteActionRequest: ExecuteActionRequest as JsonSchema,
        ConversationHistory: ConversationHistory as JsonSchema,
        ConversationMessageRequest: ConversationMessageRequest as JsonSchema,
        ConversationSseEvent: ConversationSseEvent as JsonSchema,
        HealthResponse: HealthResponse as JsonSchema,
      },
    },
  };
}
