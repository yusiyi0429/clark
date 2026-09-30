import { Type, type Static } from "@sinclair/typebox";

/** other：OpenCode、Cursor 等支持远程 MCP 的其他工具，连接说明给通用步骤。 */
export const PersonalTokenClient = Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("other")]);
export const PersonalTokenView = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  client: PersonalTokenClient,
  createdAt: Type.String({ minLength: 1 }),
  expiresAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  lastUsedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  /** 这个令牌最近一次写入进展的时间：连接对话框据此显示「最近同步」。 */
  lastProgressAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
export const ListPersonalTokensResponse = Type.Object({
  tokens: Type.Array(PersonalTokenView),
  mcpPath: Type.Literal("/mcp/me"),
}, { additionalProperties: false });
export const CreatePersonalTokenRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  client: PersonalTokenClient,
  expiresInDays: Type.Union([Type.Literal(30), Type.Literal(90), Type.Null()]),
}, { additionalProperties: false });
export const CreatePersonalTokenResponse = Type.Object({
  token: Type.String({ minLength: 1 }),
  view: PersonalTokenView,
}, { additionalProperties: false });

export type TPersonalTokenClient = Static<typeof PersonalTokenClient>;
export type TPersonalTokenView = Static<typeof PersonalTokenView>;
export type TListPersonalTokensResponse = Static<typeof ListPersonalTokensResponse>;
export type TCreatePersonalTokenRequest = Static<typeof CreatePersonalTokenRequest>;
export type TCreatePersonalTokenResponse = Static<typeof CreatePersonalTokenResponse>;
