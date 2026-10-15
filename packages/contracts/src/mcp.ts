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

// Stable directory metadata is independent of company fact memory.
export const SourceAttributed = Type.Object({
  sourceRef: Type.String({ description: "人员目录记录定位" }),
  updatedAt: Type.String({ description: "人员目录更新时间，ISO 8601 UTC" }),
});

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

export type TPersonResult = Static<typeof PersonResult>;
