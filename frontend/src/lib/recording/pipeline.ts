/**
 * 一份录音从「收下了」走到「有逐字稿」的那条流水线。
 *
 *   拼片（只有现场录音有）→ ffmpeg 规整成 mp3 → 传 TOS → 提交火山 → 轮询 → 落库
 *
 * ## 为什么是一个自己转的圈，而不是「谁写完谁调一下」
 *
 * 触发这条线的地方有四个：上传、结束录音、失败后重试、进程重启后接上没跑完的。前三个
 * 都在请求里，第四个不在。如果做成「谁改状态谁调一下流水线」，重启恢复那一路就必须
 * 另写一套，而两套迟早会漂开 —— 漂开的表现是某一档状态没人管，屏幕上永远转圈。
 *
 * 所以只有一个入口：`kick()`。它扫一遍「还没走完的」，该跑的跑起来，之后每 `SCAN_MS`
 * 自己再扫一遍。
 *
 * ★ **但那个圈在没活的时候会把自己停掉**（见 `scan()` 结尾）—— 一个常驻定时器会在这台
 * 机器整天没有录音时每十秒空转一次。代价是这条规矩：**凡是把一份录音推回在途状态的
 * 地方，都得自己叫一次 `kick()`。** 一共四处，一处都不能少：
 *
 *   1. 上传（`api/recordings/upload`）
 *   2. 重试（`api/recordings/[id]/retry`）
 *   3. 结束现场录音（`api/recordings/[id]/finish`）
 *   4. 起服务时接上没跑完的（`instrumentation.ts`）
 *
 * 前三处都是路由，**不是 `store.ts` 里那几个方法** —— 那几个方法也从 `/api/data` 那条
 * 通用 JSON-RPC 上够得着，而那条路由对所有方法一视同仁，不知道要 kick。这正是
 * 2026-08-31 那个洞：重试接口返回 ok、状态真的翻回 `uploaded`、屏幕上写着「排队中」，
 * 然后一动不动，直到重启服务才继续跑。这条规矩由 `pipeline.test.ts` 钉着。
 *
 * ## 不上消息队列
 *
 * 理由和落盘选 JSON 快照一样（`lib/data/persist.ts`）：单副本部署、任务量是个位数/天。
 * 代价说清楚：**进程重启时正在转码的那一份会从头再转一遍**。转码是幂等的（同样的输入
 * 出同样的 mp3），而已经提交给厂商的那一份**不重提** —— 重提是重新计一次费，所以
 * `transcribing` 那一档靠库里存着的 `asrTaskId` 接着轮询。
 *
 * ## 这条线一步都不做提炼
 *
 * 出来的是带说话人和时间戳的文字，到此为止。「这场会定了什么」是别的链路的事
 * （`ingestMeetingNotes`）。两件事搅在一起的话，提炼那一步失败会把一份好好的逐字稿
 * 也标成失败。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { persistSoon, recordingsTable } from "@/lib/data/store";

import { RecordingNotConfigured, chunkDir, rawDir, workDir } from "./config";
import { MediaToolsMissing, transcodeToMp3 } from "./media";
import * as rec from "./registry";
import { writeTranscript } from "./transcript";
import { presignGet, putFile } from "./tos";
import type { Recording } from "./types";
import { AsrRejected, queryTask, submitTask } from "./volc-asr";

/** 多久扫一遍。只在还有没走完的时候转 —— 全都走完了就把它停掉。 */
const SCAN_MS = 10_000;
/** 问厂商一次的间隔。文档说标准版三小时内出结果，十秒够密了。 */
const POLL_MS = 10_000;
/**
 * 一份录音最多等多久。
 *
 * 文档写着标准版「3 小时内」出结果，但这里给 60 分钟就收 —— 一场会最长几小时，等
 * 三小时才说「超时」的话，他那天下午已经过去了。超时不等于失败在厂商那边：库里
 * `asrTaskId` 还在，按一下重试会从头再走一遍（重新计费，所以由人按，不自动）。
 */
const MAX_WAIT_MS = 60 * 60 * 1000;

/** 预签名给厂商用的那条地址签多久。它要够长到把一份大文件下完。 */
const ASR_URL_TTL = 24 * 3600;

/** 正在跑的那几份。**进程内**，所以重启后是空的 —— 那正是重启恢复要的起点。 */
const running = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 扫一遍，该跑的跑起来。**不 await** —— 叫它的地方（上传路由、起服务）都不该被
 * 一条几分钟的流水线堵住。
 */
export function kick(): void {
  void scan();
  if (!timer) {
    timer = setInterval(() => void scan(), SCAN_MS);
    /* 别让这个定时器把进程钉住不退出。 */
    timer.unref?.();
  }
}

/** 测试和优雅退出用。 */
export function stopPipeline(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function scan(): Promise<void> {
  const list = recordingsTable();
  const pending = rec.interrupted(list);

  if (!pending.length && !running.size) {
    /*
     * 没活了就把圈停掉。**从这一刻起，光改状态是不会有人来接的** —— 下一个把录音推回
     * 在途状态的地方必须自己叫 `kick()`（文件头那张四处的表）。
     */
    stopPipeline();
    return;
  }

  for (const r of pending) {
    if (running.has(r.id)) continue;
    running.add(r.id);
    /*
     * 每一份各跑各的，一份倒了不影响别的。**这里不 await**：串起来的话，一份一小时的
     * 会在轮询时会把后面排队的全堵住，而它们本可以同时提交给厂商。
     */
    void run(r).finally(() => running.delete(r.id));
  }
}

async function run(r: Recording): Promise<void> {
  const id = r.id;
  const list = recordingsTable();
  try {
    /*
     * `transcribing` 是接着上一次跑（重启、或者上一轮扫描起的那次还在等）。**不重新
     * 提交** —— 重提是重新计一次费，而任务 id 就在库里存着。
     */
    if (r.status === "transcribing" && r.asrTaskId) {
      await poll(id, r.asrTaskId);
      return;
    }

    // ── 拼片。只有现场录音有，上传那一路进来就已经是一个完整文件了。 ──
    let raw = r.rawAudioPath;
    if (!raw && r.source === "live") raw = joinChunks(id);
    if (!raw || !existsSync(raw)) {
      throw new StageError(
        "transcode",
        "这一份的原始音频不在了 —— 磁盘上找不到那个文件。",
        false,
      );
    }

    // ── 规整。 ──
    rec.advance(list, id, "transcoding", new Date(), { rawAudioPath: raw });
    persistSoon();
    mkdirSync(workDir(), { recursive: true });
    let mp3: { path: string; durationMs?: number };
    try {
      mp3 = await transcodeToMp3(raw, join(workDir(), `${id}.mp3`));
    } catch (err) {
      /*
       * 本机没装 ffmpeg 和「这个文件转不动」要分开：前者重试一万次是同一个结果，
       * 后者换个文件就好了。两条在屏幕上要说不同的话，所以 `retryable` 分开标。
       */
      throw new StageError("transcode", msg(err), !(err instanceof MediaToolsMissing));
    }

    // ── 传上去。火山那个接口只接 URL，不接文件。 ──
    rec.advance(list, id, "uploading", new Date(), { durationMs: mp3.durationMs });
    persistSoon();
    const key = `recordings/${id}.mp3`;
    let url: string;
    try {
      await putFile(key, mp3.path, "audio/mpeg");
      url = presignGet(key, ASR_URL_TTL);
    } catch (err) {
      throw new StageError("upload", msg(err), !(err instanceof RecordingNotConfigured));
    }

    // ── 交给厂商。 ──
    rec.advance(list, id, "transcribing", new Date(), { audioKey: key });
    persistSoon();
    let taskId: string;
    try {
      taskId = await submitTask({ url, hotwords: hotwordsOf(r) });
    } catch (err) {
      throw new StageError("transcribe", msg(err), !(err instanceof AsrRejected));
    }
    /*
     * 任务 id 先落库**再**开始轮询。反过来的话，提交完到落库之间那一瞬崩掉，就成了
     * 一个厂商那边在跑、我们这边不知道 id 的任务 —— 只能重新花一次钱。
     */
    rec.patch(list, id, { asrTaskId: taskId }, new Date());
    persistSoon();

    await poll(id, taskId);
  } catch (err) {
    const stage = err instanceof StageError ? err.stage : "transcribe";
    const said = err instanceof StageError ? err.message : msg(err);
    console.error(`[recording] ${id} 在 ${stage} 这一段倒了：`, err);
    rec.fail(recordingsTable(), id, stage, said, new Date());
    persistSoon();
  }
}

/**
 * 等厂商把这一份认完。
 *
 * 每一轮之前都回库里看一眼这份记录还在不在、状态还是不是 `transcribing` —— 他可能
 * 已经把它删了，或者按了重试。不看的话，一条被删掉的记录会在一小时里每十秒问厂商一次。
 */
async function poll(id: string, taskId: string): Promise<void> {
  const until = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const cur = rec.find(recordingsTable(), id);
    if (!cur || cur.status !== "transcribing" || cur.asrTaskId !== taskId) return;

    let out: Awaited<ReturnType<typeof queryTask>>;
    try {
      out = await queryTask(taskId);
    } catch (err) {
      throw new StageError(
        err instanceof AsrRejected ? "transcribe" : "transcribe",
        msg(err),
        !(err instanceof AsrRejected),
      );
    }

    if (out.state === "done") {
      /*
       * 正文先落文件，**再**把状态翻成 done。反过来的话，中间崩一下会留下一条写着
       * 「已完成」、点开却没有正文的记录 —— 而那种记录看起来像转写把内容弄丢了。
       */
      try {
        writeTranscript({
          recordingId: id,
          utterances: out.utterances,
          speakers: out.speakers,
          raw: out.raw,
        });
      } catch (err) {
        throw new StageError("parse", `逐字稿没能存下来：${msg(err)}`, true);
      }
      rec.advance(recordingsTable(), id, "done", new Date(), { endedAt: nowIso() });
      persistSoon();
      /* 转码产物留着 —— 音频页要播的就是它在 TOS 上那一份，本地这份是重跑时的省事。 */
      return;
    }

    if (Date.now() > until) {
      throw new StageError(
        "transcribe",
        `等了一小时，厂商那边还没转完（任务 ${taskId}）。按重试会从头再走一遍。`,
        true,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * 把现场录音那些分片拼成一个文件。
 *
 * **必须按 seq 排序拼。** Chrome 的 `MediaRecorder` 只有第一片带 webm 容器头，后面的
 * 片是接着它的字节流 —— 顺序错一片，整个文件从那里往后都解不开，而 ffmpeg 报的错
 * 会是一句和顺序无关的「Invalid data found」。
 *
 * 排序按数字不按文件名字符串：`10.part` 的字符串序在 `2.part` 前面。
 */
export function joinChunks(id: string): string {
  const dir = chunkDir(id);
  if (!existsSync(dir)) throw new StageError("transcode", "这一场录音一片都没收到。", false);

  const parts = readdirSync(dir)
    .map((name) => ({ name, seq: Number(name.replace(/\.part$/, "")) }))
    .filter((p) => Number.isFinite(p.seq))
    .sort((a, b) => a.seq - b.seq);
  if (!parts.length) throw new StageError("transcode", "这一场录音一片都没收到。", false);

  mkdirSync(rawDir(), { recursive: true });
  const out = join(rawDir(), `${id}.webm`);
  writeFileSync(out, Buffer.concat(parts.map((p) => readFileSync(join(dir, p.name)))));
  /* 拼完就删分片。留着的话，一场四十分钟的会在磁盘上会有两份。 */
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * 喂给厂商的热词：会议标题加参会人。
 *
 * 人名是这条链路上最容易认错的东西（「王总」「李工」在通用模型里没有先验），而认错
 * 一个名字会让整场会的逐字稿读起来像另一件事。
 */
function hotwordsOf(r: Recording): string[] {
  return [...r.participants, ...r.title.split(/[\s·、,，]+/)].filter((w) => w.length >= 2);
}

/** 倒在哪一段、原话是什么、重试有没有意义。 */
class StageError extends Error {
  constructor(
    readonly stage: "transcode" | "upload" | "transcribe" | "parse",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms).unref?.();
  });
