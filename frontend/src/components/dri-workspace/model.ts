export type DriNoticeId = 'mission-review' | 'weekly-review' | 'ceo-return' | 'meeting';
export type MissionPriority = 'P0' | 'P1';
export type MissionReviewState = 'needs-review' | 'reviewed';
export type ReviewAnchor = 'outcome' | 'mission' | 'success-evidence' | 'milestone' | 'boundary';
export type WeeklySignal = 'green' | 'yellow' | 'red';
export type SourceState = 'read' | 'stale' | 'unavailable';

export type MissionDraft = {
  id: string;
  priority: MissionPriority;
  title: string;
  version: string;
  outcome: string;
  why: string;
  successEvidence: string[];
  milestones: Array<{ date: string; label: string; state: 'verified' | 'current' | 'later' }>;
  dependencies: string[];
  boundary: string[];
  reviewState: MissionReviewState;
};

export type ReviewComment = {
  id: string;
  authorName: string;
  body: string;
  anchor: ReviewAnchor;
  targetId: string;
  targetVersion: string;
  revision: number;
  state: 'published';
  createdAt: string;
};

export type ProgressSource = {
  id: string;
  label: string;
  detail: string;
  state: SourceState;
  observedAt: string;
};

export type ProgressQuestion = {
  id: string;
  prompt: string;
  reason: string;
  answer?: string;
};

export type SemanticDiff = {
  id: string;
  scope: string;
  kind: 'adjust' | 'add' | 'keep';
  before: string;
  after: string;
  rationale: string;
  source: string;
};

export type MeetingActionDraft = {
  id: string;
  text: string;
  ownerName?: string;
  due: string;
};

export type MeetingPublicationRoute = {
  actionNotifications: Array<MeetingActionDraft & { recipientName: string; fallbackToMeetingDri: boolean }>;
  ceoNotifications: Array<{ id: string; text: string; whyCeo: string }>;
};

export type DriWorkspaceCommand =
  | { type: 'review.comment.publish'; comment: ReviewComment }
  | { type: 'progress.sources.refresh'; actorId: string; missionIds: string[] }
  | { type: 'progress.weekly.confirm'; signal: WeeklySignal; answer: string }
  | { type: 'review.diff.respond'; diffIds: string[]; response: 'accept' | 'comment' }
  | { type: 'meeting.start'; meetingId: string; recordingRequested: true }
  | { type: 'meeting.finish'; meetingId: string; extractRequested: true }
  | { type: 'meeting.outcome.publish'; meetingId: string; route: MeetingPublicationRoute };

export type DriWorkspaceGateway = {
  dispatch(command: DriWorkspaceCommand): Promise<void>;
};

export function createReviewComment(input: {
  authorName: string;
  body: string;
  anchor: ReviewAnchor;
  targetId: string;
  targetVersion: string;
  previousComments: ReviewComment[];
  createdAt: string;
}): ReviewComment {
  const revisions = input.previousComments
    .filter((comment) => comment.targetId === input.targetId && comment.anchor === input.anchor)
    .map((comment) => comment.revision);
  return {
    id: `review-${input.targetId}-${input.previousComments.length + 1}`,
    authorName: input.authorName,
    body: input.body.trim(),
    anchor: input.anchor,
    targetId: input.targetId,
    targetVersion: input.targetVersion,
    revision: Math.max(0, ...revisions) + 1,
    state: 'published',
    createdAt: input.createdAt,
  };
}

export function unansweredProgressQuestions(questions: ProgressQuestion[]): ProgressQuestion[] {
  return questions.filter((question) => !question.answer?.trim());
}

export function routeMeetingPublication(
  actions: MeetingActionDraft[],
  ceoItems: Array<{ id: string; text: string; whyCeo: string }>,
  meetingDri: string,
): MeetingPublicationRoute {
  return {
    actionNotifications: actions.map((action) => ({
      ...action,
      recipientName: action.ownerName?.trim() || meetingDri,
      fallbackToMeetingDri: !action.ownerName?.trim(),
    })),
    ceoNotifications: ceoItems,
  };
}

export const driWorkspaceFixture = {
  actor: { id: 'dri-sun-mingze', name: '孙铭泽', role: '产品体验 DRI' },
  reviewWindow: {
    startsAt: '2026-09-13T18:00:00+08:00',
    endsAt: '2026-09-14T18:00:00+08:00',
    candidateVersion: '9 月候选集 · v3',
  },
  companyOutcome: {
    id: 'pco-2026-09',
    version: 'PCO · 2026.09 / v3',
    title: 'CEO Agent 与 DRI Agent 进入真实持续使用，共同形成 CEO → DRI 的人机经营闭环。',
    context: '由本月已核实的 LTCO 拆解；当前为 CEO 发出的候选版本，窗口关闭前只收集独立 Comments。',
  },
  personalAnchor: '把 CEO / DRI 与 Agent 之间的真实产品体验做出来，让 Agent 真正成为管理者日常工作的界面。',
  missions: [
    {
      id: 'mission-ceo-agent',
      priority: 'P0',
      title: 'CEO Agent 核心体验产品化与真实使用',
      version: 'Draft v3',
      outcome: '把 CEO Agent 从以 Chat 为主的形态推进为面向 CEO 真实工作的产品，核心场景、交互方式和前端体验真正过线并进入持续使用。',
      why: 'CEO 的真实工作不是持续使用聊天框，而是在有限时间内理解全局、被关键异常吸引、追问并形成判断。',
      successEvidence: [
        'CEO Agent 新交互和前端完成验收，连接后进入可持续使用状态。',
        '至少跑通一条真实工作路径：进入 → 理解异常 → 追问/研究 → 判断 → Decision 或正式讨论。',
        '真实使用记录、失败点和产品调整有留档；增加功能不作为完成证据。',
      ],
      milestones: [
        { date: '9/10–9/14', label: '核心交互验收与前端构建', state: 'current' },
        { date: '9/17–9/18', label: '前后端连接、上线与验收', state: 'later' },
        { date: '9/24–9/30', label: '基于 CEO 真实使用持续修正', state: 'later' },
      ],
      dependencies: ['刘人豪 · Agent 架构、Eval 与稳定后端', '明华 / CEO · 真实使用与过线判断'],
      boundary: ['不另建解耦工作台或底层质量体系。', '不以 Demo、页面数量或功能数量替代真实使用。', 'Agent 不替 CEO 自动确认正式 Decision。'],
      reviewState: 'reviewed',
    },
    {
      id: 'mission-dri-agent',
      priority: 'P1',
      title: 'DRI Agent V1 核心体验与真实验证',
      version: 'Draft v2',
      outcome: '形成管理者使用 Agent 的第一版核心工作体验，在真实 DRI 中验证，并与 M1B、经营协同和 ENO 共同支持 CEO → DRI 闭环。',
      why: '重点不是重新定义经营闭环，而是让 DRI 围绕自己的 Outcome / Mission，以更低负担推进问题、带回证据并更新判断。',
      successEvidence: [
        '形成单一、连贯的 DRI V1 工作路径并完成交互与前端验收。',
        '至少一位真实 DRI 用真实 Mission 完成一次推进与 Review。',
        'DRI 清楚何时与 Agent 对话，何时进入协同、会议或正式 Review。',
      ],
      milestones: [
        { date: '9/13–9/17', label: '交互设计验收与前端构建', state: 'current' },
        { date: '9/18–9/19', label: '前后端连接、上线与验收', state: 'later' },
        { date: '9/24–9/30', label: '真实 DRI 使用验证', state: 'later' },
      ],
      dependencies: ['白田田 · DRI 工作方法与验收口径', '陈溪南 · M1B 多人协同与持续承接', '于斯一 · 记忆、蒸馏、写入与读回'],
      boundary: ['不另建一套产品语言或 Action Item 中心。', '优先复用 CEO Agent 的共性能力。', 'P0 与 P1 冲突时，优先保证 CEO Agent 体验过线。'],
      reviewState: 'needs-review',
    },
  ] satisfies MissionDraft[],
  comments: [
    {
      id: 'review-mission-ceo-agent-1',
      authorName: '孙铭泽',
      body: '成功证据应继续强调真实使用路径和失败记录，不能把“前端完成”直接等同于体验过线。',
      anchor: 'success-evidence',
      targetId: 'mission-ceo-agent',
      targetVersion: 'Draft v3',
      revision: 1,
      state: 'published',
      createdAt: '2026-09-13T20:16:00+08:00',
    },
  ] satisfies ReviewComment[],
  weekly: {
    period: '9 月 7 日—11 日',
    signal: 'green' as WeeklySignal,
    headline: 'CEO 侧交互设计已初步敲定，下一步与 CEO 对齐后继续推进；当前尚未进入真实使用。',
    caveat: '绿色只代表当前阶段按计划推进，不表示月底 Mission 已达成。',
    advances: [
      'CEO 侧交互已从探索收敛为一版可供评审的可操作方案。',
      '下一节点已明确为 9 月 14 日与 CEO 对齐核心交互。',
    ],
    evidence: ['本周交互原型', '设计讨论记录', '9 月 Mission Card'],
    problem: '当前待完成的是设计对齐与验收；正式交互验收、前后端连接和真实使用均未提前计为完成。',
    implication: '本周无重大方向变化。继续保持 CEO Agent 为 P0、DRI Agent 为 P1，不因初步定稿扩大范围。',
    handling: '继续推进：先收口验收结论和必要修改，再进入连接与真实使用验证。',
    milestones: [
      { label: '交互方案可供评审', state: 'verified' as const, evidence: '原型与设计记录' },
      { label: 'CEO 对齐并形成验收结论', state: 'current' as const, evidence: '仍缺 CEO 确认记录' },
      { label: '前后端连接与上线', state: 'later' as const, evidence: '计划 9/17–9/18' },
      { label: '真实持续使用与修正', state: 'later' as const, evidence: '计划 9/24–9/30' },
    ],
    sources: [
      { id: 'source-mission', label: '9 月 Mission Card', detail: '读取 P0/P1、Success Evidence、Milestones 与 Boundary', state: 'read', observedAt: '18:32' },
      { id: 'source-weekly', label: '本周复盘', detail: '读取当前判断、Evidence、Why 与当前处理', state: 'read', observedAt: '18:32' },
      { id: 'source-codex', label: 'Codex 工作上下文', detail: '读取当前实现和验证记录；连接为页面接口', state: 'stale', observedAt: '昨天 22:10' },
    ] satisfies ProgressSource[],
    questions: [
      {
        id: 'question-ceo-review',
        prompt: '9 月 14 日与 CEO 的交互对齐是否已经形成明确验收结论？',
        reason: '现有来源只证明“已有可评审方案”，不能证明“已验收”。',
      },
    ] satisfies ProgressQuestion[],
  },
  semanticDiffs: [
    {
      id: 'diff-priority',
      scope: '两个 Mission / 优先级',
      kind: 'adjust',
      before: 'CEO Agent 与 DRI Agent 两条产品线并行推进。',
      after: 'P0：CEO Agent 核心体验真正过线；P1：复用同一产品语言，完成 DRI Agent V1 真实验证。',
      rationale: '避免月底两个方向都有产出，但 CEO Agent 仍然只有 Chat。',
      source: 'CEO Review · 刘明华 / Comment 01',
    },
    {
      id: 'diff-anchor',
      scope: '个人价值锚点',
      kind: 'adjust',
      before: '共同承担 CEO → DRI 经营闭环产品化。',
      after: '孙铭泽聚焦用户侧产品形态、核心场景、交互、前端产品化与真实使用验证。',
      rationale: '共同 Outcome 可以重叠，但结果不好时必须知道由谁修正哪一层。',
      source: 'CEO Review · 刘明华 / Comment 01',
    },
    {
      id: 'diff-boundary',
      scope: 'DRI Agent / Boundary',
      kind: 'add',
      before: '未明确。',
      after: '不另建产品语言、研究流水线或 Action Item 中心；优先复用 CEO Agent 共性能力。',
      rationale: 'DRI 侧是一种角色工作面，不是另一套后台产品。',
      source: 'CEO Review · 刘明华 / Comment 01',
    },
  ] satisfies SemanticDiff[],
  meeting: {
    id: 'meeting-september-product-review',
    time: '今天 16:30',
    title: 'CEO / DRI 核心体验对齐',
    leadDri: '孙铭泽',
    purpose: '收口核心交互的通过项、必要修改项和进入连接阶段的验收边界。',
    issues: ['当前交互是否已经形成稳定的 CEO / DRI 共性产品语言？', '哪些修改阻塞 9/17–9/18 的前后端连接？'],
    generatedSummary: '核心产品语言保持一致；DRI 侧去除独立后台感，以通知进入 Mission 工作面。',
    actions: [
      { id: 'meeting-action-1', text: '根据验收意见收口 DRI 交互并补齐验证记录', ownerName: '孙铭泽', due: '9/17' },
      { id: 'meeting-action-2', text: '确认 Comment 与 ReviewWindow 的接口契约', due: '9/18' },
    ] satisfies MeetingActionDraft[],
    ceoItems: [
      { id: 'ceo-strategy-1', text: 'CEO Agent P0 与 DRI Agent P1 的资源冲突是否需要调整本月范围？', whyCeo: '涉及本月 Outcome 和资源优先级。' },
    ],
  },
} as const;
