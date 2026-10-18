import { Type, type Static } from "@sinclair/typebox";

/** other：OpenCode、Cursor 等支持远程 MCP 的其他工具，连接说明给通用步骤。collector：本机采集器，只能调 /api/collector，不能连 MCP。 */
export const PersonalTokenClient = Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("other"), Type.Literal("collector")]);
export const PersonalTokenView = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  client: PersonalTokenClient,
  authType: Type.Optional(Type.Union([Type.Literal("personal"), Type.Literal("oauth")])),
  createdAt: Type.String({ minLength: 1 }),
  expiresAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  lastUsedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  /** 这个令牌最近一次写入进展的时间：连接对话框据此显示「最近同步」。 */
  lastProgressAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });
export const ListPersonalTokensResponse = Type.Object({
  tokens: Type.Array(PersonalTokenView),
  mcpPath: Type.Literal("/mcp/me"),
  /** Canonical resource URL: OAuth discovery and resource binding must use the same origin. */
  mcpUrl: Type.Optional(Type.String({ minLength: 1 })),
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

export const OAuthConsentResponse = Type.Object({
  clientName: Type.String(), callbackHost: Type.String(), scopes: Type.Array(Type.String()), csrfToken: Type.String(),
}, { additionalProperties: false });
export const OAuthConsentRequest = Type.Object({
  allow: Type.Boolean(), csrfToken: Type.String({ minLength: 64, maxLength: 64 }), name: Type.String({ maxLength: 40 }),
}, { additionalProperties: false });
export const OAuthConsentDecisionResponse = Type.Object({ redirect: Type.String() }, { additionalProperties: false });
