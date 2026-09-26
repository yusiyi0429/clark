import type { TPersonalMissionCardPayload } from "@warmap/contracts";

export const personalPayload = {
  round: { roundId: "round", period: "2026-10", battlefieldId: "01", battlefieldName: "灯塔项目", version: 1, phase: "open", round: 1,
    openedAt: "2026-10-01T00:00:00.000Z", closesAt: "2026-10-03T00:00:00.000Z", reviewAt: null, serverNow: "2026-10-01T00:00:00.000Z",
    approver: true, deciderName: "刘明华", todo: null, placeholder: true, goals: { sixMonthOutcome: "形成可复用的交付方式", monthOutcome: "跑通首次经营判断", signedAt: "2026-10-01T00:00:00.000Z" },
    counts: { cards: 1, feedback: 0, pending: 0, conflicts: 0, dependencies: 0, late: 0 }, cards: [{ cardId: "card", ownerId: "owner", ownerName: "白田田", roleLabel: "01-1 战役 DRI", missionCount: 1, line: "无意见", pending: 0, firstPendingFeedbackId: null, mine: true }] },
  card: { cardId: "card", ownerId: "owner", ownerName: "白田田", roleLabel: "01-1 战役 DRI", members: [], status: "草稿 · 讨论中", shown: "draft", missions: [{ missionId: "mission", version: 1, code: "bai-202610-1", period: "2026-10", title: "完善方法闭环", ownerId: "owner", ownerDisplayName: "白田田", capabilityId: "method", capabilityCode: "03", capabilityName: "Method", battlefieldIds: ["01"], battlefieldNames: ["灯塔项目"], why: "一个共同的依据", outcome: "形成可核验结果", successEvidence: ["证据一", "证据二"], boundaries: "包含方法核对", keyPath: "先核对再试用", milestones: ["待定 · 团队核对"], resources: "评审时间", dependencies: "产品协作", humanAgentSplit: "人确认，Agent 整理", risk: "信息不足及时升级", retrospect: "沉淀方法", placeholder: true, personalCard: { cardId: "card", roundId: "round", status: "open" }, sourceRef: "https://example.com/source", sourceDocumentId: "doc", sourceRevision: 9, sourceTitle: "沿用 9 月个人卡", changedFields: [] }] },
  feedback: [], confirmation: null,
} as TPersonalMissionCardPayload;
