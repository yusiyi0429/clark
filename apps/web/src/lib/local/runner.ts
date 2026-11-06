/**
 * 本机程序（apps/local）在网页这边的样子：真程序走 HTTP（client.ts），开发时可以换成按脚本吐事件的假程序（mock.ts）。
 * 接口和类型照 packages/contracts/src/localRunner.ts，两边不各写一份。
 */
import type {
  TLocalCloudLinkRequest, TLocalCloudLinkView, TLocalCreateSessionRequest, TLocalFolder, TLocalHealthResponse,
  TLocalModelProfile, TLocalModelProfileUpsert, TLocalPairingStartResponse, TLocalPairingStatusResponse,
  TLocalPermissionDecisionRequest, TLocalRunnerErrorCode, TLocalSendMessageResponse, TLocalSessionDetailResponse,
  TLocalSessionEvent, TLocalSessionSummary, TLocalSettings, TLocalSettingsPatch, TLocalStatusResponse,
} from "@warmap/contracts";

export type {
  TLocalFolder, TLocalHealthResponse, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry, TLocalSessionEvent,
  TLocalSessionStatus, TLocalSessionSummary, TLocalStatusResponse, TLocalUsage,
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
  getSession(id: string): Promise<TLocalSessionDetailResponse>;
  sendMessage(id: string, text: string): Promise<TLocalSendMessageResponse>;
  interrupt(id: string): Promise<TLocalSessionSummary>;
  kill(id: string): Promise<TLocalSessionSummary>;
  decidePermission(id: string, requestId: string, body: TLocalPermissionDecisionRequest): Promise<TLocalSessionSummary>;
  /** 读一个会话的事件流，断了自己重连（带 Last-Event-ID），直到 signal 中止。 */
  watch(id: string, watch: EventWatch): Promise<void>;
}
