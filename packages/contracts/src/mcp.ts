import { Type, type Static } from "@sinclair/typebox";

// ── company-people.v1 人员 seed 契约（docs/contracts/company-people.v1.md）──

export const PersonSeed = Type.Object(
  {
    personId: Type.String({ minLength: 1, description: "稳定且全目录唯一，不因改名复用或重写" }),
    displayName: Type.String({ minLength: 1, description: "仅用于展示" }),
    roles: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "MVP 识别 ceo、dri、participant",
    }),
  },
  { additionalProperties: false },
);

export const CompanyPeopleSeed = Type.Object(
  {
    schemaVersion: Type.Literal("company-people.v1"),
    people: Type.Array(PersonSeed, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type TCompanyPeopleSeed = Static<typeof CompanyPeopleSeed>;

// ── 只读 CompanyMemory MCP 工具契约（Markdown 与未来数据库都隐藏在之后）──

export const SourceAttributed = Type.Object({
  sourceRef: Type.String({ description: "来源定位，如 company.md#1. 公司战略" }),
  updatedAt: Type.String({ description: "来源最后更新时间，ISO 8601 UTC" }),
});

export const SectionSummary = Type.Composite([
  Type.Object({
    id: Type.String({ description: "稳定章节 ID，如 company.md#s1" }),
    title: Type.String(),
  }),
  SourceAttributed,
]);

export const ListSectionsInput = Type.Object({}, { additionalProperties: false });
export const ListSectionsResult = Type.Object({ sections: Type.Array(SectionSummary) });

export const SearchSectionsInput = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
  },
  { additionalProperties: false },
);
export const SectionMatch = Type.Composite([
  SectionSummary,
  Type.Object({ snippet: Type.String({ description: "最相关段落摘录" }), score: Type.Number() }),
]);
export const SearchSectionsResult = Type.Object({ results: Type.Array(SectionMatch) });

export const GetPassagesInput = Type.Object(
  {
    sectionId: Type.String({ minLength: 1 }),
    query: Type.Optional(Type.String({ description: "缺省时按原文顺序返回段落" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
  },
  { additionalProperties: false },
);
export const Passage = Type.Composite([
  Type.Object({
    id: Type.String({ description: "稳定段落 ID，如 company.md#s1#p2" }),
    text: Type.String(),
  }),
  SourceAttributed,
]);
export const GetPassagesResult = Type.Object({ section: SectionSummary, passages: Type.Array(Passage) });

export const SearchPeopleInput = Type.Object(
  { query: Type.Optional(Type.String({ description: "displayName 子串匹配；缺省返回全部" })) },
  { additionalProperties: false },
);
export const PersonResult = Type.Composite([
  Type.Object({
    personId: Type.String(),
    displayName: Type.String(),
    roles: Type.Array(Type.String()),
  }),
  SourceAttributed,
]);
export const SearchPeopleResult = Type.Object({ people: Type.Array(PersonResult) });

/** 只读工具全集；新增工具必须同时更新写入路径审查。 */
export const COMPANY_MEMORY_TOOLS = [
  "list_sections",
  "search_sections",
  "get_passages",
  "search_people",
] as const;

export type TSectionSummary = Static<typeof SectionSummary>;
export type TSectionMatch = Static<typeof SectionMatch>;
export type TPersonResult = Static<typeof PersonResult>;
