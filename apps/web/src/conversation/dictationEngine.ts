/**
 * 一次听写的「引擎」：采音、直连腾讯实时识别、断线重连、退回火山「录完再转」。不依赖 React，依赖全部注入（可单测）。
 *
 * 流程（调研 §5.1、§6）：
 * 1. 点麦克风：同时请求麦克风和签名地址（POST /api/me/dictation/session，不带 body）。AudioContext 在点击这一下就建好
 *    （否则权限弹窗停久了，浏览器会把它挂起）。
 * 2. 采到的音频都进内存（PcmStore）；握手（第一条 code:0）之前先攒着，握手后一次补发；之后每满 200ms 发一包。
 *    发包走令牌桶，最快 2 倍实时（腾讯 1 秒内收到超过 3 秒音频会报 4000）。
 * 3. ■ / ↑：先归还麦克风，把不满 200ms 的尾巴发掉，再发 {"type":"end"}，等 final（≤1.5s，实测 50–100ms）。
 *    收到 final 就算成功，之后的 1006 关闭和 error 一律不管。
 * 4. 出错按 decideFailure 的表走：重连一次（新地址、新 voice_id，补发「上一句定稿之后」的音频），或者这次改成
 *    「录完再转」：把那段 PCM 封成 WAV 传给 /api/me/dictation（火山极速版）。
 */

import { decideFailure, parseAsrMessage, type FailureStage } from "./dictationAsr";
import { encodeWav, MAX_DICTATION_SAMPLES, PACKET_SAMPLES, Pacer, PcmStore, Resampler16k, rmsLevel, TARGET_RATE } from "./dictationAudio";

export type SocketLike = {
  binaryType: string;
  send(data: ArrayBuffer | string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
};

/** 采音：点击这一下同步建好（AudioContext），拿到麦克风后再接上。 */
export type CaptureLike = {
  attach(stream: MediaStream, onFrame: (frame: Float32Array, sampleRate: number) => void): Promise<void>;
  close(): void;
};

export type EngineDeps = {
  fetch: typeof fetch;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createCapture(): CaptureLike;
  createSocket(url: string): SocketLike;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type EngineEvents = {
  /** 一句识别结果（key 在这次听写里唯一）。 */
  slice(key: string, text: string, stable: boolean): void;
  /** 去掉还没定稿、符合条件的句子（它们会被重新识别）。 */
  drop(match: (key: string) => boolean): void;
  /** 每 40ms 一次：这一帧的音量、已录秒数。 */
  level(level: number, seconds: number): void;
  /** 提示一次（改成「录完再转」等）。 */
  notice(text: string): void;
  /** 录满 5 分钟。 */
  limit(): void;
  /** realtime：边说边出字；batch：说完再转。 */
  mode(mode: "realtime" | "batch"): void;
};

export type StartOutcome = "ok" | "denied" | "unsupported" | "cancelled";
export type StopResult = { error?: string };

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};
const HANDSHAKE_TIMEOUT_MS = 5000;
const FINAL_TIMEOUT_MS = 1500;
/** 握手前缓冲可一次冲出去的量：0.8 秒（之后按 2 倍实时，任意 1 秒内都不超过 3 秒音频）。 */
const BURST_SAMPLES = Math.round(0.8 * TARGET_RATE);
/** 后备：短于 0.3 秒的录音不上传。 */
const MIN_BATCH_SAMPLES = Math.round(0.3 * TARGET_RATE);

/** 本页额度用完 / 没配置之后不再试腾讯（4004 / 4005 / 503）。 */
let realtimeDisabled = false;
export function resetRealtimeAvailability() {
  realtimeDisabled = false;
}

type Grant = { ok: true; url: string } | { ok: false; status: number };

type Connection = {
  gen: number;
  socket: SocketLike | null;
  /** 这条连接的音频从这个样本下标开始（end_time 相对于它）。 */
  offset: number;
  sentUntil: number;
  handshook: boolean;
  endSent: boolean;
  dead: boolean;
  timer: unknown;
  ready: Promise<boolean>;
  done: Promise<"final" | "dead">;
  resolveReady(ok: boolean): void;
  resolveDone(outcome: "final" | "dead"): void;
};

export class DictationEngine {
  private readonly store = new PcmStore();
  private readonly pacer: Pacer;
  private resampler: Resampler16k | null = null;
  private capture: CaptureLike | null = null;
  private stream: MediaStream | null = null;
  private mode: "realtime" | "batch";
  private conn: Connection | null = null;
  private generation = 0;
  private reconnected = false;
  /** 已定稿句子覆盖到的样本下标：重连从这里补发，后备从这里开始转。 */
  private lastStableEnd = 0;
  private batchFrom = 0;
  private draining = false;
  private pumpTimer: unknown = null;
  private stopped = false;
  private cancelled = false;
  private limited = false;

  constructor(
    private readonly deps: EngineDeps,
    private readonly events: EngineEvents,
  ) {
    this.pacer = new Pacer(() => deps.now(), BURST_SAMPLES);
    this.mode = realtimeDisabled ? "batch" : "realtime";
  }

  get realtime(): boolean {
    return this.mode === "realtime";
  }

  async start(): Promise<StartOutcome> {
    let capture: CaptureLike;
    try {
      capture = this.deps.createCapture();
    } catch {
      return "unsupported";
    }
    this.capture = capture;
    const grant = this.mode === "realtime" ? this.requestSession() : null;
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(MIC_CONSTRAINTS);
    } catch {
      this.release();
      return this.cancelled ? "cancelled" : "denied";
    }
    // 权限弹窗还开着时按了 ✕ 或离开了：迟到的授权也立即归还麦克风。
    if (this.cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      this.release();
      return "cancelled";
    }
    this.stream = stream;
    try {
      await capture.attach(stream, (frame, rate) => this.onFrame(frame, rate));
    } catch {
      this.release();
      return this.cancelled ? "cancelled" : "unsupported";
    }
    if (this.cancelled) {
      this.release();
      return "cancelled";
    }
    if (grant) void this.connect(grant);
    else this.events.mode("batch");
    return "ok";
  }

  private requestSession(): Promise<Grant> {
    return this.deps
      .fetch("/api/me/dictation/session", { method: "POST" })
      .then(async (response): Promise<Grant> => {
        if (!response.ok) return { ok: false, status: response.status };
        const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
        return typeof body?.url === "string" && body.url.startsWith("wss://") ? { ok: true, url: body.url } : { ok: false, status: 502 };
      })
      .catch((): Grant => ({ ok: false, status: 0 }));
  }

  private async connect(grantPromise: Promise<Grant>) {
    let resolveReady!: (ok: boolean) => void;
    let resolveDone!: (outcome: "final" | "dead") => void;
    const conn: Connection = {
      gen: ++this.generation,
      socket: null,
      offset: this.lastStableEnd,
      sentUntil: this.lastStableEnd,
      handshook: false,
      endSent: false,
      dead: false,
      timer: null,
      ready: new Promise<boolean>((resolve) => (resolveReady = resolve)),
      done: new Promise<"final" | "dead">((resolve) => (resolveDone = resolve)),
      resolveReady: (ok) => resolveReady(ok),
      resolveDone: (outcome) => resolveDone(outcome),
    };
    this.conn = conn;
    const grant = await grantPromise;
    if (this.conn !== conn || this.cancelled) return;
    if (!grant.ok) return this.fail(conn, "session", { status: grant.status });
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(grant.url);
    } catch {
      return this.fail(conn, "handshake", {});
    }
    conn.socket = socket;
    socket.binaryType = "arraybuffer";
    conn.timer = this.deps.setTimeout(() => {
      if (!conn.handshook) this.fail(conn, "handshake", {});
    }, HANDSHAKE_TIMEOUT_MS);
    socket.onmessage = (event) => this.onMessage(conn, event.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (!conn.dead) this.fail(conn, conn.handshook ? "streaming" : "handshake", {});
    };
  }

  private onMessage(conn: Connection, data: unknown) {
    if (conn.dead || this.cancelled) return;
    const message = parseAsrMessage(data);
    if (!message) return;
    if (message.code !== 0) return this.fail(conn, conn.handshook ? "streaming" : "handshake", { code: message.code });
    if (!conn.handshook) {
      conn.handshook = true;
      this.deps.clearTimeout(conn.timer);
      // 重连成功：上一条连接没定稿的那句会在新连接里重新识别，旧的去掉。
      if (conn.gen > 1) this.events.drop((key) => key.split(":")[0] !== String(conn.gen));
      this.events.mode("realtime");
      conn.resolveReady(true);
      this.pump();
    }
    if (message.slice) {
      const { index, type, text, endMs } = message.slice;
      this.events.slice(`${conn.gen}:${index}`, text, type === 2);
      if (type === 2) this.lastStableEnd = Math.max(this.lastStableEnd, conn.offset + Math.round(endMs * (TARGET_RATE / 1000)));
    }
    if (message.final) {
      this.closeConnection(conn);
      conn.resolveDone("final");
    }
  }

  private closeConnection(conn: Connection) {
    conn.dead = true;
    this.deps.clearTimeout(conn.timer);
    const socket = conn.socket;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* 已经断了 */
    }
  }

  private fail(conn: Connection, stage: FailureStage, detail: { code?: number; status?: number }) {
    if (conn !== this.conn || conn.dead || this.cancelled) return;
    this.closeConnection(conn);
    const decision = decideFailure({ stage, ...detail, reconnected: this.reconnected });
    if (decision.disableRealtime) realtimeDisabled = true;
    if (decision.action === "reconnect") {
      this.reconnected = true;
      void this.connect(this.requestSession());
      conn.resolveReady(false);
      conn.resolveDone("dead");
      return;
    }
    this.mode = "batch";
    this.batchFrom = this.lastStableEnd;
    this.conn = null;
    if (decision.notice) this.events.notice(decision.notice);
    this.events.mode("batch");
    conn.resolveReady(false);
    conn.resolveDone("dead");
  }

  private onFrame(frame: Float32Array, sampleRate: number) {
    if (this.stopped || this.cancelled) return;
    this.resampler ??= new Resampler16k(sampleRate);
    const pcm = this.resampler.push(frame);
    const room = MAX_DICTATION_SAMPLES - this.store.length;
    if (room > 0) this.store.append(room >= pcm.length ? pcm : pcm.subarray(0, room));
    this.events.level(rmsLevel(frame), this.store.length / TARGET_RATE);
    this.pump();
    if (this.store.length >= MAX_DICTATION_SAMPLES && !this.limited) {
      this.limited = true;
      this.events.limit();
    }
  }

  private pump() {
    const conn = this.conn;
    if (!conn || !conn.handshook || conn.dead || !conn.socket || conn.endSent) return;
    for (;;) {
      const available = this.store.length - conn.sentUntil;
      const size = Math.min(PACKET_SAMPLES, available);
      if (size <= 0 || (size < PACKET_SAMPLES && !this.draining)) break;
      if (!this.pacer.take(size)) {
        if (this.pumpTimer === null) {
          this.pumpTimer = this.deps.setTimeout(() => {
            this.pumpTimer = null;
            this.pump();
          }, this.pacer.waitFor(size));
        }
        return;
      }
      conn.socket.send(this.store.slice(conn.sentUntil, conn.sentUntil + size).buffer as ArrayBuffer);
      conn.sentUntil += size;
    }
    if (this.draining && conn.sentUntil >= this.store.length) {
      conn.endSent = true;
      conn.socket.send(JSON.stringify({ type: "end" }));
    }
  }

  private release() {
    try {
      this.capture?.close();
    } catch {
      /* 已经关了 */
    }
    this.capture = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private wait<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = this.deps.setTimeout(() => resolve(fallback), ms);
      void promise.then((value) => {
        this.deps.clearTimeout(timer);
        resolve(value);
      });
    });
  }

  /** ■ / ↑：归还麦克风，收尾。实时识别正常结束时文字已经通过 events.slice 送完；后备时这里上传、转好再送。 */
  async stop(): Promise<StopResult> {
    if (this.stopped) return {};
    this.stopped = true;
    this.release();
    for (let guard = 0; guard < 4 && this.mode === "realtime" && this.conn && !this.cancelled; guard++) {
      const conn = this.conn;
      if (!conn.handshook) {
        const ok = await this.wait(conn.ready, 3000, false);
        if (!ok && this.conn === conn) this.fail(conn, "handshake", {});
        continue;
      }
      this.draining = true;
      this.pump();
      const drainMs = Math.max(0, this.store.length - conn.sentUntil) / ((2 * TARGET_RATE) / 1000);
      const outcome = await this.wait(conn.done, FINAL_TIMEOUT_MS + drainMs, "timeout" as const);
      if (outcome === "final") return {};
      if (outcome === "timeout") {
        // 1.5 秒没等到 final：非稳态按现在的样子收下，关掉连接。
        this.closeConnection(conn);
        this.conn = null;
        return {};
      }
    }
    if (this.cancelled) return {};
    if (this.mode === "batch") return this.transcribeBatch();
    return {};
  }

  private async transcribeBatch(): Promise<StopResult> {
    const pcm = this.store.slice(this.batchFrom);
    if (pcm.length < MIN_BATCH_SAMPLES) return {};
    const form = new FormData();
    form.append("audio", new Blob([encodeWav(pcm)], { type: "audio/wav" }), "dictation.wav");
    const response = await this.deps.fetch("/api/me/dictation", { method: "POST", body: form }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as { text?: string; message?: string } | undefined;
    if (this.cancelled) return {};
    if (!response?.ok) return { error: body?.message ?? "没转成文字，请检查网络后再说一次。" };
    const text = body?.text?.trim() ?? "";
    if (text) {
      this.events.drop(() => true);
      this.events.slice(`batch:${this.generation}`, text, true);
    }
    return {};
  }

  /** ✕ / Esc / 离开页面：什么都不要了，立刻归还麦克风。 */
  cancel() {
    this.cancelled = true;
    this.stopped = true;
    if (this.pumpTimer !== null) this.deps.clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      this.closeConnection(conn);
      conn.resolveReady(false);
      conn.resolveDone("dead");
    }
    this.release();
  }
}
