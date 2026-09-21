import { Type, type Static } from "@sinclair/typebox";

/** API health 只报告布尔安全摘要：不返回 secret，也不发起模型/Search 调用（.tech/07 §8）。 */
export const HealthDependencies = Type.Object(
  {
    piRuntime: Type.Boolean(),
    modelSlots: Type.Boolean(),
    companyMemoryMcp: Type.Boolean(),
    search: Type.Boolean(),
    wechat: Type.Boolean(),
    outlets: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    api: Type.Boolean(),
    database: Type.Boolean(),
    buildSha: Type.String(),
    dependencies: HealthDependencies,
  },
  { additionalProperties: false },
);

export type THealthResponse = Static<typeof HealthResponse>;
