import { Type, type Static } from "@sinclair/typebox";
import { MonthlyPlanPeriod, MonthlyPlanStatus } from "./monthlyPlans.js";
import { VoiceprintStatus } from "./voiceprint.js";
import { MissionRoundPhase } from "./missionCards.js";

const Next = Type.Object(
  { text: Type.String(), action: Type.String(), href: Type.String() },
  { additionalProperties: false },
);

/** 引导第 3 步与结束摘要：成员是本人雷达，CEO 是公司雷达（不能关闭，enabled 恒为 true）。 */
const RadarSummary = Type.Object({
  /** 做过这一步：成员保存过设置；CEO 已有手工方向或媒体来源。 */
  configured: Type.Boolean(),
  enabled: Type.Boolean(),
  /** 成员是本人方向数；CEO 是手工补充的方向数。 */
  directions: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const common = {
  displayName: Type.String(),
  companyName: Type.Union([Type.String(), Type.Null()]),
  next: Next,
  voiceprint: VoiceprintStatus,
  radar: RadarSummary,
};

/** 按会话角色返回最小投影；成员响应不包含 CEO 公司快照或其他人的 Mission。 */
export const OnboardingResponse = Type.Union([
  Type.Object({
    ...common,
    role: Type.Literal("ceo"),
    company: Type.Object({
      sixMonthGoal: Type.String(),
      battlefields: Type.Array(Type.Object({
        id: Type.String(), code: Type.String(), name: Type.String(), ownerName: Type.Optional(Type.String()),
      }, { additionalProperties: false })),
      capabilities: Type.Array(Type.Object({
        id: Type.String(), code: Type.String(), name: Type.String(),
      }, { additionalProperties: false })),
      people: Type.Array(Type.Object({
        personId: Type.String(), displayName: Type.String(),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    ...common,
    role: Type.Literal("member"),
    work: Type.Object({
      period: MonthlyPlanPeriod,
      planStatus: Type.Union([Type.Literal("none"), MonthlyPlanStatus]),
      battlefields: Type.Array(Type.Object({
        id: Type.String(), name: Type.String(), monthTarget: Type.Union([Type.String(), Type.Null()]),
      }, { additionalProperties: false })),
      missions: Type.Array(Type.Object({
        id: Type.String(), code: Type.String(), title: Type.String(), battlefieldIds: Type.Array(Type.String()),
      }, { additionalProperties: false })),
      missionCards: Type.Array(Type.Object({
        cardId: Type.String(), roundId: Type.String(), period: MonthlyPlanPeriod,
        battlefieldId: Type.String(), battlefieldName: Type.String(), phase: MissionRoundPhase,
        status: Type.String(), closesAt: Type.Union([Type.String(), Type.Null()]), serverNow: Type.String(),
        missionCount: Type.Integer({ minimum: 0 }), placeholder: Type.Boolean(), href: Type.String(),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export const CompleteOnboardingResponse = Type.Object(
  { onboarded: Type.Literal(true) },
  { additionalProperties: false },
);

export type TOnboardingResponse = Static<typeof OnboardingResponse>;
export type TCompleteOnboardingResponse = Static<typeof CompleteOnboardingResponse>;
