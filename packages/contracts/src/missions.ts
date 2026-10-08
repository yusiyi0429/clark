import { Type, type Static } from "@sinclair/typebox";
import { MonthlyPlanPeriod } from "./monthlyPlans.js";

/**
 * Mission：WarMap 第七个核心业务实体，版本化 Organization Fact。
 * 只承载周期结果承诺与关系；Task/Activity、执行状态与完成率留在外部 DRI 流程。
 */

const MissionCode = Type.String({ minLength: 1, maxLength: 40 });
/** 周期与 MonthlyPlan 同一把尺：Asia/Shanghai 公司月 YYYY-MM，月份只接受 01–12。 */
const MissionPeriod = MonthlyPlanPeriod;
const MissionTitle = Type.String({ minLength: 1, maxLength: 200 });
const MissionText = Type.String({ maxLength: 4000 });
/** 成功证据与关键里程碑都是「每行一项」，保留来源表述，不拆成结构化字段。 */
const MissionLines = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 });
const BattlefieldIds = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20, uniqueItems: true });

/** Mission 来源元数据：飞书正文只做导入输入，这里只留可追溯引用，Web 不可编辑。 */
const MissionSourceFields = {
  sourceRef: Type.String({ minLength: 1, maxLength: 500 }),
  sourceDocumentId: Type.String({ minLength: 1, maxLength: 200 }),
  sourceRevision: Type.Integer({ minimum: 1 }),
  sourceTitle: Type.String({ minLength: 1, maxLength: 300 }),
};

/** Mission 正面：能力域与战场的显示名在投影时现查注册表，不保存第二份事实。 */
export const MissionCardPayload = Type.Object(
  {
    missionId: Type.String(),
    code: MissionCode,
    period: MissionPeriod,
    title: MissionTitle,
    ownerId: Type.String(),
    /** 投影时现查 company-people.v1；空 ownerId 显示为“待指派”。 */
    ownerDisplayName: Type.String(),
    capabilityId: Type.String(),
    capabilityCode: Type.String(),
    capabilityName: Type.String(),
    battlefieldIds: Type.Array(Type.String()),
    battlefieldNames: Type.Array(Type.String()),
    outcome: Type.String(),
    timeBoundary: Type.String(),
    tradeoffs: Type.String(),
    why: Type.String(),
    successEvidence: Type.Array(Type.String()),
    milestones: Type.Array(Type.String()),
    dependencies: Type.String(),
    risk: Type.String(),
    boundaries: Type.String(),
    keyPath: Type.String(),
    resources: Type.String(),
    humanAgentSplit: Type.String(),
    retrospect: Type.String(),
    placeholder: Type.Boolean(),
    personalCard: Type.Union([Type.Object({
      cardId: Type.String(),
      roundId: Type.String(),
      status: Type.Union([Type.Literal("draft"), Type.Literal("open"), Type.Literal("reviewing"), Type.Literal("confirmed")]),
    }, { additionalProperties: false }), Type.Null()]),
    sourceRef: Type.String(),
    sourceDocumentId: Type.String(),
    sourceRevision: Type.Integer({ minimum: 1 }),
    sourceTitle: Type.String(),
  },
  { additionalProperties: false },
);

/** CEO 首次登记 Mission（真实导入走这里）：没有既有版本可锚，不是 opaque-action。 */
export const CreateMissionRequest = Type.Object(
  {
    code: MissionCode,
    period: MissionPeriod,
    title: MissionTitle,
    ownerId: Type.String({ minLength: 1, maxLength: 200 }),
    capabilityId: Type.String({ minLength: 1, maxLength: 100 }),
    battlefieldIds: BattlefieldIds,
    outcome: Type.String({ minLength: 1, maxLength: 4000 }),
    timeBoundary: Type.Optional(MissionText),
    tradeoffs: Type.Optional(MissionText),
    why: Type.Optional(MissionText),
    successEvidence: Type.Optional(MissionLines),
    milestones: Type.Optional(MissionLines),
    dependencies: Type.Optional(MissionText),
    risk: Type.Optional(MissionText),
    boundaries: Type.Optional(MissionText),
    keyPath: Type.Optional(MissionText),
    resources: Type.Optional(MissionText),
    humanAgentSplit: Type.Optional(MissionText),
    retrospect: Type.Optional(MissionText),
    ...MissionSourceFields,
  },
  { additionalProperties: false },
);

/** mission.edit：只提交要改的字段（至少一项）；source metadata 默认不可从 Web 编辑。 */
export const MissionEditInput = Type.Object(
  {
    code: Type.Optional(MissionCode),
    period: Type.Optional(MissionPeriod),
    title: Type.Optional(MissionTitle),
    ownerId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    capabilityId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    battlefieldIds: Type.Optional(BattlefieldIds),
    outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    timeBoundary: Type.Optional(MissionText),
    tradeoffs: Type.Optional(MissionText),
    why: Type.Optional(MissionText),
    successEvidence: Type.Optional(MissionLines),
    milestones: Type.Optional(MissionLines),
    dependencies: Type.Optional(MissionText),
    risk: Type.Optional(MissionText),
    boundaries: Type.Optional(MissionText),
    keyPath: Type.Optional(MissionText),
    resources: Type.Optional(MissionText),
    humanAgentSplit: Type.Optional(MissionText),
    retrospect: Type.Optional(MissionText),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** Mission 配置页一次投影：按 period desc、能力域 sortOrder、code 排序的完整正面集合。 */
export const MissionManagementResponse = Type.Object(
  { missions: Type.Array(MissionCardPayload) },
  { additionalProperties: false },
);

export type TMissionCardPayload = Static<typeof MissionCardPayload>;
export type TCreateMissionRequest = Static<typeof CreateMissionRequest>;
export type TMissionEditInput = Static<typeof MissionEditInput>;
export type TMissionManagementResponse = Static<typeof MissionManagementResponse>;
