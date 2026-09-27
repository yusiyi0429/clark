import { Type, type Static } from "@sinclair/typebox";
import { OnboardingResponse } from "./onboarding.js";
import { MissionCardPayload } from "./missions.js";
import { MissionRoundSummary } from "./missionCards.js";

const onboardingWork = OnboardingResponse.anyOf[1].properties.work;
const monthlyTarget = {
  monthTarget: Type.Union([Type.String(), Type.Null()]),
  monthTargetState: Type.Union([Type.Literal("none"), Type.Literal("negotiating"), Type.Literal("confirmed")]),
  monthTargetText: Type.String(),
};

/** 引导与日常首页读取同一份本月参与关系、目标和本人卡。 */
export const MemberWork = Type.Object({
  ...onboardingWork.properties,
  battlefields: Type.Array(Type.Object({
    id: Type.String(), name: Type.String(), isDri: Type.Boolean(), ...monthlyTarget,
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** 成员战场只提供目标、个人承诺与制定状态；不含 CEO 决策材料。 */
export const MemberBattlefieldResponse = Type.Object({
  id: Type.String(), code: Type.String(), name: Type.String(), ownerId: Type.String(), ownerName: Type.String(),
  isDri: Type.Boolean(), period: onboardingWork.properties.period, serverNow: Type.String(),
  sixMonthOutcome: Type.String(), ...monthlyTarget,
  missionCards: Type.Array(Type.Object({
    cardId: Type.String(), ownerId: Type.String(), ownerName: Type.String(), roleLabel: Type.Union([Type.String(), Type.Null()]),
    missionCount: Type.Integer({ minimum: 0 }), feedbackCount: Type.Integer({ minimum: 0 }), status: Type.String(),
    canOpen: Type.Boolean(), href: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false })),
  myMissions: Type.Array(MissionCardPayload),
  round: Type.Union([MissionRoundSummary, Type.Null()]),
  confirmation: Type.Union([Type.Object({ byName: Type.String(), at: Type.String() }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });

export type TMemberWork = Static<typeof MemberWork>;
export type TMemberBattlefieldResponse = Static<typeof MemberBattlefieldResponse>;
