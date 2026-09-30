import { Type, type Static } from "@sinclair/typebox";

/** 看过标记：某版本的更新卡（release:<版本>）或执行事项、任务卡产品演示。 */
export const SeenMarkKey = Type.String({ pattern: "^(release:[0-9a-z.-]{1,32}|tour:(execution-items|mission-card))$" });

export const SeenMarksResponse = Type.Object(
  { keys: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export type TSeenMarksResponse = Static<typeof SeenMarksResponse>;
