/**
 * 火山「大模型录音文件识别」标准版：提交任务、轮询、把结果映射成我们的形状。（移植自概念版 `lib/recording/volc-asr.ts`）
 *
 * 这条链路唯一的目的是**说话人分离**。三件容易踩的事，都在文档里写着：
 *
 * 1. **状态在 HTTP 响应头里，不在 body 里**（`X-Api-Status-Code`），而且是字符串比较 ——
 *    `"20000001"` 是「还在跑」。当成数字或去 body 里找，表现是永远轮询不完。
 * 2. **任务 id 用我们自己生成的 UUID**，提交和查询都拿它当 `X-Api-Request-Id`：新旧两版文档对
 *    「提交会不会回 task_id」说法打架，自己生成的两边都成立。
 * 3. **说话人分离要同时开 `show_utterances`**，且只在不指定语种（或 zh-CN）时生效，所以不发 `audio.language`。
 *
 * `utterances[].additions.speaker` 在官方字段说明表里**没有定义**，只在返回示例里出现过（值是字符串 "1"），
 * 所以映射每一格都防着它不存在，一句话都不许因为格式怪就丢掉；调用方把厂商原文整份留存，猜错了能照原文改映射。
 */
import { randomUUID } from "node:crypto";
import { asrResourceId, volcAsrConfig } from "./recordingConfig.js";

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

/** 单次 HTTP 请求的上限：挂死的连接会让一份录音永远停在「识别中」，超时则如实失败。 */
const REQUEST_TIMEOUT_MS = 60_000;

/** 文档里那张表。**字符串比较**，别转成数字。 */
const STATUS = {
  ok: "20000000",
  running: "20000001",
  queued: "20000002",
  silent: "20000003",
} as const;

/** 一句话，按厂商原始分句，一句不合并。时间单位毫秒。 */
export type RecordingUtterance = { idx: number; speakerId: string; startMs: number; endMs: number; text: string };
/** 说话人：厂商编号，以及已定死的展示名（只有「未标注」会预先给名字）。 */
export type RecordingSpeaker = { speakerId: string; displayName?: string };

/** 厂商判掉了这份音频，重试没有意义。 */
export class AsrRejected extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type SubmitOptions = {
  /** TOS 上那份 mp3 的预签名地址。**必须公网可达** —— 厂商从它那边下载。 */
  url: string;
  /** 参会人和会议标题拼成的热词；没有就不发这一段。 */
  hotwords?: string[];
};

export type QueryResult =
  | { state: "running" }
  | { state: "done"; utterances: RecordingUtterance[]; speakers: RecordingSpeaker[]; raw: unknown };

/** 提交一个任务，返回任务 id（我们自己生成的 UUID，见文件头第 2 条）。 */
export async function submitTask(opts: SubmitOptions): Promise<string> {
  const taskId = randomUUID();
  const body = {
    audio: {
      url: opts.url,
      // 规整那一步固定出 16k 单声道 mp3（见 recordingMedia.ts），这几个数跟着它写死
      format: "mp3",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      // 这两个是一对：开启说话人分离后必须启用 show_utterances 才拿得到说话人
      enable_speaker_info: true,
      show_utterances: true,
      // "300"：声纹匹配、适用于长音频会议场景（"200" 建议不超过 5 人、非会议场景）
      ssd_version: "300",
      // 标点与数字规整显式传：新旧两版文档写的默认值相反，吃默认值可能得到一份没有标点的逐字稿
      enable_punc: true,
      enable_itn: true,
      ...(opts.hotwords?.length ? { corpus: { context: contextOf(opts.hotwords) } } : {}),
    },
    // 不发 audio.language：说话人分离只在未指定语种或 zh-CN 时生效
  };
  const res = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { ...authHeaders(), "X-Api-Request-Id": taskId, "X-Api-Sequence": "-1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const code = res.headers.get("X-Api-Status-Code") ?? "";
  if (code && code !== STATUS.ok) throw rejection(code, res, await safeText(res));
  if (!res.ok) throw new Error(`提交转写任务失败（HTTP ${res.status}）：${await safeText(res)}`);
  return taskId;
}

/** 问一次任务怎么样了。「还在跑」是正常答案（返回值的一档），异常只留给「这条路走不通了」。 */
export async function queryTask(taskId: string): Promise<QueryResult> {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { ...authHeaders(), "X-Api-Request-Id": taskId },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const code = res.headers.get("X-Api-Status-Code") ?? "";
  if (code === STATUS.running || code === STATUS.queued) return { state: "running" };
  if (code === STATUS.silent) {
    throw new AsrRejected("这份录音里没有检测到人声。可能是麦克风没收上声音，或者传错了文件。", code);
  }
  if (code && code !== STATUS.ok) throw rejection(code, res, await safeText(res));
  if (!res.ok) throw new Error(`查询转写结果失败（HTTP ${res.status}）：${await safeText(res)}`);

  const raw: unknown = await res.json();
  const { utterances, speakers } = mapResult(raw);
  // 状态说成功、一句话都没有：这是失败，不是一份空逐字稿
  if (!utterances.length) throw new AsrRejected("厂商说转写成功，但一句话都没返回。", code || "empty");
  return { state: "done", utterances, speakers, raw };
}

/**
 * 把厂商的形状折成我们的。每一格都防着它不存在。
 *
 * 取不到说话人的句子退成什么，取决于是不是全都取不到：全都取不到 = 字段名猜错了，整份退成一个人（屏幕上
 * 说话人数是 1，一眼看得出不对，而每一句都还在）；只有一部分取不到，就单独归「未标注」，不许安到真实存在的 1 号头上。
 */
export function mapResult(raw: unknown): { utterances: RecordingUtterance[]; speakers: RecordingSpeaker[] } {
  const body = raw as { result?: { utterances?: unknown } | null } | null;
  const list = Array.isArray(body?.result?.utterances) ? body.result.utterances : [];

  const rows: { speakerId?: string; startMs: number; endMs: number; text: string }[] = [];
  let anySpeaker = false;
  for (const item of list) {
    // 元素是 null 时下面的读属性会 TypeError：钱已经花了、原文就在手上，不能因为一个空元素一句都存不下
    if (!item || typeof item !== "object") continue;
    const u = item as { text?: unknown; start_time?: unknown; end_time?: unknown; additions?: { speaker?: unknown } | null };
    const text = typeof u.text === "string" ? u.text.trim() : "";
    if (!text) continue;
    const speakerId = str(u.additions?.speaker);
    if (speakerId) anySpeaker = true;
    // 文档明写毫秒；取不到当 0，比整句丢掉好
    rows.push({ speakerId, startMs: int(u.start_time) ?? 0, endMs: int(u.end_time) ?? 0, text });
  }

  const UNKNOWN = "?";
  const utterances: RecordingUtterance[] = rows.map((row, idx) => ({
    idx,
    speakerId: row.speakerId ?? (anySpeaker ? UNKNOWN : "1"),
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
  }));

  // 说话人表从句子里推（文档里没有厂商说话人列表），按第一次出现排序
  const seen = new Set<string>();
  const speakers: RecordingSpeaker[] = [];
  for (const u of utterances) {
    if (seen.has(u.speakerId)) continue;
    seen.add(u.speakerId);
    speakers.push(u.speakerId === UNKNOWN ? { speakerId: UNKNOWN, displayName: "未标注" } : { speakerId: u.speakerId });
  }
  return { utterances, speakers };
}

/** 热词：文档里 `corpus.context` 是**序列化后的 JSON 字符串**，不是对象。 */
function contextOf(words: string[]): string {
  const hotwords = words.map((w) => w.trim()).filter(Boolean).slice(0, 200).map((word) => ({ word }));
  return JSON.stringify({ hotwords });
}

function authHeaders(): Record<string, string> {
  const cfg = volcAsrConfig();
  // 提交和查询必须用同一个 resource id，所以只从 config 一处取
  const base: Record<string, string> = { "Content-Type": "application/json", "X-Api-Resource-Id": asrResourceId() };
  return cfg.kind === "apiKey"
    ? { ...base, "X-Api-Key": cfg.apiKey }
    : { ...base, "X-Api-App-Key": cfg.appKey, "X-Api-Access-Key": cfg.accessKey };
}

/**
 * 厂商错误码折成一句人能读的话。`45` 开头一律不给重试（参数无效、空音频、格式不对、超出大小）。
 * 认不出来的码照样带原码和 `X-Tt-Logid`：报问题时厂商要的就是这两样。
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
