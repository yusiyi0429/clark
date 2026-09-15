import { Type, type Static } from "@sinclair/typebox";

export const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    database: Type.Boolean(),
    buildSha: Type.String(),
  },
  { additionalProperties: false },
);

export type THealthResponse = Static<typeof HealthResponse>;
