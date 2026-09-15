import { Type, type Static } from "@sinclair/typebox";

export const WebSearchInput = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500 }),
  freshness: Type.Optional(Type.Union([
    Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year"),
  ])),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
}, { additionalProperties: false });

export const WebSearchResult = Type.Object({
  title: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  publishedAt: Type.Optional(Type.String({ format: "date-time" })),
  excerpt: Type.String(),
  provider: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const WebSearchResponse = Type.Object({
  results: Type.Array(WebSearchResult),
  warnings: Type.Array(Type.String()),
}, { additionalProperties: false });

export type TWebSearchInput = Static<typeof WebSearchInput>;
export type TWebSearchResult = Static<typeof WebSearchResult>;
export type TWebSearchResponse = Static<typeof WebSearchResponse>;
