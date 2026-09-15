/**
 * 火山「大模型录音文件识别」标准版。提交一个任务，轮询它，把结果映射成我们的形状。
 *
 * ## 为什么是它，而不是接着用 paraformer
 *
 * 这条链路唯一的目的是**说话人分离**。实时那条线（`lib/asr/`）给不出说话人，而
 * 「王总说了什么、谁反对」是一份会议逐字稿的全部价值 —— 一整页不分人的文字，读起来
 * 和没有一样。代价是必须走对象存储：这个接口只接 URL，不接文件（见 `tos.ts`）。
 *
 * ## 三件容易踩的事，都在文档里写着
 *
 * 1. **状态在 HTTP 响应头里，不在 body 里**（`X-Api-Status-Code`），而且是字符串
 *    比较 —— `"20000001"` 是「还在跑」。当成数字或者去 body 里找，表现是永远轮询不完。
 * 2. **任务 id 用我们自己生成的 UUID**，提交和查询都拿它当 `X-Api-Request-Id`。
 *    新版文档说提交会回一个 `task_id`，旧版文档说「Response body 为空」——两版打架，
 *    而自己生成的那个两边都成立。
 * 3. **说话人分离要同时开 `show_utterances`**，而且只在不指定语种（或指定 zh-CN）时
 *    生效。所以下面不发 `audio.language` —— 发了反而把这条链路唯一的目的关掉。
 *
 * ## 映射那一层为什么把原文整个存下来
 *
 * `utterances[].additions.speaker` 这个字段**在官方字段说明表里根本没有定义**，只在
 * 返回示例里出现过，值是字符串 `"1"`。也就是说这条链路最关键的那一格建立在一段示例上。
 * 真数据到手时它可能叫别的名字、可能不出现。所以 `RecordingTranscript.raw` 存的是
 * 厂商返回的原文一个字不改 —— 猜错了能照着原文改映射，而不用重新花一次钱转一遍。
 */
import { randomUUID } from "node:crypto";

import { asrResourceId, volcAsrConfig } from "./config";
import type { RecordingSpeaker, RecordingUtterance } from "./types";

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

/** 文档里那张表。**字符串比较**，别转成数字。 */
const STATUS = {
  ok: "20000000",
  running: "20000001",
  queued: "20000002",
  silent: "20000003",
} as const;

/** 厂商那边判掉了这份音频，重试没有意义。屏幕据此不给重试按钮。 */
export class AsrRejected extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SubmitOptions {
  /** TOS 上那份 mp3 的预签名地址。**必须公网可达** —— 厂商是从它那边下载的。 */
  url: string;
  /** 参会人和会议标题，拼成热词。没有就不发这一段。 */
  hotwords?: string[];
}

/**
 * 提交一个任务，返回任务 id。
 *
 * 那个 id 是我们自己生成的 UUID（见文件头第 2 条），所以**提交失败时它也已经存在**——
 * 调用方不要拿「有没有 id」当「提交成没成」的判据。
 */
export async function submitTask(opts: SubmitOptions): Promise<string> {
  const taskId = randomUUID();
  const body: Record<string, unknown> = {
    audio: {
      url: opts.url,
      /* 规整那一步固定出 16 k 单声道 mp3（见 `media.ts`），这几个数跟着它写死。 */
      format: "mp3",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      /* 这两个是一对：文档原话「开启后需启用 show_utterances 参数，才能获取到说话人分离结果」。 */
      enable_speaker_info: true,
      show_utterances: true,
      /*
       * 说话人分离模型版本。`"300"` 是「使用声纹匹配能力 / 适用于长音频会议场景」，
       * `"200"` 文档写着「说话人数量建议不超过 5 人 / 适用于非会议场景」。
       * 这条链路上跑的全是会议。
       */
      ssd_version: "300",
      /*
       * 标点和数字规整**显式传**，不吃默认值：这两个开关的默认值在新旧两版文档里
       * 写的是相反的（新版说 enable_punc 默认 true，旧版说 false，而官方示例里显式
       * 写了 false）。吃默认值的结果是一份没有标点的逐字稿，而那件事要等真数据才发现。
       */
      enable_punc: true,
      enable_itn: true,
      ...(opts.hotwords?.length ? { corpus: { context: contextOf(opts.hotwords) } } : {}),
    },
    /*
     * **不发 `audio.language`。** 说话人分离只在语种未指定或指定 zh-CN 时生效，而这
     * 一场会上可能夹着英文词 —— 让它自己认（不指定时它认中英和几种方言），比钉死
     * zh-CN 更宽，且都保住了说话人分离。
     */
  };

  const res = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { ...authHeaders(), "X-Api-Request-Id": taskId, "X-Api-Sequence": "-1" },
    body: JSON.stringify(body),
  });

  const code = res.headers.get("X-Api-Status-Code") ?? "";
  if (code && code !== STATUS.ok) throw rejection(code, res, await safeText(res));
  if (!res.ok) {
    throw new Error(`提交转写任务失败（HTTP ${res.status}）：${await safeText(res)}`);
  }
  return taskId;
}

export type QueryResult =
  | { state: "running" }
  | {
      state: "done";
      utterances: RecordingUtterance[];
      speakers: RecordingSpeaker[];
      raw: unknown;
    };

/**
 * 问一次这个任务怎么样了。
 *
 * 「还在跑」是一个正常答案，不是错 —— 所以它是返回值的一档，不是异常。异常只留给
 * 「这条路走不通了」：厂商判掉了这份音频、网断了、凭据不对。
 */
export async function queryTask(taskId: string): Promise<QueryResult> {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { ...authHeaders(), "X-Api-Request-Id": taskId },
    body: "{}",
  });

  const code = res.headers.get("X-Api-Status-Code") ?? "";
  if (code === STATUS.running || code === STATUS.queued) return { state: "running" };
  if (code === STATUS.silent) {
    throw new AsrRejected(
      "这份录音里没有检测到人声。可能是麦克风没收上声音，或者传错了文件。",
      code,
    );
  }
  if (code && code !== STATUS.ok) throw rejection(code, res, await safeText(res));
  if (!res.ok) {
    throw new Error(`查询转写结果失败（HTTP ${res.status}）：${await safeText(res)}`);
  }

  const raw: unknown = await res.json();
  const { utterances, speakers } = mapResult(raw);
  if (!utterances.length) {
    /*
     * 状态说成功、一句话都没有。**这是失败，不是一份空逐字稿** —— 交一份空的出去，
     * 屏幕上看不出它是空的，而他会以为这场会真的没录上什么。
     */
    throw new AsrRejected("厂商说转写成功，但一句话都没返回。", code || "empty");
  }
  return { state: "done", utterances, speakers, raw };
}

/**
 * 把厂商的形状折成我们的。**每一格都防着它不存在，一句话都不许因为格式怪就丢掉。**
 *
 * 说话人那一格尤其（见文件头）：字段说明表里没有它，只在示例里出现。取不到时怎么退，
 * 见下面那段 —— 分「全都取不到」和「只有几句取不到」两种，因为它们说的是两件事。
 */
export function mapResult(raw: unknown): {
  utterances: RecordingUtterance[];
  speakers: RecordingSpeaker[];
} {
  const body = raw as { result?: { utterances?: unknown } | null } | null;
  const list = Array.isArray(body?.result?.utterances) ? body.result.utterances : [];

  const rows: { speakerId?: string; startMs: number; endMs: number; text: string }[] = [];
  let anySpeaker = false;
  for (const item of list) {
    /*
     * **这一句挡的是一个会烧掉一轮钱的洞。** 下面是 `item as {...}` ——
     * 元素是 `null` 时那一读直接 TypeError，而 `queryTask` 是在拿到厂商返回之后才
     * 叫这里的：抛在这里等于钱已经花了、原文就在手上，却因为一个空元素连一句都没存下。
     * 别的垃圾形状（字符串、数字、布尔）读属性只会得到 undefined，唯独 nullish 会炸。
     */
    if (!item || typeof item !== "object") continue;
    const u = item as {
      text?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      additions?: { speaker?: unknown } | null;
    };
    const text = typeof u.text === "string" ? u.text.trim() : "";
    if (!text) continue; // 空句子不进库，它在屏幕上是一行什么都不说的空白
    const speakerId = str(u.additions?.speaker);
    if (speakerId) anySpeaker = true;
    rows.push({
      speakerId,
      /* 文档明写毫秒（新旧两版一致）。取不到当 0 —— 点它会跳到开头，比整句丢掉好。 */
      startMs: int(u.start_time) ?? 0,
      endMs: int(u.end_time) ?? 0,
      text,
    });
  }

  /*
   * 取不到说话人的那些句子，退成什么，**取决于是不是全都取不到**。
   *
   * 全都取不到 = 我们猜的那个字段名不对（它在官方字段说明表里没有定义，只在一段返回
   * 示例里出现过，见文件头）。那时整份逐字稿退成一个人说的，屏幕上说话人数是 1 ——
   * 一眼看得出不对，而每一句话都还在。
   *
   * 只有一部分取不到，就**不能**塞给「1 号」：那会把几句无主的话安到一个真实存在的人
   * 头上，而屏幕上没有任何一处说它是猜的 —— 那比不知道是谁更糟。所以给一个单独的号，
   * 并且直接把名字定死成「未标注」（`speakerLabel` 会优先用 displayName），免得它被
   * 编成一个不存在的「说话人 4」。
   */
  const UNKNOWN = "?";
  const utterances: RecordingUtterance[] = rows.map((r, idx) => ({
    idx,
    speakerId: r.speakerId ?? (anySpeaker ? UNKNOWN : "1"),
    startMs: r.startMs,
    endMs: r.endMs,
    text: r.text,
  }));

  /*
   * 说话人表从句子里推，**不去找一个厂商的说话人列表** —— 文档里没有那样一个字段。
   * 顺序按第一次出现，这样「说话人 1」就是先开口的那个人（见 `transcript.ts` 的
   * `speakerLabel`：编号是出现次序，不是厂商给的号）。
   */
  const seen = new Set<string>();
  const speakers: RecordingSpeaker[] = [];
  for (const u of utterances) {
    if (seen.has(u.speakerId)) continue;
    seen.add(u.speakerId);
    speakers.push(
      u.speakerId === UNKNOWN
        ? { speakerId: UNKNOWN, displayName: "未标注" }
        : { speakerId: u.speakerId },
    );
  }
  return { utterances, speakers };
}

/** 热词。文档里 `corpus.context` 是一个**序列化后的 JSON 字符串**，不是对象。 */
function contextOf(words: string[]): string {
  /* 文档写着热词总长不超过 5000 词。一场会的参会人加标题远到不了，截一刀只是保险。 */
  const hotwords = words
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((word) => ({ word }));
  return JSON.stringify({ hotwords });
}

function authHeaders(): Record<string, string> {
  const cfg = volcAsrConfig();
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    /* 提交和查询必须用同一个 resource id，否则查不到那个任务。所以只有 config 一处。 */
    "X-Api-Resource-Id": asrResourceId(),
  };
  return cfg.kind === "apiKey"
    ? { ...base, "X-Api-Key": cfg.apiKey }
    : { ...base, "X-Api-App-Key": cfg.appKey, "X-Api-Access-Key": cfg.accessKey };
}

/**
 * 把厂商的错误码折成一句人能读的话。
 *
 * **`45` 开头的一律不给重试**（参数无效、空音频、格式不对、超出大小）—— 那几类重试
 * 一万次是同一个结果。`550` 开头是服务端的事，可以重试。
 *
 * 认不出来的码照样把**原码带上**：这条链路上最有用的排查线索就是那个数字加
 * `X-Tt-Logid`（文档说报问题必须提供它）。
 */
function rejection(code: string, res: Response, text: string): Error {
  const logId = res.headers.get("X-Tt-Logid") ?? "";
  const message = res.headers.get("X-Api-Message") ?? "";
  const tail = [message, text].filter(Boolean).join(" ").slice(0, 300);
  const head = KNOWN_CODE[code] ?? "厂商拒绝了这次转写";
  const where = logId ? `${code} · ${logId}` : code;
  const said = tail ? `${head}（${where}）：${tail}` : `${head}（${where}）。`;
  return code.startsWith("45") ? new AsrRejected(said, code) : new Error(said);
}

const KNOWN_CODE: Record<string, string> = {
  "45000001": "请求参数无效",
  "45000002": "这是一段空音频",
  "45000131": "半小时内提交的音频总时长超了厂商的上限（默认 500 小时）",
  "45000132": "这份音频超过 512 MB 了",
  "45000151": "这份音频的格式厂商不认",
  "55000031": "厂商那边服务繁忙",
};

const str = (v: unknown): string | undefined => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
};

const int = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : undefined;
};

const safeText = async (res: Response): Promise<string> => {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
};
