import { Type, type Static } from "@sinclair/typebox";
import { MemberWork } from "./memberHome.js";

/** 执行事项状态：returned 只能通过退回接口进入。 */
export const TaskStatus = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("returned"),
]);

/** 执行事项来源：会后推送的带会议与原话；以后成员自建的为 null。 */
export const TaskOrigin = Type.Object(
  {
    type: Type.Literal("meeting"),
    meetingId: Type.String({ minLength: 1 }),
    meetingTitle: Type.String({ minLength: 1 }),
    quote: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 成员侧执行事项视图：普通视图对象，不走 CEO 的 Card/Action 签名。 */
export const TaskView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    status: TaskStatus,
    /** YYYY-MM-DD */
    dueDate: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    returnReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    origin: Type.Union([TaskOrigin, Type.Null()]),
    /** ISO 8601 */
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** 成员工作台：参与的本月工作，以及我负责的执行事项（全部状态，新到旧）。 */
export const MeHomeResponse = Type.Object(
  { myTasks: Type.Array(TaskView), work: MemberWork },
  { additionalProperties: false },
);

/** 只有负责人能改状态；version 不一致返回 409 并带 latestTask。 */
export const PatchMyTaskRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress"), Type.Literal("done")]),
  },
  { additionalProperties: false },
);

/** 退回要写原因；会同时通知这场会的主持人。 */
export const ReturnMyTaskRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const NotificationKind = Type.Union([
  Type.Literal("meeting_action_assigned"),
  Type.Literal("task_returned"),
  Type.Literal("strategic_rejected"),
]);

/** 通知只指向对象；text 在读取时按对象当前状态组合。 */
export const NotificationView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: NotificationKind,
    text: Type.String({ minLength: 1 }),
    objectType: Type.Union([Type.Literal("task"), Type.Literal("meeting")]),
    objectId: Type.String({ minLength: 1 }),
    /** ISO 8601 */
    createdAt: Type.String({ minLength: 1 }),
    readAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 未读在前，最近 50 条。 */
export const NotificationList = Type.Object(
  { notifications: Type.Array(NotificationView, { maxItems: 50 }) },
  { additionalProperties: false },
);

/** 只标自己的通知；别人的 id 静默忽略。 */
export const MarkNotificationsSeenRequest = Type.Object(
  { notificationIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 100 }) },
  { additionalProperties: false },
);

export type TTaskStatus = Static<typeof TaskStatus>;
export type TTaskOrigin = Static<typeof TaskOrigin>;
export type TTaskView = Static<typeof TaskView>;
export type TMeHomeResponse = Static<typeof MeHomeResponse>;
export type TPatchMyTaskRequest = Static<typeof PatchMyTaskRequest>;
export type TReturnMyTaskRequest = Static<typeof ReturnMyTaskRequest>;
export type TNotificationKind = Static<typeof NotificationKind>;
export type TNotificationView = Static<typeof NotificationView>;
export type TNotificationList = Static<typeof NotificationList>;
export type TMarkNotificationsSeenRequest = Static<typeof MarkNotificationsSeenRequest>;
