import { Type, type Static } from "@sinclair/typebox";
import { CardCollection } from "./cards.js";

export const ExecuteActionRequest = Type.Object(
  {
    actionId: Type.String(),
    input: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

// 成功与幂等重放都返回当前 Card；版本冲突以 ApiError(VERSION_CONFLICT) + latestCard 返回。
export const ExecuteActionResponse = CardCollection;

export type TExecuteActionRequest = Static<typeof ExecuteActionRequest>;
