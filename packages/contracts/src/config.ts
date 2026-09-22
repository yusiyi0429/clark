import { Type, type Static } from "@sinclair/typebox";
import { IssueUrgencyLevel } from "./issues.js";

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

/** CEO 编辑战场：只提交要改的字段（至少一项），id 稳定、version+1；改名 slug 冲突返回 409。 */
export const PatchBattlefieldRequest = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    owner: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    goal: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** CEO 编辑能力：同战场模式，能力表无 updated_at 列，只 version+1。 */
export const PatchCapabilityRequest = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    group: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** 能力管理页轻量列表投影：只读注册表行，不经过首页 Card 组合。 */
export const CapabilityManagementResponse = Type.Object(
  {
    capabilities: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          version: Type.Integer({ minimum: 1 }),
          name: Type.String({ minLength: 1 }),
          group: Type.String(),
          description: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
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

/** 战场管理页一次拉取整页数据：展示态，不做任何业务写入。 */
export const BattlefieldManagementResponse = Type.Object(
  {
    battlefields: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          owner: Type.String(),
          pendingIssueCount: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    /** 仅 pending、排除 capability 级；battlefieldIds 是归一化后的集合，未归属为空数组。 */
    issues: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          urgencyLevel: IssueUrgencyLevel,
          decisionBy: Type.Optional(Type.String({ minLength: 1 })),
          battlefieldIds: Type.Array(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
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
export type TPatchBattlefieldRequest = Static<typeof PatchBattlefieldRequest>;
export type TPatchCapabilityRequest = Static<typeof PatchCapabilityRequest>;
export type TCapabilityManagementResponse = Static<typeof CapabilityManagementResponse>;
export type TAssignBattlefieldIssueRequest = Static<typeof AssignBattlefieldIssueRequest>;
export type TCreateCapabilityRequest = Static<typeof CreateCapabilityRequest>;
export type TCapabilityCardPayload = Static<typeof CapabilityCardPayload>;
export type TBattlefieldManagementResponse = Static<typeof BattlefieldManagementResponse>;
export type TCreateCeoIssueRequest = Static<typeof CreateCeoIssueRequest>;
export type TCreateConfigMeetingRequest = Static<typeof CreateConfigMeetingRequest>;
