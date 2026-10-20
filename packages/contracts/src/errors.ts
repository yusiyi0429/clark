import { Type, type Static } from "@sinclair/typebox";
import { Card } from "./cards.js";
import { TaskView } from "./tasks.js";
import { MeetingCardView } from "./meetingCard.js";

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
    /** 会议卡草稿版本冲突（DRAFT_CHANGED）时带回最新视图。 */
    view: Type.Optional(MeetingCardView),
  },
  { additionalProperties: false, $id: "ApiError" },
);

export type TApiError = Static<typeof ApiError>;
