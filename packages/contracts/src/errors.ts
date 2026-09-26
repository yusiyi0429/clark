import { Type, type Static } from "@sinclair/typebox";
import { Card } from "./cards.js";
import { TaskView } from "./tasks.js";

export const ApiError = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean(),
    requestId: Type.String(),
    fieldErrors: Type.Optional(Type.Record(Type.String(), Type.String())),
    latestCard: Type.Optional(Card),
    /** 成员执行事项 version 冲突时带回当前视图。 */
    latestTask: Type.Optional(TaskView),
  },
  { additionalProperties: false, $id: "ApiError" },
);

export type TApiError = Static<typeof ApiError>;
