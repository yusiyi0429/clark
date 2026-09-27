import { Type, type Static } from "@sinclair/typebox";

export const PersonalTokenClient = Type.Union([Type.Literal("codex"), Type.Literal("claude")]);
export const PersonalTokenView = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  client: PersonalTokenClient,
  createdAt: Type.String({ minLength: 1 }),
  expiresAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  lastUsedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
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
