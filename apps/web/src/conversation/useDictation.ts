"use client";

/**
 * 输入框听写（腾讯实时识别 + 快速整理；设计稿 docs/superpowers/specs/2026-10-10-realtime-dictation-design.md）。
 *
 * - 点麦克风开始：文字边说边在输入框的光标处长出来，带下划线（像微信输入法）。输入框一直可见、可改字。
 * - 说话过程中：腾讯每定稿一句，就在后台轻度整理这一句（不分点），好了原地替换、下划线消失、轻淡入。
 * - 停下（■ / ↑）：等腾讯 final，再把这次听写插入的全部内容整段整理一次（含列举分点），替换成最终结果；
 *   整段超时按字数放宽（封顶约 4 秒），超时或失败就用逐句整理好的 / 识别原文，不报错。
 *   这段里用户手动打过或改过字就不整段替换；逐句的也只替换用户没动过的句子。Ctrl+Z 还原成整理前。
 * - ↑：停下、等整理，返回要发出去的整段文字（分点的换行原样保留）。
 * - ✕ / Esc：丢掉这次听写，恢复听写前的原文，立刻归还麦克风。
 * - 腾讯走不通（没配置、额度、境外代理、断线重连失败）时这次改成「录完再转」（火山），提示一次。
 *
 * 文字合并规则在 dictationDraft.ts，采音 / 连接 / 后备在 dictationEngine.ts，整理请求在 dictationPolish.ts。
 * 麦克风只在点麦克风这一下请求；结束（■ / ↑ / ✕ / 离开页面）就立刻归还。录音不落库。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "./dictationAudio";
import { DictationEngine, type CaptureLike, type EngineDeps, type EngineEvents, type SocketLike } from "./dictationEngine";
import {
  anchorOffset,
  applyEdit,
  applyFullPolish,
  applyPolished,
  applySlice,
  createDraft,
  dictatedSpan,
  dropUnstable,
  finalizeDraft,
  freshRange,
  hasDictated,
  polishUnits,
  renderDraft,
  shiftCaret,
  type Draft,
  type Mark,
} from "./dictationDraft";
import { SEND_POLISH_DEADLINE_MS, startPolish, type PolishJob } from "./dictationPolish";

export type DictationPhase = "idle" | "starting" | "listening" | "finishing" | "polishing";

/** 声波几根（弱化：16–20 根）。最新的在最右边。 */
export const DICTATION_BARS = 18;
/** 声波多久刷一次（毫秒）：音量每 40ms 来一帧，两帧画一次。 */
const LEVEL_PAINT_MS = 80;
/** 整理替换后那段文字的淡入标记留多久（淡入本身 160ms，见 dictation.module.css）。 */
export const FRESH_MS = 200;

/** 刚整理替换进来的那段（输入框里的范围）：镜像层据此画一次淡入。id 每次替换都变，重播动画。 */
export type FreshRange = Mark & { id: number };

const UNSUPPORTED = "当前浏览器不支持录音，请使用 Chrome、Edge 或 Safari。";
const DENIED = "麦克风未授权，无法语音输入。可在浏览器地址栏左侧开启麦克风权限。";
const NOTHING = "未识别到语音，请靠近麦克风后重试。";

const silent = () => Array<number>(DICTATION_BARS).fill(0);

/** 每种提示本页只说一次。 */
const noticesShown = new Set<string>();

type AudioWindow = typeof window & { webkitAudioContext?: typeof AudioContext };

function browserCapture(): CaptureLike {
  const win = window as AudioWindow;
  const Context = win.AudioContext ?? win.webkitAudioContext;
  if (!Context || typeof AudioWorkletNode === "undefined") throw new Error("unsupported");
  const context = new Context();
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
  const loaded = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  let teardown = () => {};
  return {
    async attach(stream, onFrame) {
      await loaded;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { frameSamples: Math.round(context.sampleRate * 0.04) },
      });
      // 不出声：接一个 0 增益到扬声器，保证各浏览器都会驱动这个节点。
      const mute = context.createGain();
      mute.gain.value = 0;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data, context.sampleRate);
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      teardown = () => {
        node.port.onmessage = null;
        try {
          source.disconnect();
          node.disconnect();
          mute.disconnect();
        } catch {
          /* 已经断开 */
        }
      };
      await context.resume().catch(() => {});
    },
    close() {
      teardown();
      if (context.state !== "closed") void context.close().catch(() => {});
    },
  };
}

function browserDeps(): EngineDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createCapture: browserCapture,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function supported(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  const win = window as AudioWindow;
  return Boolean(win.AudioContext ?? win.webkitAudioContext) && typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined";
}

const isFocused = (element: HTMLTextAreaElement | null | undefined): element is HTMLTextAreaElement =>
  !!element && typeof document !== "undefined" && document.activeElement === element;

export type UseDictationOptions = {
  /** 输入框：开始时按它的光标位置切插入点；文字变化时保住它的光标。 */
  field?: RefObject<HTMLTextAreaElement | null>;
  /** 输入框现在的文字。 */
  value?: string;
  /** 听写要改输入框的文字时调它（就是调用方的 updateInput）。 */
  onValue?: (value: string) => void;
  /** ✕ 或 Esc 丢掉这段之后（首页输入条据此缩回原样）。 */
  onCancel?: (restored: string) => void;
};

export function useDictation({ field, value = "", onValue, onCancel }: UseDictationOptions = {}) {
  const [phase, setPhaseState] = useState<DictationPhase>("idle");
  const [levels, setLevels] = useState<number[]>(silent);
  const [elapsed, setElapsed] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [fresh, setFresh] = useState<FreshRange | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const engine = useRef<DictationEngine | null>(null);
  const draft = useRef<Draft | null>(null);
  const jobs = useRef(new Map<string, PolishJob>());
  /** 停下后的整段整理（在路上时逐句的结果先不换，免得和整段结果打架）。 */
  const full = useRef<PolishJob | null>(null);
  /** 正在进行的收尾整理（发送前 settle 等它）。 */
  const finishing = useRef<Promise<void> | null>(null);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freshId = useRef(0);
  /** 最近一次写进输入框的文字（用户改字按它算差异）。 */
  const written = useRef(value);
  const composing = useRef(false);
  const queued = useRef<(() => void)[]>([]);
  const caret = useRef<{ value: string; start: number; end: number } | null>(null);
  /** 整理替换前后的整段文字：Ctrl+Z 在文字还是「替换后」时还原成「替换前」。 */
  const undo = useRef<{ before: string; after: string } | null>(null);
  const attempt = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** 状态同时写进 ref：同一拍里连按两下 ■ 也只收尾一次。 */
  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const meter = useRef({ levels: silent(), painted: 0, seconds: 0 });

  const latest = useRef({ field, value, onValue, onCancel });
  latest.current = { field, value, onValue, onCancel };

  /** 按草稿重写输入框；输入框有焦点时光标跟着文字挪（不跳到末尾）。 */
  const commit = useCallback((next: Draft) => {
    draft.current = next;
    const rendered = renderDraft(next);
    setMarks(rendered.marks);
    const previous = written.current;
    if (rendered.value === previous) return;
    written.current = rendered.value;
    const element = latest.current.field?.current;
    if (isFocused(element)) {
      caret.current = {
        value: rendered.value,
        start: shiftCaret(element.selectionStart ?? previous.length, previous, rendered.value),
        end: shiftCaret(element.selectionEnd ?? previous.length, previous, rendered.value),
      };
    }
    latest.current.onValue?.(rendered.value);
  }, []);

  // 调用方把新文字渲染进输入框之后（布局前）放回光标。
  useLayoutEffect(() => {
    const pending = caret.current;
    const element = field?.current;
    if (!pending || pending.value !== value || !element) return;
    caret.current = null;
    if (element.value === value) element.setSelectionRange(pending.start, pending.end);
  }, [value, field]);

  const placeCaret = useCallback((position: number) => {
    const element = latest.current.field?.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (element.value === written.current) element.setSelectionRange(position, position);
    else caret.current = { value: written.current, start: position, end: position };
  }, []);

  /** 整理替换之后：记下 Ctrl+Z 要还原的样子，并给换进来的那段一次淡入。 */
  const reveal = useCallback((before: string, prev: Draft, next: Draft) => {
    const after = written.current;
    if (after === before) return;
    undo.current = { before: undo.current?.after === before ? undo.current.before : before, after };
    const range = freshRange(prev, next);
    if (!range) return;
    if (freshTimer.current !== null) clearTimeout(freshTimer.current);
    freshId.current += 1;
    setFresh({ ...range, id: freshId.current });
    freshTimer.current = setTimeout(() => {
      freshTimer.current = null;
      setFresh(null);
    }, FRESH_MS);
  }, []);

  const endTracking = useCallback(() => {
    for (const job of jobs.current.values()) job.abort();
    jobs.current = new Map();
    full.current?.abort();
    full.current = null;
    draft.current = null;
    queued.current = [];
    setMarks([]);
    setPhase("idle");
  }, []);

  const runOrQueue = useCallback((action: () => void) => {
    if (composing.current) queued.current.push(action);
    else action();
  }, []);

  /** 已经整理好的句子换进去；strip=true 时没整理好的也按原文去掉下划线（↑ 超时）。整段整理在路上时逐句的先不换。 */
  const applyReady = useCallback(
    (strip = false) => {
      const prev = draft.current;
      if (!prev || (full.current && !strip)) return;
      let current = prev;
      const before = written.current;
      for (const unit of polishUnits(current)) {
        const job = jobs.current.get(unit.text);
        if (job?.done && job.value !== null) current = applyPolished(current, unit, job.value);
        else if (strip) current = applyPolished(current, unit, unit.text);
      }
      commit(current);
      reveal(before, prev, current);
    },
    [commit, reveal],
  );

  /** 每句定稿就送去整理这一句（按原文缓存，同一句不重复送）；结果一到就原地换上（说话过程中也换）。 */
  const schedulePolish = useCallback(() => {
    const current = draft.current;
    if (!current) return;
    const request = attempt.current;
    for (const unit of polishUnits(current)) {
      if (jobs.current.has(unit.text)) continue;
      const job = startPolish(unit.text, (input, init) => fetch(input, init));
      jobs.current.set(unit.text, job);
      if (job.done) continue;
      void job.result.then(() => {
        if (request !== attempt.current || !draft.current || full.current) return;
        runOrQueue(() => {
          if (request === attempt.current && draft.current) applyReady();
        });
      });
    }
  }, [applyReady, runOrQueue]);

  /**
   * 停下后的整理。这次听写插入的范围干净（没有用户手改）且值得整段整理时：整段送去（含分点），
   * 结果回来、范围还没被动过就整段替换；没换上就退回逐句整理好的 + 原文。
   * 否则只等逐句：sending（↑）最多等 1.2 秒；■ 等每一句自己的超时，结果一到就换。
   */
  const finishPolish = useCallback(
    (sending = false): Promise<void> => {
      const run = async () => {
        const request = attempt.current;
        if (!draft.current) return;
        schedulePolish();
        applyReady();
        const span = dictatedSpan(draft.current);
        const job = span ? startPolish(span.text, (input, init) => fetch(input, init), globalThis, "full") : null;
        if (span && job && !job.done) {
          full.current = job;
          setPhase("polishing");
          const value = await job.result;
          if (request !== attempt.current || !draft.current) return;
          full.current = null;
          const before = written.current;
          const prev = draft.current;
          const next = applyFullPolish(prev, span, value);
          commit(next);
          reveal(before, prev, next);
          applyReady(true);
          endTracking();
          return;
        }
        const pending = polishUnits(draft.current)
          .map((unit) => jobs.current.get(unit.text))
          .filter((item): item is PolishJob => !!item && !item.done);
        if (!pending.length) {
          applyReady(true);
          endTracking();
          return;
        }
        setPhase("polishing");
        const all = Promise.all(pending.map((item) => item.result));
        if (!sending) await all;
        else await Promise.race([all, new Promise((resolve) => setTimeout(resolve, SEND_POLISH_DEADLINE_MS))]);
        if (request !== attempt.current || !draft.current) return;
        applyReady(true);
        endTracking();
      };
      const promise = run();
      finishing.current = promise;
      return promise;
    },
    [applyReady, commit, endTracking, reveal, schedulePolish],
  );

  const events = useCallback(
    (request: number): EngineEvents => {
      const mine = () => request === attempt.current && !!draft.current;
      return {
        slice: (key, text, stable) => {
          if (!mine()) return;
          runOrQueue(() => {
            if (!mine()) return;
            commit(applySlice(draft.current!, key, text, stable));
            if (stable) schedulePolish();
          });
        },
        drop: (match) => {
          if (!mine()) return;
          runOrQueue(() => {
            if (mine()) commit(dropUnstable(draft.current!, match));
          });
        },
        level: (level, seconds) => {
          if (request !== attempt.current) return;
          const state = meter.current;
          state.levels = [...state.levels.slice(1), level];
          const now = Date.now();
          if (now - state.painted >= LEVEL_PAINT_MS) {
            state.painted = now;
            setLevels(state.levels);
          }
          const whole = Math.floor(seconds);
          if (whole !== state.seconds) {
            state.seconds = whole;
            setElapsed(whole);
          }
        },
        notice: (text) => {
          if (request !== attempt.current || noticesShown.has(text)) return;
          noticesShown.add(text);
          setError(text);
        },
        limit: () => {
          if (request === attempt.current) void stopRef.current();
        },
        mode: (mode) => {
          if (request === attempt.current) setLive(mode === "realtime");
        },
      };
    },
    [commit, runOrQueue, schedulePolish],
  );

  const discard = useCallback(() => {
    attempt.current += 1;
    engine.current?.cancel();
    engine.current = null;
  }, []);

  useEffect(
    () => () => {
      discard();
      for (const job of jobs.current.values()) job.abort();
      full.current?.abort();
      if (freshTimer.current !== null) clearTimeout(freshTimer.current);
    },
    [discard],
  );

  const start = useCallback(async () => {
    const now = phaseRef.current;
    if (now === "starting" || now === "listening" || now === "finishing") return;
    // 上一段还在整理：不等了，按原文收下。
    if (draft.current) {
      attempt.current += 1;
      applyReady(true);
      endTracking();
    }
    setError(null);
    if (!supported()) {
      setError(UNSUPPORTED);
      return;
    }
    const request = ++attempt.current;
    const element = latest.current.field?.current;
    const text = latest.current.value;
    const at = element && element.value === text && typeof element.selectionEnd === "number" ? element.selectionEnd : text.length;
    draft.current = createDraft(text, at);
    written.current = text;
    jobs.current = new Map();
    queued.current = [];
    undo.current = null;
    meter.current = { levels: silent(), painted: 0, seconds: 0 };
    setLevels(silent());
    setElapsed(0);
    setLive(true);
    setPhase("starting");
    const instance = new DictationEngine(browserDeps(), events(request));
    engine.current = instance;
    const outcome = await instance.start();
    if (request !== attempt.current) return;
    if (outcome !== "ok") {
      engine.current = null;
      endTracking();
      if (outcome !== "cancelled") setError(outcome === "denied" ? DENIED : UNSUPPORTED);
      return;
    }
    setLive(instance.realtime);
    setPhase("listening");
  }, [applyReady, endTracking, events]);

  /** 停下、等识别收尾，文字留在输入框里。返回 false：没说出东西来（原因在 error 里）。 */
  const settleSpeech = useCallback(async (): Promise<boolean> => {
    const instance = engine.current;
    if (!instance || phaseRef.current !== "listening") return false;
    const request = attempt.current;
    setPhase("finishing");
    const result = await instance.stop();
    if (request !== attempt.current || !draft.current) return false;
    engine.current = null;
    // 组词中停下：排着的识别结果先写进去。
    const backlog = queued.current;
    queued.current = [];
    backlog.forEach((action) => action());
    commit(finalizeDraft(draft.current));
    setLevels(silent());
    if (!hasDictated(draft.current)) {
      endTracking();
      setError(result.error ?? NOTHING);
      return false;
    }
    if (result.error) setError(result.error);
    placeCaret(anchorOffset(draft.current));
    return true;
  }, [commit, endTracking, placeCaret]);

  /** ■：停下，文字留在输入框；整理在后台进行，好了原地替换。 */
  const stop = useCallback(async () => {
    if (await settleSpeech()) void finishPolish();
  }, [finishPolish, settleSpeech]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  /** ↑：停下、等整理（整段按字数最多约 1.6–4.4 秒，只剩逐句时最多 1.2 秒），返回要发出去的整段文字；没说出东西来返回 null。 */
  const finish = useCallback(async (): Promise<string | null> => {
    const request = attempt.current;
    if (!(await settleSpeech())) return null;
    await finishPolish(true);
    return request === attempt.current ? written.current : null;
  }, [finishPolish, settleSpeech]);

  /** 发送前（■ 之后整理还没完时按了发送）：等正在进行的这次收尾（有自己的超时），返回整理后的整段文字。 */
  const settle = useCallback(async (): Promise<string> => {
    if (draft.current && phaseRef.current === "polishing" && finishing.current) await finishing.current;
    return written.current;
  }, []);

  /** ✕ / Esc：丢掉这次听写，恢复听写前的原文。 */
  const cancel = useCallback(() => {
    const original = draft.current?.original;
    discard();
    endTracking();
    setLevels(silent());
    if (original !== undefined && original !== written.current) {
      written.current = original;
      latest.current.onValue?.(original);
    }
    latest.current.onCancel?.(written.current);
  }, [discard, endTracking]);

  /** 输入框的 onChange：听写进行中（含整理中）由这里合并用户的改动，返回 true；否则返回 false 由调用方照常处理。 */
  const change = useCallback(
    (next: string): boolean => {
      const current = draft.current;
      if (!current) return false;
      // 先记下：光标已经在用户改完的位置上，commit 不用再挪它。
      written.current = next;
      commit(applyEdit(current, next));
      latest.current.onValue?.(next);
      return true;
    },
    [commit],
  );

  /** 输入法组词开始 / 结束：组词中识别结果先排着，组完一起写。 */
  const composition = useCallback((active: boolean) => {
    composing.current = active;
    if (active) return;
    const backlog = queued.current;
    queued.current = [];
    backlog.forEach((action) => action());
  }, []);

  /** 输入框的 onKeyDown：整理替换后按 Ctrl+Z（⌘Z）还原成整理前。返回 true 表示已处理。 */
  const keyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement> | KeyboardEvent): boolean => {
    const record = undo.current;
    if (!record || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return false;
    // 还在听：交给输入框自己的撤销（不在说话中途收掉这次听写）。
    const now = phaseRef.current;
    if (now === "starting" || now === "listening" || now === "finishing") return false;
    if (latest.current.value !== record.after) {
      undo.current = null;
      return false;
    }
    event.preventDefault();
    undo.current = null;
    if (draft.current) endTracking();
    written.current = record.before;
    latest.current.onValue?.(record.before);
    return true;
  }, [endTracking]);

  // 正在听时按 Esc 就是 ✕；先于输入框和浮层自己的 Esc 处理（它们会收起输入框）。
  useEffect(() => {
    if (phase !== "listening" && phase !== "starting") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  return {
    phase,
    /** 正在听或正在收尾：操作区换成 指示 + 声波 + ■ + ↑。 */
    active: phase === "starting" || phase === "listening" || phase === "finishing",
    /** ■ 之后还在整理：下划线还在，输入框照常可写。 */
    polishing: phase === "polishing",
    /** 边说边出字（腾讯）；false 是「录完再转」（火山后备）。 */
    live,
    levels,
    /** 已录秒数（计时 0:12）。 */
    elapsed,
    /** 输入框里带下划线的范围（这次听写、还没整理的文字）。 */
    marks,
    /** 刚整理替换进来的那段（≤200ms），镜像层画一次淡入。 */
    fresh,
    error,
    clearError: () => setError(null),
    start,
    cancel,
    stop,
    finish,
    settle,
    change,
    composition,
    keyDown,
  };
}

export type Dictation = ReturnType<typeof useDictation>;

/** 转好的文字接在已有输入后面（中文不补空格）。 */
export function withDictation(input: string, text: string): string {
  return input ? `${input}${text}` : text;
}

/** 计时：0:12、1:05。 */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
