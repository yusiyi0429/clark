import type { Api } from "./store";

/**
 * 谁能调这个方法。
 *
 * `both` 只给「问我是谁」这类无侧写的读口。没有 `public` 一档 —— `/api/data`
 * 本身就在门后面（`src/proxy.ts`）。
 */
export type Scope = "ceo" | "dri" | "both";

/** `today` 是常量不走 RPC（client.ts 里那一行注释），所以从键里排掉。 */
export type RpcMethod = Exclude<keyof Api, "today">;

/**
 * **标成 `Record<RpcMethod, Scope>` 是这张表的全部价值**：新加一个方法而忘了
 * 分类，`tsc` 直接报错 —— 和 `client.ts` 里 `const api: Api` 保证键覆盖是同一个
 * 机制。默认拒绝的写法（把没列出来的当 ceo）救不了这件事：它会让「忘了分类」
 * 变成一次静默的收紧，而下一次忘了分类的可能是个该给 DRI 的方法。
 *
 * DRI 能看到的边界沿用 HANDOFF §10「DRI 同步边界 = 分层」：自己域的 Commitment、
 * 派给自己的议题（交接包正文）、自己上报的那几条。看不到一号位的对谈记录、
 * 没勾进会议的条目、判断本体全貌。
 */
export const METHOD_SCOPE: Record<RpcMethod, Scope> = {
  // ---- 两边都要 ----
  getViewer: "both",

  // ---- DRI 侧（其余几个还没落地，见下面注释掉的两段） ----
  submitDriSignal: "dri",
  listMyReports: "dri",
  listMyDomainJudgments: "dri",
  listMyHandoffs: "dri",
  submitDriReport: "dri",
  listMyCommitments: "dri",
  submitCommitment: "dri",

  // ---- 一号位：Commitment 的裁决与签发 ----
  getCommitment: "ceo",
  adjudicateCommitment: "ceo",
  signCommitment: "ceo",

  // ---- 一号位：其余全部 ----
  resetDemo: "ceo",
  addStrategicIssue: "ceo",
  removeIssue: "ceo",
  listSensorTargets: "ceo",
  listTriggers: "ceo",
  getMonitorStrategy: "ceo",
  setMonitorFocus: "ceo",
  listPending: "ceo",
  listParked: "ceo",
  listSignalLog: "ceo",
  listInboxSignals: "ceo",
  listNominatedSignals: "ceo",
  getScanCadence: "ceo",
  disposeInboxSignal: "ceo",
  openIssueAnyway: "ceo",
  upgradeSignal: "ceo",
  startScan: "ceo",
  scanStatus: "ceo",
  listAgentRuns: "ceo",
  getAgentRun: "ceo",
  listIssueLog: "ceo",
  listWithheld: "ceo",
  reclaimWithheld: "ceo",
  listDris: "ceo",
  listDomains: "ceo",
  getIssueCounsel: "ceo",
  listReports: "ceo",
  getIssueKnowledge: "ceo",
  requestRework: "ceo",
  startPreResearch: "ceo",
  preResearchStatus: "ceo",
  getSignal: "ceo",
  listProbe: "ceo",
  assignIssue: "ceo",
  disposeCard: "ceo",
  listIssues: "ceo",
  addIssue: "ceo",
  renameIssue: "ceo",
  getIssue: "ceo",
  getTimeline: "ceo",
  getBoard: "ceo",
  confirmBoardJudgement: "ceo",
  judgementsStatus: "ceo",
  getResearchDoc: "ceo",
  deepResearchStatus: "ceo",
  startDeepResearch: "ceo",
  getAdvisorPreset: "ceo",
  listAdvisorMessages: "ceo",
  getSignalTranscript: "ceo",
  openSignalTurn: "ceo",
  recordSignalReply: "ceo",
  openAdvisorTurn: "ceo",
  recordAdvisorReply: "ceo",
  rateAdvisorMessage: "ceo",
  rateSignalMessage: "ceo",
  frameQuestion: "ceo",
  getFramedQuestion: "ceo",
  escalate: "ceo",
  advisorContext: "ceo",
  getTalkPoint: "ceo",
  proposeTalkPoint: "ceo",
  /*
   * 议事对话那几个写口标 `ceo` = **浏览器够得着**，这是一层取舍，写在这里免得下一个人
   * 以为它是疏漏：
   *
   * - `landTalkCandidate` 绕得过复核那道门。`settle.ts` 的口径是「复核过了才落」，而
   *   持一号位身份的浏览器可以直接把一条没过复核的候选抬上板、在链路上排一个待确认项。
   *   **这不是确认绕过**：落上去的那条仍是 `direction`，重开条件仍然一条都没布控，布控
   *   只发生在他按下确认那一下（`confirmCandidate`）。板上多一条没过复核的候选，和他
   *   自己在对谈里说一句判断，后果是同一档。
   * - `recordDeliberationEntry` 让让步日志这本账也是浏览器可写的（仍然过 `checkEntry`）。
   * - `landTalkEvidence` 同理，与仓库里既有那一批写口姿态一致。
   *
   * 维持现状的理由是这三个口的用户就是他本人，而这套门（`src/proxy.ts` + 这张表）分的是
   * 「一号位 / DRI」，不是「人 / 模型」。真要把「只有轮外结算落得了候选」变成机制，那是
   * 另一层东西（服务端自己的调用凭据），不是把这一行改成 `dri`。
   */
  recordDeliberationEntry: "ceo",
  listDeliberationLog: "ceo",
  recordEscalation: "ceo",
  landTalkEvidence: "ceo",
  /* 「查一下」那一颗由他自己按 —— 发起权在他手上，所以这个口就是给浏览器的。 */
  quickCheck: "ceo",
  landTalkCandidate: "ceo",
  confirmCandidate: "ceo",
  /*
   * 决断包这两口都是一号位的。批准是他本人按的那一下，没什么可犹豫的；
   * **命令板那一口读也不给 DRI**，理由和排会那一段一样：一份「谁欠着什么、哪几条到期了」
   * 的全局清单，在被派活的那一侧读到就是一份别人的进度表。DRI 该看到的是自己那几条，
   * 而那要走 `dri` 那一侧自己的口（还没有 —— 见 `approveCommandBrief` 头注释里那条欠账：
   * 通知 DRI 这一层整个没做）。
   */
  /*
   * 「进入行动整理」也是他本人的那一下 —— 它记的正是「一号位明确要把研究结论整理成
   * 行动」这件事，别人替他记等于替他授权（见 `store.enterActionStaging`）。
   */
  enterActionStaging: "ceo",
  approveCommandBrief: "ceo",
  listDecisionOrders: "ceo",
  getMeetingPrep: "ceo",
  startMeeting: "ceo",
  endMeeting: "ceo",
  getMeetingClosure: "ceo",
  getIssueMeeting: "ceo",
  /*
   * 排会与会后提炼整条都是一号位的：排哪天开会、哪几件凑一场、会后那几条要点算不算数，
   * 全是他的日程和他的判断。DRI 侧连读都不给 —— 一份「下周三要过的三件事」的清单，
   * 本身就是一次战略意图的泄露。
   */
  listSlots: "ceo",
  scheduleIssue: "ceo",
  joinSlot: "ceo",
  unscheduleIssue: "ceo",
  inviteDomain: "ceo",
  endMeetingSlot: "ceo",
  cancelMeetingSlot: "ceo",
  reorderAgenda: "ceo",
  ingestMeetingNotes: "ceo",
  slotIntakeState: "ceo",
  listDebriefs: "ceo",
  listActionItems: "ceo",
  updateDebrief: "ceo",
  toggleDebriefPoint: "ceo",
  updateDebriefPoint: "ceo",
  assignDebriefPoint: "ceo",
  confirmDebriefTodo: "ceo",
  updateDebriefTodoText: "ceo",
  getDebrief: "ceo",
  getDeployment: "ceo",
  confirmDebrief: "ceo",
  reopenDebrief: "ceo",
  toggleClosureItem: "ceo",
  updateClosureItem: "ceo",
  signClosure: "ceo",
  listQuickDecisions: "ceo",
  getBrief: "ceo",
  listDecisions: "ceo",
  getClosureDraft: "ceo",
  writeBackStatus: "ceo",
  startWriteBack: "ceo",
  confirmClosure: "ceo",
  submitRating: "ceo",
  getJudgment: "ceo",
  listDocs: "ceo",
  getDoc: "ceo",
  resolveCode: "ceo",
  codeIndex: "ceo",
  getOutcomes: "ceo",
  chatContext: "ceo",

  /*
   * 录音与逐字稿。**全是 ceo。**
   *
   * DRI 侧一条都不给：一场战略会的逐字稿里有别的域的议题、有还没定的判断、也有会上
   * 随口说的话。按域裁剪逐字稿是做不到的 —— 一句话属于哪个域要靠理解，而漏裁一句
   * 的代价是把一号位还没想定的东西透给了当事人。等真要给 DRI 看时，给的应该是提炼
   * 出来的那几条，不是原文。
   */
  listRecordings: "ceo",
  getRecording: "ceo",
  startRecording: "ceo",
  finishRecording: "ceo",
  renameRecording: "ceo",
  setRecordingParticipants: "ceo",
  renameRecordingSpeaker: "ceo",
  retryRecording: "ceo",
  removeRecording: "ceo",
};

export function scopeOf(method: string): Scope | null {
  return (METHOD_SCOPE as Record<string, Scope | undefined>)[method] ?? null;
}
