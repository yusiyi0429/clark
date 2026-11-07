/**
 * 本机程序（apps/local）在网页这边的样子：真程序走 HTTP（client.ts），开发时可以换成按脚本吐事件的假程序（mock.ts）。
 * 接口和类型照 packages/contracts/src/localRunner.ts，两边不各写一份。
 */
import type {
  TLocalCloudLinkRequest, TLocalCloudLinkView, TLocalCreateSessionBatchResponse, TLocalCreateSessionRequest, TLocalFolder, TLocalHealthResponse, TLocalMergeResponse,
  TLocalModelProfile, TLocalModelProfileUpsert, TLocalPairingStartResponse, TLocalPairingStatusResponse,
  TLocalPermissionDecisionRequest, TLocalQuestionAnswerRequest, TLocalRunnerErrorCode, TLocalSendMessageRequest, TLocalSendMessageResponse, TLocalSessionDetailResponse,
  TLocalSessionEvent, TLocalSessionSummary, TLocalSettings, TLocalSettingsPatch, TLocalStatusResponse, TLocalBudgetUpdateRequest, TLocalTaskBudgetView, TLocalAttachmentRef,
  TLocalHandoverCheck, TLocalProjectCloneRequest, TLocalProjectCloneResponse, TLocalProjectFolder, TLocalProjectFolderRequest,
} from "@warmap/contracts";

export type {
  TLocalCreateSessionRequest, TLocalFolder, TLocalHealthResponse, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry, TLocalRole, TLocalSessionEvent,
  TLocalSessionStatus, TLocalSessionSummary, TLocalStatusResponse, TLocalUsage, TLocalWorkspace, TLocalMergeResponse, TLocalQuestion, TLocalQuestionRequestView,
  TLocalQuestionAnswerRequest,
} from "@warmap/contracts";

/** 本机接口回的错：code 照契约；network 是连不上（没装、没开、浏览器没给访问本机的授权）。 */
export class LocalRunnerError extends Error {
  constructor(readonly code: TLocalRunnerErrorCode | "network", message: string, readonly status = 0) { super(message); }
}

export type EventWatch = {
  /** 从这个序号之后补发（断线重连时带上收到的最后一个）。 */
  after: number;
  onEvent: (event: TLocalSessionEvent) => void;
  /** 事件流断了、正在重连（connected=false）或重新接上（true）。 */
  onLink?: (connected: boolean) => void;
  signal: AbortSignal;
};

export interface LocalRunner {
  readonly kind: "http" | "mock";
  health(): Promise<TLocalHealthResponse>;
  startPairing(clientLabel: string): Promise<TLocalPairingStartResponse>;
  pairingStatus(pairingId: string): Promise<TLocalPairingStatusResponse>;
  unpair(): Promise<void>;
  status(): Promise<TLocalStatusResponse>;
  login(): Promise<void>;
  linkCloud(body: TLocalCloudLinkRequest): Promise<TLocalCloudLinkView>;
  patchSettings(patch: TLocalSettingsPatch): Promise<TLocalSettings>;
  listModels(): Promise<TLocalModelProfile[]>;
  putModel(id: string, body: TLocalModelProfileUpsert): Promise<TLocalModelProfile>;
  listFolders(): Promise<TLocalFolder[]>;
  pickFolder(): Promise<TLocalFolder | null>;
  removeFolder(id: string): Promise<void>;
  listSessions(): Promise<TLocalSessionSummary[]>;
  createSession(body: TLocalCreateSessionRequest): Promise<TLocalSessionSummary>;
  /** 一次开工多件：结果按请求顺序，有空位的马上开，满了的是 queued。 */
  createSessionBatch(items: TLocalCreateSessionRequest[]): Promise<TLocalCreateSessionBatchResponse["results"]>;
  getSession(id: string): Promise<TLocalSessionDetailResponse>;
  /** 说一句；kind=review 是专题开评审会（text 可不填）。 */
  /** attachments：云端存好的子会话附件（14.5），本机按 id 取回；只带附件时 text 可以是空的。 */
  sendMessage(id: string, text: string, kind?: TLocalSendMessageRequest["kind"], attachments?: TLocalAttachmentRef[]): Promise<TLocalSendMessageResponse>;
  interrupt(id: string): Promise<TLocalSessionSummary>;
  kill(id: string): Promise<TLocalSessionSummary>;
  decidePermission(id: string, requestId: string, body: TLocalPermissionDecisionRequest): Promise<TLocalSessionSummary>;
  /** 把卡的分支合回主文件夹（本人点了才合）；合不了回原因和文件，卡不在工作树、还在跑、交回后又改过、已合过是 409。 */
  mergeSession(id: string): Promise<TLocalMergeResponse>;
  /** 回答执行方的提问：choices 是每个问题选中的选项，text 是另外写的话；已答或已作废是 409。 */
  answerQuestion(id: string, requestId: string, body: TLocalQuestionAnswerRequest): Promise<TLocalSessionSummary>;
  /** 停会话里的一个后台任务（子 agent、后台命令），会话本身不停；不在跑、进程已退出、没有这一项是 409。 */
  stopBackground(id: string, itemId: string): Promise<TLocalSessionSummary>;
  /** 改一件 Task 的预算（先存天枢再交给本机）：用完停着等的马上接着做。 */
  putBudget(body: TLocalBudgetUpdateRequest): Promise<TLocalTaskBudgetView>;
  /** 项目在这台电脑上绑的文件夹（16.6）：列出、绑上或解绑（folderId 为 null）。 */
  listProjects(): Promise<TLocalProjectFolder[]>;
  putProjectFolder(projectId: string, body: TLocalProjectFolderRequest): Promise<TLocalProjectFolder>;
  /** 准备交接时看项目绑的文件夹现在什么样（16.7，只看 git）。 */
  handoverCheck(projectId: string): Promise<TLocalHandoverCheck>;
  /** 接手以后「拉到这台电脑」：本机弹框选位置、clone、切交接分支、绑到项目；本人点了取消时 project 为 null。 */
  cloneProject(projectId: string, body: TLocalProjectCloneRequest): Promise<TLocalProjectCloneResponse>;
  /** 读一个会话的事件流，断了自己重连（带 Last-Event-ID），直到 signal 中止。 */
  watch(id: string, watch: EventWatch): Promise<void>;
}
