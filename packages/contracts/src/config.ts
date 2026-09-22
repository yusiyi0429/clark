import { Type, type Static } from "@sinclair/typebox";

/**
 * CEO 配置页写入的 Organization Fact 请求契约。
 * 表单是确定性输入，但仍走 CEO session 鉴权；这些路由创建新对象，没有既有 Card version 可锚，所以不是 opaque-action。
 */

export const CreateBattlefieldRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    owner: Type.String({ minLength: 1, maxLength: 100 }),
    goal: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const CreateCapabilityRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    group: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

/** 议题↔战场关联集合：Action 只接受单个 battlefieldId，集合归一化由服务端确定。 */
export const AssignBattlefieldIssueRequest = Type.Object(
  {
    issueId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

/** 能力正面：首页能力面板用注册分组补齐尚未有 Issue 的能力；不保存第二份事实。 */
export const CapabilityCardPayload = Type.Object(
  {
    capabilityId: Type.String(),
    name: Type.String(),
    group: Type.String(),
    description: Type.String(),
  },
  { additionalProperties: false },
);

/** CEO 新建 Issue：title 限制 25 字；battlefieldId 必须是已注册战场。 */
export const CreateCeoIssueRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 25 }),
    battlefieldId: Type.String({ minLength: 1, maxLength: 100 }),
    decisionBy: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

/** 独立新建 Meeting：issueIds 允许为空数组（会议可以先立，再并入议题）。 */
export const CreateConfigMeetingRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: Type.String({ minLength: 1, maxLength: 100 }),
    leadDriId: Type.String({ minLength: 1, maxLength: 200 }),
    issueIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50, uniqueItems: true })),
  },
  { additionalProperties: false },
);

export type TCreateBattlefieldRequest = Static<typeof CreateBattlefieldRequest>;
export type TAssignBattlefieldIssueRequest = Static<typeof AssignBattlefieldIssueRequest>;
export type TCreateCapabilityRequest = Static<typeof CreateCapabilityRequest>;
export type TCapabilityCardPayload = Static<typeof CapabilityCardPayload>;
export type TCreateCeoIssueRequest = Static<typeof CreateCeoIssueRequest>;
export type TCreateConfigMeetingRequest = Static<typeof CreateConfigMeetingRequest>;
