/**
 * 数据层的客户端契约。**每个方法都是 POST /api/data 的一层壳。**
 *
 * 这个文件的历史：它原来就是后端本身 —— 整个对象库活在浏览器内存里，刷新即清零。
 * 现在实现搬到了 `store.ts`（server-only），这里只剩转发。**`api` 的签名一个字
 * 没变，所以 70 处调用点和 ~40 处 useResource 全部不用改** —— 这正是原文件头
 * 承诺的「只改方法体」。
 *
 * 类型安全怎么保证：下面的 `api` 声明为 `Api`（= `typeof store.api`）。少一个方法、
 * 多一个方法、或者哪个签名对不上，`tsc` 直接报错。`import type` 在编译期就被抹掉，
 * 不会把 store.ts 和种子数据拖进浏览器 bundle。
 */

import type { Api } from "./store";

import { ApiError, TODAY } from "./shared";

/**
 * 权限被拒：屏幕上要显示「这个动作不在你这一侧」，但不许给重试按钮。
 * 必须继承 ApiError —— 视图层的 `instanceof ApiError` 分支依赖它。
 */
export class ForbiddenError extends ApiError {}

export {
  ApiError,
  COMMITMENT_RULING_LABEL,
  COMMITMENT_VERDICT_LABEL,
  PROBE_ROUTE_LABEL,
  ROUTE_LABEL,
  cardSourceLabel,
  evidenceActionLabel,
  evidenceActionsFor,
} from "./shared";

export type { Api } from "./store";

/**
 * 服务端出错时返回的形状。**`error` 永远是一句写给读的人的话** —— 服务端不把英文
 * JS 报错原文带出来（见 `api/data/route.ts` 那个 catch）。
 *
 * `kind` 只标一种：权限被拒。它要的显示方式不一样（没有重试按钮），别的都一样地
 * 把 `error` 摆上屏，所以不需要更多分类。
 */
type Failure = { ok: false; error: string; kind?: "forbidden" };
type Success = { ok: true; data: unknown };

const ENDPOINT = "/api/data";

async function post(method: string, args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args }),
      cache: "no-store",
    });
  } catch (err) {
    /*
     * 连不上服务。原文通常是一句英文的 `Failed to fetch` —— 那句话对读的人没有信息，
     * 所以它进 console（排查的人在那里看），屏幕上只出现「连不上」这个事实。
     * 带上方法名：一屏几块同时挂的时候，他至少知道是哪一块。
     */
    console.error(`[client] ${method} 连不上服务：`, err);
    throw new ApiError(`连不上服务，这一步没有发出去（${method}）。`);
  }

  let payload: Success | Failure;
  try {
    payload = (await res.json()) as Success | Failure;
  } catch {
    throw new ApiError(`服务返回的不是 JSON（${method}，HTTP ${res.status}）。`);
  }

  if (!payload.ok) {
    // 权限被拒单独抛 ForbiddenError：视图层会识别它并隐藏重试按钮 —— 重试改变不了
    // 权限判定的结果。它继承 ApiError，所以下面那条 instanceof 分支照样命中。
    if (payload.kind === "forbidden") throw new ForbiddenError(payload.error);
    /*
     * 剩下的一律 ApiError，**包括服务端意外出错那一档（500，没有 kind）**。
     *
     * 原来这一档抛的是普通 `Error`，于是视图层的 `e instanceof ApiError` 落到 else，
     * 屏幕上写成「可能是网络中断了」/「再点一次」—— 而网络好得很，再点一次也没用。
     * 2026-08-20 走查时撞到过一次：服务端 `TypeError` 崩了，屏幕上说网络断了。
     *
     * 服务端那一档自己已经写好了一句话（见 `api/data/route.ts`：原因进日志，不进这句），
     * 400 那几句参数错误也是中文的。这一层要做的只是别把它们扔掉。
     */
    throw new ApiError(payload.error);
  }
  return payload.data;
}

/**
 * 造一个转发方法并断言成契约里对应的那一项。
 *
 * 这里的 cast 只跳过「实现是否匹配签名」的检查 —— 实现是统一的透传，没什么可查的；
 * 真正要保证的是**键的覆盖**，那由下面 `const api: Api` 这个标注来管。
 */
function forward<K extends keyof Api>(name: K): Api[K] {
  return ((...args: unknown[]) => post(name as string, args)) as Api[K];
}

export const api: Api = {
  /** demo 的「今天」。同步读，所以不走 RPC —— 它是常量不是状态。 */
  today: TODAY,

  resetDemo: forward("resetDemo"),
  addStrategicIssue: forward("addStrategicIssue"),
  removeIssue: forward("removeIssue"),
  getViewer: forward("getViewer"),
  listSensorTargets: forward("listSensorTargets"),
  listTriggers: forward("listTriggers"),
  getMonitorStrategy: forward("getMonitorStrategy"),
  setMonitorFocus: forward("setMonitorFocus"),
  listPending: forward("listPending"),
  listParked: forward("listParked"),
  listSignalLog: forward("listSignalLog"),
  listInboxSignals: forward("listInboxSignals"),
  listNominatedSignals: forward("listNominatedSignals"),
  getScanCadence: forward("getScanCadence"),
  disposeInboxSignal: forward("disposeInboxSignal"),
  openIssueAnyway: forward("openIssueAnyway"),
  upgradeSignal: forward("upgradeSignal"),
  submitDriSignal: forward("submitDriSignal"),
  listMyReports: forward("listMyReports"),
  listMyDomainJudgments: forward("listMyDomainJudgments"),
  listMyHandoffs: forward("listMyHandoffs"),
  submitDriReport: forward("submitDriReport"),
  listMyCommitments: forward("listMyCommitments"),
  submitCommitment: forward("submitCommitment"),
  getCommitment: forward("getCommitment"),
  adjudicateCommitment: forward("adjudicateCommitment"),
  signCommitment: forward("signCommitment"),
  startScan: forward("startScan"),
  scanStatus: forward("scanStatus"),
  // 只有读方法过桥。写 Run 记录的 `agentRunPut` 不在 `api` 上，浏览器打不到。
  listAgentRuns: forward("listAgentRuns"),
  getAgentRun: forward("getAgentRun"),
  listIssueLog: forward("listIssueLog"),
  listWithheld: forward("listWithheld"),
  reclaimWithheld: forward("reclaimWithheld"),
  listDris: forward("listDris"),
  listDomains: forward("listDomains"),
  getIssueCounsel: forward("getIssueCounsel"),
  listReports: forward("listReports"),
  getIssueKnowledge: forward("getIssueKnowledge"),
  requestRework: forward("requestRework"),
  startPreResearch: forward("startPreResearch"),
  preResearchStatus: forward("preResearchStatus"),
  getSignal: forward("getSignal"),
  listProbe: forward("listProbe"),
  assignIssue: forward("assignIssue"),
  disposeCard: forward("disposeCard"),
  listIssues: forward("listIssues"),
  addIssue: forward("addIssue"),
  renameIssue: forward("renameIssue"),
  getIssue: forward("getIssue"),
  getTimeline: forward("getTimeline"),
  getBoard: forward("getBoard"),
  confirmBoardJudgement: forward("confirmBoardJudgement"),
  judgementsStatus: forward("judgementsStatus"),
  getResearchDoc: forward("getResearchDoc"),
  deepResearchStatus: forward("deepResearchStatus"),
  startDeepResearch: forward("startDeepResearch"),
  getAdvisorPreset: forward("getAdvisorPreset"),
  listAdvisorMessages: forward("listAdvisorMessages"),
  getSignalTranscript: forward("getSignalTranscript"),
  openSignalTurn: forward("openSignalTurn"),
  recordSignalReply: forward("recordSignalReply"),
  openAdvisorTurn: forward("openAdvisorTurn"),
  recordAdvisorReply: forward("recordAdvisorReply"),
  rateAdvisorMessage: forward("rateAdvisorMessage"),
  rateSignalMessage: forward("rateSignalMessage"),
  frameQuestion: forward("frameQuestion"),
  getFramedQuestion: forward("getFramedQuestion"),
  escalate: forward("escalate"),
  advisorContext: forward("advisorContext"),
  getTalkPoint: forward("getTalkPoint"),
  proposeTalkPoint: forward("proposeTalkPoint"),
  recordDeliberationEntry: forward("recordDeliberationEntry"),
  listDeliberationLog: forward("listDeliberationLog"),
  recordEscalation: forward("recordEscalation"),
  landTalkEvidence: forward("landTalkEvidence"),
  quickCheck: forward("quickCheck"),
  landTalkCandidate: forward("landTalkCandidate"),
  confirmCandidate: forward("confirmCandidate"),
  enterActionStaging: forward("enterActionStaging"),
  approveCommandBrief: forward("approveCommandBrief"),
  listDecisionOrders: forward("listDecisionOrders"),
  getMeetingPrep: forward("getMeetingPrep"),
  startMeeting: forward("startMeeting"),
  endMeeting: forward("endMeeting"),
  getMeetingClosure: forward("getMeetingClosure"),
  getIssueMeeting: forward("getIssueMeeting"),
  listSlots: forward("listSlots"),
  scheduleIssue: forward("scheduleIssue"),
  joinSlot: forward("joinSlot"),
  unscheduleIssue: forward("unscheduleIssue"),
  inviteDomain: forward("inviteDomain"),
  endMeetingSlot: forward("endMeetingSlot"),
  cancelMeetingSlot: forward("cancelMeetingSlot"),
  reorderAgenda: forward("reorderAgenda"),
  ingestMeetingNotes: forward("ingestMeetingNotes"),
  slotIntakeState: forward("slotIntakeState"),
  listDebriefs: forward("listDebriefs"),
  listActionItems: forward("listActionItems"),
  updateDebrief: forward("updateDebrief"),
  toggleDebriefPoint: forward("toggleDebriefPoint"),
  updateDebriefPoint: forward("updateDebriefPoint"),
  assignDebriefPoint: forward("assignDebriefPoint"),
  confirmDebriefTodo: forward("confirmDebriefTodo"),
  updateDebriefTodoText: forward("updateDebriefTodoText"),
  getDebrief: forward("getDebrief"),
  getDeployment: forward("getDeployment"),
  confirmDebrief: forward("confirmDebrief"),
  reopenDebrief: forward("reopenDebrief"),
  toggleClosureItem: forward("toggleClosureItem"),
  updateClosureItem: forward("updateClosureItem"),
  signClosure: forward("signClosure"),
  listQuickDecisions: forward("listQuickDecisions"),
  getBrief: forward("getBrief"),
  listDecisions: forward("listDecisions"),
  getClosureDraft: forward("getClosureDraft"),
  writeBackStatus: forward("writeBackStatus"),
  startWriteBack: forward("startWriteBack"),
  confirmClosure: forward("confirmClosure"),
  submitRating: forward("submitRating"),
  getJudgment: forward("getJudgment"),
  listDocs: forward("listDocs"),
  getDoc: forward("getDoc"),
  resolveCode: forward("resolveCode"),
  codeIndex: forward("codeIndex"),
  getOutcomes: forward("getOutcomes"),
  chatContext: forward("chatContext"),

  /*
   * 录音与逐字稿。**二进制不在这里** —— 收分片、收上传、发音频、下载 txt 走
   * `/api/recordings/*` 那几条 REST（理由同 `/api/meeting/audio` 顶上那段）。
   */
  listRecordings: forward("listRecordings"),
  getRecording: forward("getRecording"),
  startRecording: forward("startRecording"),
  finishRecording: forward("finishRecording"),
  renameRecording: forward("renameRecording"),
  setRecordingParticipants: forward("setRecordingParticipants"),
  renameRecordingSpeaker: forward("renameRecordingSpeaker"),
  retryRecording: forward("retryRecording"),
  removeRecording: forward("removeRecording"),
};
