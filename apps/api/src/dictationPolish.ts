/**
 * 听写后的快速整理：一段识别原文 → 火山方舟上的轻模型（OpenAI 兼容 /chat/completions）→ 轻度整理
 * （去口头填充词和残句、处理改口、修明显的同音错字、理顺语序、补标点；整段那一档另把列举排成「1. 」分行）。
 * 依据 `.superpowers/sdd/dictation-polish-model.md`（2026-10-10 选型）与 `.superpowers/sdd/dictation-polish-v4.md`（v4 实测）。
 *
 * - 两档（mode）：sentence = 说话过程中逐句整理，快、不分点；full = 停下后整段再整理一次，含分点排版。
 * - 已经干净的句子（没有填充词、改口词、叠词，且以句末标点结尾）不送模型，原样交回（§5.1）；
 *   整段那一档另外在有列举词或三句以上时也送（可能要分点）。
 * - 主模型 DICTATION_POLISH_MODEL；配了 DICTATION_POLISH_BACKUP_MODEL 时两路同时发（§5.3）：
 *   逐句取先回来并且过了防护的那一路，另一路立刻取消；整段优先用主模型（v4 实测备用模型分点不稳），
 *   备用的结果先收着，主模型失败、没过防护或到点时才用它。
 * - 硬超时：逐句默认 1200ms（DICTATION_POLISH_TIMEOUT_MS 可配）；整段按字数放宽（基数 + 每 100 字 400ms，封顶 4 秒）。
 *   超时、失败、未配置、没过防护，一律交回原文（polished:false），接口仍是 200。
 * - 防护在报告 §8 的基础上为 v4 放宽：行首「1. 」序号不算插字；允许修同音字、理顺语序带来的少量插字
 *   （按字计数多出来的字 ≤ max(2, 4%)；按顺序对不上的字 ≤ max(4, 25%)，留给理顺语序）；删残句后允许留到 50%。
 *   另加：不许出现原文里没有的数字（改口把 2 换成 3 合法，3 在原文里出现过）；不许 markdown 标题、「-」列表。
 * - 复用连接：常驻 keep-alive 的 HTTPS Agent，避开偶发的 3.5 秒冷 TLS 握手。
 *
 * 凭据只在服务端读取，不打印；日志只记结果和耗时，不记原文与整理结果。
 * 提示词与请求参数在 dictationPolishPrompt.ts。
 */
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { logEvent } from "./observability.js";
import { MODEL_PROVIDERS, withModelCall } from "./tracing.js";
import { DICTATION_POLISH_PARAMS, polishMaxTokens, polishSystemPrompt, polishUserMessage, type PolishMode } from "./dictationPolishPrompt.js";

export type { PolishMode } from "./dictationPolishPrompt.js";

export const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_POLISH_TIMEOUT_MS = 1200;
/** 整段整理的超时封顶。 */
export const MAX_FULL_POLISH_TIMEOUT_MS = 4000;

/** 整段整理的硬超时：基数（逐句超时）+ 每 100 字 400ms，封顶 4 秒。前端 dictationPolish.ts 用同一条公式再加网络余量。 */
export function fullPolishTimeoutMs(text: string, baseMs: number = DEFAULT_POLISH_TIMEOUT_MS): number {
  return Math.min(MAX_FULL_POLISH_TIMEOUT_MS, Math.max(baseMs, baseMs + Math.round(Array.from(text).length * 4)));
}
/** 原文上限（按字符计）：超出返回 413。一次听写 5 分钟上限，正常远小于此。 */
export const MAX_POLISH_TEXT_CHARS = 2000;

export type DictationPolishConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 对冲的第二路；null = 只发单路。 */
  backupModel: string | null;
  timeoutMs: number;
};

type Env = Record<string, string | undefined>;
const read = (env: Env, name: string): string | undefined => {
  const value = env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

/** 缺 ARK_API_KEY 或 DICTATION_POLISH_MODEL 时返回 null（= 未配置，直接回原文）。每次现读：改了配置不用重启。 */
export function dictationPolishConfig(env: Env = process.env): DictationPolishConfig | null {
  const apiKey = read(env, "ARK_API_KEY");
  const model = read(env, "DICTATION_POLISH_MODEL");
  if (!apiKey || !model) return null;
  const timeout = Number(read(env, "DICTATION_POLISH_TIMEOUT_MS"));
  const backup = read(env, "DICTATION_POLISH_BACKUP_MODEL");
  return {
    apiKey,
    model,
    backupModel: backup && backup !== model ? backup : null,
    baseUrl: read(env, "ARK_BASE_URL") ?? DEFAULT_ARK_BASE_URL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_POLISH_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------- 方舟客户端

export type ArkChatRequest = { baseUrl: string; apiKey: string; body: Record<string, unknown>; signal: AbortSignal };
/** 返回 choices[0].message.content。 */
export type ArkChat = (request: ArkChatRequest) => Promise<string>;

/** 一次 HTTP POST（默认实现走 keep-alive Agent）；测试注入假实现。 */
export type ArkTransport = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; body: string }>;

const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });

export const keepAliveTransport: ArkTransport = (url, { headers, body, signal }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const req = (secure ? httpsRequest : httpRequest)(
      target,
      { method: "POST", agent: secure ? httpsAgent : httpAgent, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });

/** 方舟 OpenAI 兼容接口。错误信息只带 HTTP 状态，不带回包（回包可能回显请求头）。 */
export function createArkChat(transport: ArkTransport = keepAliveTransport): ArkChat {
  // 追踪启用且处在听写整理的 Turn 里时，每次真实请求一个 model:ark/<model> 节点，usage 取方舟回包。
  return async (request) => withModelCall({ provider: MODEL_PROVIDERS.ark, modelId: String(request.body.model ?? "unknown"),
    messages: Array.isArray(request.body.messages) ? request.body.messages as { role: string; content: string }[] : [] },
  (report) => arkChatOnce(transport, request, report));
}

async function arkChatOnce(transport: ArkTransport, { baseUrl, apiKey, body, signal }: ArkChatRequest,
  report: (result: { text?: string; usage?: unknown; finishReason?: string }) => void): Promise<string> {
  {
    const res = await transport(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`方舟整理接口返回 HTTP ${res.status}`);
    let json: { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: unknown };
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error("方舟整理接口回包不是 JSON");
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("方舟整理接口没有返回文字");
    report({ text: content, usage: json.usage, finishReason: json.choices?.[0]?.finish_reason });
    return content;
  }
}

/** 外部依赖边界：配置 + 方舟客户端。测试注入假实现。 */
export type DictationPolishDeps = {
  readConfig(): DictationPolishConfig | null;
  chat: ArkChat;
};

export const realDictationPolishDeps: DictationPolishDeps = {
  readConfig: () => dictationPolishConfig(),
  chat: createArkChat(),
};

// ---------------------------------------------------------------- 本地预判与防护（选型报告 §5.1、§8）

const FILLER = /嗯|呃|啊|额|哦|唉|诶|那个|就是/;
/** 预判用的改口词（宁可多送：「不是」也算）。 */
const SKIP_CORRECTION = /不对|说错|我是说|不是|哦不|应该是/;
const REPEAT = /(\p{Script=Han}{2,6})[，,、]?\1/u;
const SENTENCE_END = /[。！？!?…]$/;

/** 已经干净的句子：没有填充词、改口词、叠词，并且以句末标点结尾 → 不送模型。 */
export function needsPolish(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return FILLER.test(t) || SKIP_CORRECTION.test(t) || REPEAT.test(t) || !SENTENCE_END.test(t);
}

/** 列举的口头序号（整段那一档据此判断可能要分点）。「第三季度」这类不算。 */
const LIST_CUE = /第[一二三四五六七八九十][个点条件是，,、：:]|[一二三四五]是|首先|其次|最后/;

/** 整段：逐句的预判之外，有列举词或三句以上（可能是并列事项）也送。 */
export function needsFullPolish(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return needsPolish(t) || LIST_CUE.test(t) || (t.match(/[。！？!?；;]/g)?.length ?? 0) >= 3;
}

const PUNCT = /[\s，。、；：？！,.;:?!"'“”‘’（）()《》【】[\]…—\-·~～]/gu;
/** 防护用的改口词：有它时允许删得多、允许数字和英文被改掉。 */
const CUE = /不对|说错|我是说|不是|哦不|应该是|更正/;
const CHATTY = /^(好的|已整理|整理后|以下是|当然)/;
/** 行首的分点序号「1. 」「2、」：不算插字，也不算新出现的数字。 */
const LIST_MARKER = /^[ \t]*\d{1,2}[.．、][ \t]*/gm;
/** markdown 标题、「-」「*」列表：整理不该出现。 */
const MARKDOWN_BLOCK = /^[ \t]*(#{1,6}\s|[-*•]\s)/m;
const stripMarkers = (s: string): string => s.replace(LIST_MARKER, "");
const ASCII_TOKEN = /[A-Za-z0-9.%]+/g;
const FULL_WIDTH_DIGIT = /[０-９]/g;

/** 输出（去标点）里无法按顺序在原文（去标点）里找到的字：整理以删字、改标点为主，少量插字来自修同音字和理顺语序。 */
function insertedChars(input: string, output: string): string[] {
  const a = Array.from(input.replace(PUNCT, ""));
  const b = Array.from(output.replace(PUNCT, ""));
  const miss: string[] = [];
  let i = 0;
  for (const ch of b) {
    let j = i;
    while (j < a.length && a[j] !== ch) j++;
    if (j < a.length) i = j + 1;
    else miss.push(ch);
  }
  return miss;
}

/** 按字计数：输出里比原文多出来的字（不管顺序）。理顺语序不会增加它，回答、扩写会。 */
function extraChars(input: string, output: string): number {
  const pool = new Map<string, number>();
  for (const ch of Array.from(input.replace(PUNCT, ""))) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let extra = 0;
  for (const ch of Array.from(output.replace(PUNCT, ""))) {
    const left = pool.get(ch) ?? 0;
    if (left > 0) pool.set(ch, left - 1);
    else extra += 1;
  }
  return extra;
}

const numbersIn = (s: string): Set<string> =>
  new Set(s.replace(FULL_WIDTH_DIGIT, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).match(/\d+(?:\.\d+)?/g) ?? []);

/**
 * 模型输出的清理：去首尾空白、误带的 <asr> 标签和首尾引号、markdown 粗体。
 * 逐句：换行去掉、并成一段。整段：每行去首尾空白、去空行，行与行之间一个换行。
 */
export function cleanPolished(output: string, mode: PolishMode = "sentence"): string {
  const text = output.trim().replace(/^<asr>|<\/asr>$/g, "").replace(/^[「"“]|[」"”]$/g, "").replace(/\*\*/g, "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return mode === "full" ? lines.join("\n") : lines.join("");
}

/** 整理结果的防护：通过时返回清理后的结果，不通过返回 null（调用方用原文）。 */
export function acceptPolished(input: string, output: string, mode: PolishMode = "sentence"): string | null {
  const out = cleanPolished(output, mode);
  if (!out) return null; // 1. 空输出
  if (CHATTY.test(out)) return null; // 2. 客套前缀
  if (MARKDOWN_BLOCK.test(out)) return null; // 另加：标题、「-」列表
  const source = stripMarkers(input);
  const body = stripMarkers(out);
  const inputChars = Array.from(source.replace(PUNCT, "")).length;
  // 3. 以删为主：修同音字只会多出很少几个字；理顺语序不多字，只是顺序对不上
  if (extraChars(source, body) > Math.max(2, Math.floor(inputChars * 0.04))) return null;
  if (insertedChars(source, body).length > Math.max(4, Math.floor(inputChars * 0.25))) return null;
  const corrected = CUE.test(input);
  const ratio = Array.from(body.replace(PUNCT, "")).length / Math.max(1, inputChars);
  if (ratio < (corrected ? 0.3 : 0.5)) return null; // 4. 删得过多
  if (!corrected) {
    const kept: string[] = body.match(ASCII_TOKEN) ?? [];
    for (const token of source.match(ASCII_TOKEN) ?? []) if (!kept.includes(token)) return null; // 5. 英文和数字不能丢
  }
  const known = numbersIn(source);
  for (const n of numbersIn(body)) if (!known.has(n)) return null; // 另加：不许出现原文里没有的数字
  return out;
}

// ---------------------------------------------------------------- 整理

export type PolishResult = { text: string; polished: boolean };

type Outcome = "polished" | "skipped" | "rejected" | "timeout" | "failed";

/** 整理一段原文；永不抛错。调用方先挡掉超长原文（413）。mode 缺省为逐句。 */
export async function polishDictation(deps: DictationPolishDeps, text: string, mode: PolishMode = "sentence"): Promise<PolishResult> {
  const original: PolishResult = { text, polished: false };
  if (!text.trim()) return original;
  const cfg = deps.readConfig();
  if (!cfg) return original;
  if (!(mode === "full" ? needsFullPolish(text) : needsPolish(text))) {
    logEvent({ event: "dictation.polish", provider: "ark", model: cfg.model, mode, status: "skipped" satisfies Outcome, durationMs: 0 });
    return original;
  }
  const timeoutMs = mode === "full" ? fullPolishTimeoutMs(text, cfg.timeoutMs) : cfg.timeoutMs;

  const started = Date.now();
  const controller = new AbortController();
  const models = [cfg.model, ...(cfg.backupModel ? [cfg.backupModel] : [])];
  let rejected = 0;
  let failed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // 每一路：成功且过了防护就 resolve；否则记一次，所有路都落空时 resolve(null)
  // 整段优先主模型：备用先回来时先收着（held），主模型落空或到点再用。
  const preferPrimary = mode === "full" && models.length > 1;
  let held: { text: string; model: string } | null = null;
  const winner = new Promise<{ text: string; model: string } | null>((resolve) => {
    let pending = models.length;
    const settleMiss = (model: string) => {
      pending -= 1;
      if (pending === 0) resolve(held);
      else if (preferPrimary && model === cfg.model && held) resolve(held);
    };
    timer = setTimeout(() => resolve(held), timeoutMs);
    for (const model of models) {
      deps
        .chat({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          signal: controller.signal,
          body: {
            model,
            messages: [
              { role: "system", content: polishSystemPrompt(mode) },
              { role: "user", content: polishUserMessage(text) },
            ],
            stream: false,
            max_tokens: polishMaxTokens(text, mode),
            ...DICTATION_POLISH_PARAMS,
          },
        })
        .then(
          (output) => {
            const accepted = acceptPolished(text, output, mode);
            if (accepted === null) {
              rejected += 1;
              settleMiss(model);
            } else if (preferPrimary && model !== cfg.model) {
              held = { text: accepted, model };
              settleMiss(model);
            } else resolve({ text: accepted, model });
          },
          () => {
            failed += 1;
            settleMiss(model);
          },
        );
    }
  });

  const won = await winner;
  clearTimeout(timer);
  controller.abort(); // 赢了就取消另一路；超时就取消全部
  const status: Outcome = won ? "polished" : rejected + failed < models.length ? "timeout" : rejected > 0 ? "rejected" : "failed";
  logEvent({ event: "dictation.polish", provider: "ark", model: won?.model ?? cfg.model, mode, status, durationMs: Date.now() - started });
  return won ? { text: won.text, polished: true } : original;
}
