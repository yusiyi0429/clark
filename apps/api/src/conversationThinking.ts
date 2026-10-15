/**
 * Claude（Anthropic 协议）思考摘要的实时上屏（10/13）。
 *
 * 网宿网关上 Claude 的 thinking_delta 是真流式的，但按段成批到达：思考开始约 4–6 秒后第一段到，段与段之间最长隔 5–11 秒（实测见
 * .superpowers/sdd/tiered-thinking-lighter.md）。摘要绝大多数是英文，系统提示里要求「思考过程用中文」也不改变。所以：
 * - 一段以中文为主：边到边上屏；
 * - 一段以英文为主：等这一段写完（空行或思考块结束），交给快模型译成中文，译文流式上屏；
 * - 段与段严格按原顺序上屏；没配翻译或翻译失败的那一段不上屏（界面仍有「正在思考」与已用时长），不编造。
 * 上屏的文字去掉称呼与运行环境字眼（命中的那一段整段不上屏），「用户」「CEO」换成「一号位」。
 */
import { cleanThinkingText, mostlyChinese, type ThinkingTranslator } from "./conversationRouting.js";

const PARAGRAPH_BREAK = /\n[ \t]*\n/;
/** 判断一段是中文还是英文之前，至少要攒够这么多个汉字或字母。 */
const DECIDE_AFTER = 12;
/** 同时译几段（快模型每段 2–5 秒；摘要成批到达时串行会越积越多）。 */
const TRANSLATE_CONCURRENCY = 3;

export type ThinkingRelay = {
  /** 收到一段 thinking_delta。 */
  push(delta: string): void;
  /** 一个思考块结束（thinking_end）：把没写完的那一段当作完整一段处理。 */
  endBlock(): void;
  /** 本轮结束：之后到的译文不再上屏。 */
  close(): void;
  /** 测试用：等排着的翻译都做完。 */
  idle(): Promise<void>;
};

export function createThinkingRelay(options: { emit: (delta: string) => void; translate?: ThinkingTranslator; signal: AbortSignal }): ThinkingRelay {
  let closed = false;
  let emittedAny = false;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  // 当前这一段（原文）与它的上屏状态
  let raw = "";
  let mode: "undecided" | "direct" | "translate" = "undecided";
  let direct: Writer | null = null;

  /** 一段上屏的写手：段首补空行；累计清洗后的全文，只发新增的部分；末尾的「用」先压着，免得「用户」被拆在两次之间。 */
  type Writer = { write(full: string, final: boolean): void };
  const writer = (): Writer => {
    let sent = 0;
    let dropped = false;
    let started = false;
    return {
      write(full, final) {
        if (closed || dropped) return;
        const cleaned = cleanThinkingText(full);
        if (cleaned === undefined) { dropped = true; return; }
        const ready = final ? cleaned.trimEnd() : /(用|C|CE)$/.test(cleaned) ? cleaned.replace(/(用|CE|C)$/, "") : cleaned;
        if (ready.length <= sent) return;
        let piece = ready.slice(sent);
        sent = ready.length;
        if (!started) {
          piece = piece.replace(/^\s+/, "");
          if (!piece) { sent = 0; return; }
          started = true;
          if (emittedAny) piece = `\n\n${piece}`;
          emittedAny = true;
        }
        options.emit(piece);
      },
    };
  };

  const enqueue = (work: () => Promise<void> | void) => {
    pending += 1;
    queue = queue.then(work).catch(() => undefined).finally(() => { pending -= 1; });
  };

  // 同时在译的段落数上限
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = () => new Promise<() => void>((resolve) => {
    const take = () => { running += 1; resolve(() => { running -= 1; waiting.shift()?.(); }); };
    if (running < TRANSLATE_CONCURRENCY) take(); else waiting.push(take);
  });

  const significant = (text: string) => (text.match(/[一-龥A-Za-z]/g)?.length ?? 0);

  /** 一段写完了。 */
  const finish = (text: string) => {
    const paragraph = text.trim();
    const currentMode = mode;
    const currentDirect = direct;
    mode = "undecided";
    direct = null;
    if (!paragraph) return;
    if (currentMode === "direct" && currentDirect) {
      if (pending) enqueue(() => currentDirect.write(paragraph, true)); else currentDirect.write(paragraph, true);
      return;
    }
    if (mostlyChinese(paragraph)) {
      const w = writer();
      if (pending) enqueue(() => w.write(paragraph, true)); else w.write(paragraph, true);
      return;
    }
    const translate = options.translate;
    if (!translate) return;
    // 译文马上开始要（最多 TRANSLATE_CONCURRENCY 段同时译），上屏仍按段的先后：轮到这一段时先写已经译好的部分，再接着流式写。
    const w = writer();
    let translated = "";
    let active = false;
    const started = slot().then(async (release) => {
      try {
        if (closed || options.signal.aborted) return null;
        return await translate(paragraph, options.signal, (delta) => { translated += delta; if (active) w.write(translated, false); });
      } finally { release(); }
    });
    enqueue(async () => {
      active = true;
      w.write(translated, false);
      const result = await started;
      if (result) w.write(result, true);
    });
  };

  /** 这一段还没写完：攒够字数就定中英文；中文边到边上屏。 */
  const progress = () => {
    if (mode === "undecided" && significant(raw) >= DECIDE_AFTER) {
      mode = mostlyChinese(raw) ? "direct" : "translate";
      if (mode === "direct") direct = writer();
    }
    if (mode === "direct" && direct && !pending) direct.write(raw, false);
  };

  return {
    push(delta) {
      if (closed || !delta) return;
      raw += delta;
      let match: RegExpExecArray | null;
      while ((match = PARAGRAPH_BREAK.exec(raw))) {
        const head = raw.slice(0, match.index);
        raw = raw.slice(match.index + match[0].length);
        if (mode === "direct" && direct && !pending) direct.write(head, false);
        finish(head);
      }
      progress();
    },
    endBlock() {
      const text = raw;
      raw = "";
      finish(text);
    },
    close() { closed = true; },
    idle: () => queue,
  };
}
