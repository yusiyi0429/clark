/**
 * 本机程序（apps/local）在网页这边的样子：真程序走 HTTP（client.ts），开发时可以换成按脚本吐事件的假程序（mock.ts）。
 * 接口和类型照 packages/contracts/src/localRunner.ts，两边不各写一份。
 */
import type {
  TLocalAgentKind, TLocalCloudLinkRequest, TLocalCloudLinkView, TLocalCreateSessionBatchResponse, TLocalCreateSessionRequest, TLocalFolder, TLocalHealthResponse, TLocalMergeResponse,
  TLocalModelProfile, TLocalModelProfileUpsert, TLocalTool, TLocalToolUpsert, TLocalPairingStartResponse, TLocalPairingStatusResponse,
  TLocalPermissionDecisionRequest, TLocalQuestionAnswerRequest, TLocalRunnerErrorCode, TLocalSendMessageRequest, TLocalSendMessageResponse, TLocalSessionDetailResponse,
  TLocalSessionEvent, TLocalSessionDraft, TLocalSessionSummary, TLocalSettings, TLocalSettingsPatch, TLocalStatusResponse, TLocalBudgetUpdateRequest, TLocalTaskBudgetView, TLocalAttachmentRef,
  TLocalFolderCreateRequest, TLocalFolderCreateResponse, TLocalFolderPickRequest, TLocalFolderPickResponse, TLocalScratchFolderRequest, TLocalScratchFolderResponse, TLocalSessionModelRequest, TLocalSessionModelResponse,
  TLocalSessionFileReadRequest, TLocalSessionFileReadResponse, TLocalSessionFilesResponse, TLocalSessionRestoreRequest, TLocalSessionRestoreResponse, TLocalFileChangesRequest, TLocalFileChangesResponse, TLocalFileChangesRestoreRequest, TLocalFileChangesRestoreResponse,
  TLocalHandoverCheck, TLocalProjectCloneRequest, TLocalProjectCloneResponse, TLocalProjectFolder, TLocalProjectFolderRequest, TLocalPermissionMode, TLocalRun, TLocalRunPreviewRequest,
  TLocalSourceListResponse, TLocalSourceCheckRequest, TLocalSourceCheckResponse, TLocalSourceAddRequest, TLocalSourceAddResponse,
} from "@warmap/contracts";

export type {
  TLocalCreateSessionRequest, TLocalFolder, TLocalHealthResponse, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry, TLocalRole, TLocalSessionEvent,
  TLocalSessionDraft, TLocalSessionStatus, TLocalSessionSummary, TLocalStatusResponse, TLocalUsage, TLocalWorkspace, TLocalMergeResponse, TLocalQuestion, TLocalQuestionRequestView,
  TLocalQuestionAnswerRequest, TLocalPermissionMode, TLocalRun, TLocalTool,
} from "@warmap/contracts";

/** 本机接口回的错：code 照契约；network 是连不上（没装、没开、浏览器没给访问本机的授权）。 */
export class LocalRunnerError extends Error {
  constructor(readonly code: TLocalRunnerErrorCode | "network", message: string, readonly status = 0) { super(message); }
}

/** 恢复一处时文件又变了（revision 对不上，第 72 条）。 */
export const fileChanged = (error: unknown) => error instanceof LocalRunnerError && error.code === "file_changed";

export type EventWatch = {
  /** 从这个序号之后补发（断线重连时带上收到的最后一个）。 */
  after: number;
  onEvent: (event: TLocalSessionEvent) => void;
  /**
   * 「正在写」的草稿（契约 LocalSessionDraft）：给了就带 ?drafts=1 要；text 是这一段到目前为止的全文，空串是清掉。
   * 老本机程序不认这个参数，照旧只推事件。
   */
  onDraft?: (draft: TLocalSessionDraft) => void;
  /** 事件流断了、正在重连（connected=false）或重新接上（true）。 */
  onLink?: (connected: boolean) => void;
  signal: AbortSignal;
};

/**
 * 本机程序收不收网页给的 messageId（子会话一按发送就先画那句话，事件流里同编号的 user_message 来了再换成真的）：health 的 protocol ≥ 2（契约 LOCAL_RUNNER_PROTOCOL）。
 * 老版本（protocol 1）的发话请求是 strict，带了整个请求回 400：不带、不先画，和原来一样。
 */
export const acceptsClientMessageId = (health: Pick<TLocalHealthResponse, "protocol">): boolean => health.protocol >= 2;
/** 本机程序收不收自由子会话（第 68 条，开工请求带 free）：protocol ≥ 4。老版本开工请求是 strict，带了整个 400。 */
export const acceptsFreeSession = (health: Pick<TLocalHealthResponse, "protocol">): boolean => health.protocol >= 4;
/** 本机程序收不收转话带的 agreementRevision（主循环第 60 条，卡的约定改了）：protocol ≥ 3；老版本带了整句 400，不带。 */
export const acceptsAgreementRevision = (health: Pick<TLocalHealthResponse, "protocol">): boolean => health.protocol >= 3;

export interface LocalRunner {
  readonly kind: "http" | "mock";
  /** 见 acceptsClientMessageId：读过 health 以后才知道；没读过当不收。 */
  readonly clientMessageIds?: boolean;
  /** 见 acceptsFreeSession：读过 health 以后才知道；没读过当不收。 */
  readonly freeSessions?: boolean;
  health(): Promise<TLocalHealthResponse>;
  startPairing(clientLabel: string): Promise<TLocalPairingStartResponse>;
  pairingStatus(pairingId: string): Promise<TLocalPairingStatusResponse>;
  unpair(): Promise<void>;
  status(): Promise<TLocalStatusResponse>;
  /** 登录执行方（不填是 Claude Code）：本机替本人开浏览器（D 契约 b28c1f12，Codex 也走这里，没有贴码）。 */
  login(agent?: TLocalAgentKind): Promise<void>;
  linkCloud(body: TLocalCloudLinkRequest): Promise<TLocalCloudLinkView>;
  patchSettings(patch: TLocalSettingsPatch): Promise<TLocalSettings>;
  listModels(): Promise<TLocalModelProfile[]>;
  putModel(id: string, body: TLocalModelProfileUpsert): Promise<TLocalModelProfile>;
  /** 连 TokenHub（17.2 第 51 条）：Key 直接交给本机，本机验过再存；回现在全部的模型配置。Key 不对 tokenhub_key_rejected，连不上 tokenhub_unreachable。 */
  connectTokenHub(apiKey: string): Promise<TLocalModelProfile[]>;
  /** 断开 TokenHub：本机删 Key 和连接时建的模型配置。 */
  disconnectTokenHub(): Promise<void>;
  /**
   * 添加来源（设计 17.2 第 52 条，契约 /v1/sources）：预设厂商和加好的来源；贴 Key 先认先验（不存）；加（同一个预设、种类、地区再加 = 换 Key、换模型）；删。
   * Key 只交给本机。老本机程序没有这几条（404、501），调用方当没有来源这回事。
   */
  listSources(): Promise<TLocalSourceListResponse>;
  checkSource(body: TLocalSourceCheckRequest): Promise<TLocalSourceCheckResponse>;
  addSource(body: TLocalSourceAddRequest): Promise<TLocalSourceAddResponse>;
  deleteSource(id: string): Promise<void>;
  /** 本人加的工具（给执行子会话挂的 HTTP MCP 服务器，存在本机）：列出、加或改（存完本机查一次连没连上）、移除、再查一次。钥匙只写不读。 */
  listTools(): Promise<TLocalTool[]>;
  putTool(id: string, body: TLocalToolUpsert): Promise<TLocalTool>;
  removeTool(id: string): Promise<void>;
  checkTool(id: string): Promise<TLocalTool>;
  listFolders(): Promise<TLocalFolder[]>;
  /** 本机弹系统窗口选文件夹（取消时 folder 为 null）；带 projectId 时选中后一步绑到这个项目，回执带 project（17.2 第 32 条）。 */
  pickFolder(body?: TLocalFolderPickRequest): Promise<TLocalFolderPickResponse>;
  /** 新建一个空文件夹（默认在桌面）并加进允许的；带 projectId 时一步绑上。重名 409，名字不合法 400（message 可直接给人看）。 */
  createFolder(body: TLocalFolderCreateRequest): Promise<TLocalFolderCreateResponse>;
  /** 「随手」项目的文件夹：本机在主目录/天枢/随手 建好、加进允许的、绑到项目；已经绑了文件夹的不换。老本机程序没有这条（404），调用方当没做成。 */
  scratchFolder(body: TLocalScratchFolderRequest): Promise<TLocalScratchFolderResponse>;
  removeFolder(id: string): Promise<void>;
  /** 在资源管理器中显示：本机按 id 查出路径用系统的文件管理器打开（只认允许的文件夹，没有回 404）。 */
  openFolder(id: string): Promise<void>;
  listSessions(): Promise<TLocalSessionSummary[]>;
  createSession(body: TLocalCreateSessionRequest): Promise<TLocalSessionSummary>;
  /** 一次开工多件：结果按请求顺序，有空位的马上开，满了的是 queued。 */
  createSessionBatch(items: TLocalCreateSessionRequest[]): Promise<TLocalCreateSessionBatchResponse["results"]>;
  getSession(id: string): Promise<TLocalSessionDetailResponse>;
  /** 说一句；kind=review 是专题开评审会（text 可不填）。 */
  /** attachments：云端存好的子会话附件（14.5），本机按 id 取回；只带附件时 text 可以是空的。 */
  /** messageId：网页给的这句话的编号（只在 clientMessageIds 时带）；没发成用同一个编号重发，本机按它去重。 */
  /** agreementRevision：云端登记的「约定改了」那句转话带的版本号，本机 protocol ≥ 3 才放进请求（见 acceptsAgreementRevision）。 */
  sendMessage(id: string, text: string, kind?: TLocalSendMessageRequest["kind"], attachments?: TLocalAttachmentRef[], messageId?: string, agreementRevision?: number): Promise<TLocalSendMessageResponse>;
  interrupt(id: string): Promise<TLocalSessionSummary>;
  /** 换这个子会话的权限模式（跑着也能换，下一步就按新的来）；执行方没有这一档 400、会话已结束 409。 */
  setPermissionMode(id: string, mode: TLocalPermissionMode): Promise<TLocalSessionSummary>;
  /** 子会话换模型（17.2 第 32 条）：applied=now 当场换，after_turn 这一轮做完再换（摘要带 pendingModel）。 */
  setSessionModel(id: string, body: TLocalSessionModelRequest): Promise<TLocalSessionModelResponse>;
  /** 本会话写过、改过的文件（17.2 第 41 条）；老版本没有这条路由（404）、还没实现（501）时调用方当没有。 */
  listSessionFiles(id: string): Promise<TLocalSessionFilesResponse>;
  /** 读本会话文件夹或工作树里的一个文件，在右边预览；在外面的 403，没有的 404。 */
  readSessionFile(id: string, body: TLocalSessionFileReadRequest): Promise<TLocalSessionFileReadResponse>;
  /** 把本会话动过的文件恢复到它第一次动之前（第 71 条）；paths 不给是全部。一轮正在跑、卡在工作树里做的 409。 */
  restoreSessionFiles(id: string, body: TLocalSessionRestoreRequest): Promise<TLocalSessionRestoreResponse>;
  /** 读一个文件的改动（第 72 条）：某一轮（turn，不给轮号是最近做完的一轮）或开工到现在（session）；工作树里的会话只有 session。 */
  readFileChanges(id: string, body: TLocalFileChangesRequest): Promise<TLocalFileChangesResponse>;
  /** 恢复其中几处（第 72 条），回新的读结果：一轮正在跑 409 conflict；revision 对不上见 fileChanged。 */
  restoreFileChanges(id: string, body: TLocalFileChangesRestoreRequest): Promise<TLocalFileChangesRestoreResponse>;
  kill(id: string): Promise<TLocalSessionSummary>;
  decidePermission(id: string, requestId: string, body: TLocalPermissionDecisionRequest): Promise<TLocalSessionSummary>;
  /** 把卡的分支合回主文件夹（本人点了才合）；合不了回原因和文件，卡不在工作树、还在跑、交回后又改过、已合过是 409。 */
  mergeSession(id: string): Promise<TLocalMergeResponse>;
  /** 回答执行方的提问：choices 是每个问题选中的选项，text 是另外写的话；已答或已作废是 409。 */
  answerQuestion(id: string, requestId: string, body: TLocalQuestionAnswerRequest): Promise<TLocalSessionSummary>;
  /** 停会话里的一个后台任务（子 agent、后台命令），会话本身不停；不在跑、进程已退出、没有这一项是 409。 */
  stopBackground(id: string, itemId: string): Promise<TLocalSessionSummary>;
  /** 压缩上下文（本人 11/18，上下文圆环点开「压缩」）：压完才回，摘要的 context 是压完的；一轮在跑、正在压、没压成是 409。 */
  compactSession(id: string): Promise<TLocalSessionSummary>;
  /** 开工前看这次会怎么跑：落到哪个来源的哪个模型（actual 为 null）。 */
  previewRun(body: TLocalRunPreviewRequest): Promise<TLocalRun>;
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
