/**
 * 录音这张表上的全部读写。**纯函数，不 import 对象库。**
 *
 * 为什么反过来（store.ts import 这里，而不是这里 import store）：`store.ts` 的
 * `api` 要调这些函数，如果这里再去 import `store` 拿那个数组，两个模块就互相 import 了。
 * 循环 import 在 ESM 里不一定报错 —— 它更常见的表现是某个 const 在求值时还是 undefined，
 * 而那个 undefined 会一路传下去，在很远的地方炸成一句和真实原因无关的话。
 *
 * 所以这里的每个函数都把那张表当参数收进来。副作用只有一种：**改传进来的数组**。
 * 落盘和「库改过了」由调用方（`store.ts` 的 api）叫 `persistSoon()` —— 那份文件里已经
 * 有一条「哪里算是真的写了东西」的规则，这里不另起一条。
 *
 * 逐字稿正文不在这张表上，见 `transcript.ts`。这里只有元数据。
 */
import type {
  Recording,
  RecordingFailStage,
  RecordingSource,
  RecordingStatus,
  RecordingSummary,
} from "./types";

/** 还在路上的那几档。屏幕据此决定要不要接着轮询。 */
const LIVE_STATUSES: ReadonlySet<RecordingStatus> = new Set<RecordingStatus>([
  "recording",
  "uploaded",
  "transcoding",
  "uploading",
  "transcribing",
]);

export const isSettled = (s: RecordingStatus): boolean => !LIVE_STATUSES.has(s);

/**
 * `REC-20260831-k3f9x2`。
 *
 * 日期拍在 id 上是为了运维：`.data/recordings/` 底下摊着几十个文件时，靠文件名就能
 * 看出哪几个是那天那场会的，不用一个个打开。后面那六位取随机而不是自增 —— 自增要有
 * 一个「上次到几」的状态，而那个状态和这张表迟早会漂开（快照恢复、并发两条），
 * 漂开的表现是两份录音抢同一个 id，后写的那份把前一份的逐字稿覆盖掉。
 */
export function newRecordingId(now: Date, rand: () => number = Math.random): string {
  const d = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const tail = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `REC-${d}-${tail}`;
}

/** `会议 2026-08-31 14:05`。他可以改，但**不许留空** —— 空标题的列表没法读。 */
export function defaultTitle(now: Date): string {
  return (
    `会议 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  );
}

export interface CreateInput {
  now: Date;
  source: RecordingSource;
  title?: string;
  participants?: string[];
  /** 上传那一路进来时已经有文件了；现场录音那一路要等分片攒完。 */
  rawAudioPath?: string;
  rand?: () => number;
}

export function create(list: Recording[], input: CreateInput): Recording {
  const at = input.now.toISOString();
  const rec: Recording = {
    id: newRecordingId(input.now, input.rand),
    title: input.title?.trim() || defaultTitle(input.now),
    source: input.source,
    /*
     * 现场录音一进来就是 `recording`；上传进来的直接是 `uploaded`（文件已经在手上，
     * 等的只是流水线）。这两档在屏幕上说的话不同：一个是「正在录」，一个是「排队中」。
     */
    status: input.source === "live" ? "recording" : "uploaded",
    startedAt: at,
    rawAudioPath: input.rawAudioPath,
    participants: normalizeParticipants(input.participants),
    createdAt: at,
    updatedAt: at,
  };
  list.push(rec);
  return rec;
}

export const find = (list: Recording[], id: string): Recording | undefined =>
  list.find((r) => r.id === id);

/**
 * 改几格。**`updatedAt` 由这里统一盖**，不许调用方自己填 —— 每个调用点各盖各的，
 * 早晚有一处忘了，而忘了的表现是列表按更新时间排序时那一条永远沉在底下。
 */
export function patch(
  list: Recording[],
  id: string,
  changes: Partial<Omit<Recording, "id" | "createdAt">>,
  now: Date,
): Recording | undefined {
  const rec = find(list, id);
  if (!rec) return undefined;
  Object.assign(rec, changes, { updatedAt: now.toISOString() });
  return rec;
}

/**
 * 往前走一档。
 *
 * **每走一档都把 `failStage` 和 `error` 抹掉。** 上一次失败的原话留在一条正在重跑的
 * 记录上，屏幕会同时显示「转写中」和一句「转码失败：ffmpeg 不在 PATH 上」—— 读的人
 * 只能猜哪一句是这一轮的。
 */
export function advance(
  list: Recording[],
  id: string,
  status: RecordingStatus,
  now: Date,
  /*
   * `failStage` / `error` **不在这里给** —— 下面那一行会把它们抹掉，签名里留着它们
   * 等于摆一个静默失效的入口。要标失败走 `fail()`。
   */
  extra?: Partial<Omit<Recording, "id" | "createdAt" | "status" | "failStage" | "error">>,
): Recording | undefined {
  return patch(list, id, { ...extra, status, failStage: undefined, error: undefined }, now);
}

/**
 * 倒了。原话照抄。
 *
 * `stage` 单独一格而不是把它拼进那句话：屏幕要据它决定给不给重试按钮（本机没装 ffmpeg
 * 时重试一万次是同一个结果），而从一句中文里认「这是哪一段倒的」要靠字符串匹配。
 */
export function fail(
  list: Recording[],
  id: string,
  stage: RecordingFailStage,
  error: string,
  now: Date,
): Recording | undefined {
  return patch(list, id, { status: "failed", failStage: stage, error }, now);
}

/**
 * 现场录音收到一片。同一个 seq 重传是幂等的 —— 记的是最大值，重传不改任何东西。
 *
 * **返回的是那条记录，不是「这一片是不是新的」。** 唯一的假值是「这份录音不在了」，
 * 所以 `if (noteChunk(...))` 问的是记录存不存在，不是这一片重没重。
 *
 * 只记「最大的那个 seq」而不是记一整张收到过哪些片的表：那张表要跟着分片一起落盘，
 * 一小时的会 120 片，写 120 次快照。而它唯一的用处是判重，最大值已经够 —— 分片是
 * 按序号追加写进同一个文件的，乱序到达的那些由流水线在拼片时排序（见 `pipeline`）。
 */
export function noteChunk(
  list: Recording[],
  id: string,
  seq: number,
  now: Date,
): Recording | undefined {
  const rec = find(list, id);
  if (!rec) return undefined;
  if (rec.lastChunkSeq === undefined || seq > rec.lastChunkSeq) {
    return patch(list, id, { lastChunkSeq: seq }, now);
  }
  return rec;
}

/** 参会人：去空、去重、去前后空格。逗号分隔那一串在路由层切好再进来。 */
export function normalizeParticipants(names: string[] | undefined): string[] {
  if (!names) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = String(raw).trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 列表页那一行。正文不在里面 —— 那是一两千条句子乘以行数。 */
export function toSummary(
  rec: Recording,
  counts?: { speakerCount?: number; utteranceCount?: number },
): RecordingSummary {
  return {
    id: rec.id,
    title: rec.title,
    source: rec.source,
    status: rec.status,
    failStage: rec.failStage,
    error: rec.error,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    speakerCount: counts?.speakerCount,
    utteranceCount: counts?.utteranceCount,
  };
}

/**
 * 最近的排在最前。按 `startedAt` 倒序 —— 不用 `updatedAt`：一份三天前的录音改一下
 * 说话人名字就会窜到今天上午那场会前面，而列表要回答的问题是「哪天开的会」。
 */
export const byRecent = (a: Recording, b: Recording): number =>
  b.startedAt.localeCompare(a.startedAt);

/**
 * 重启之后，那些卡在中间档的。
 *
 * `recording` **不算在里面**：那是标签页被关掉留下的孤儿，重启后自动替他拼片转写是
 * 在替他做决定 —— 那份可能只录了三秒，也可能是他自己按了停止但没等上传完。列表上给
 * 一颗「结束并转写」，由人按。
 */
export const interrupted = (list: Recording[]): Recording[] =>
  list.filter((r) => r.status === "transcoding" || r.status === "uploading" || r.status === "transcribing" || r.status === "uploaded");

const pad2 = (n: number): string => String(n).padStart(2, "0");
