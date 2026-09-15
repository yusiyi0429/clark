/**
 * 把一整份录音推过识别那条线，攒出一份文字。
 *
 * ## 为什么复用实时那条线，而不是接厂商的「录音文件识别」
 *
 * 厂商那个异步接口要一个**公网可达的 URL**：本地跑的这一台没有，就得先把录音传到对象
 * 存储上去 —— 为了一个会后的转写，凭空多出一套凭据、一个桶、一条清理策略，而且那份
 * 录音会离开这台机器。实时那条线已经跑通、key 已经配好、失败方式已经熟悉（`paraformer.ts`
 * 顶上那段），把文件当成一串音频块推进去就行。
 *
 * ## 推的速度要压住
 *
 * 一口气把一小时的 PCM 全塞进 socket，厂商那侧会当成流控异常直接断。所以按块推，
 * 每块之间歇一下 —— `SPEED` 是「一秒墙钟推多少秒音频」。20 倍意味着一小时的会大约三分钟
 * 转完，同时留足了厂商回包的余量。
 *
 * ## 只收 `final`
 *
 * 中间态是同一句话一个字一个字长出来的（`ASRResult.key` 那段）。按 `key` 覆盖式地存，
 * 最后按到达顺序拼 —— 直接追加的话，一句十个字的话会在结果里出现十遍前缀。
 */
import { asrProvider } from "./index";
import { listenConfig } from "./config";
import { TARGET_RATE } from "./wav";

/** 一块推多少毫秒的音频。和实时那条线的 `chunkMs` 同量级，没必要更小。 */
const CHUNK_MS = 200;
/** 一秒墙钟推多少秒音频。压住流控，同时别让一小时的会转上半小时。 */
const SPEED = 20;
/** 推完之后最多再等多久收尾巴。厂商要把最后一句认完才发 `task-finished`。 */
const TAIL_MS = 20_000;

export type TranscribeProgress = (done: number, total: number) => void;

/**
 * 推一份 PCM，等它认完，交出全文。
 *
 * 失败一律抛 —— 交半份文字出去是这条路上最坏的结果：屏幕上看不出它是半份，而会后提炼
 * 会照着半份认认真真地提炼出一份看起来很完整的东西。
 */
export async function transcribePcm(
  pcm: Uint8Array,
  opts: { sessionId: string; onProgress?: TranscribeProgress } ,
): Promise<string> {
  const cfg = listenConfig();
  const stream = asrProvider().openStream(opts.sessionId, {
    // 采样率跟着解码那一侧的目标走，不读配置：这份 PCM 已经被重采样成 16 k 了
    // （`decodeWav`），配置里那个数万一被改成别的，两边就对不上而且没有任何报错。
    sampleRate: TARGET_RATE,
    silenceMs: cfg.silenceMs,
  });

  const sentences = new Map<string, string>();
  const order: string[] = [];
  let failure: Error | null = null;
  let settled = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  stream.onResult((r) => {
    if (!r.final) return;
    if (!sentences.has(r.key)) order.push(r.key);
    sentences.set(r.key, r.text);
  });
  stream.onDone((err) => {
    if (settled) return;
    settled = true;
    failure = err ?? null;
    resolveDone();
  });

  /* 一块 = CHUNK_MS 毫秒的 16 位单声道。 */
  const bytesPerChunk = Math.round((TARGET_RATE * 2 * CHUNK_MS) / 1000);
  const pause = CHUNK_MS / SPEED;
  try {
    for (let at = 0; at < pcm.length; at += bytesPerChunk) {
      if (settled) break; /* 厂商先收摊了（出错或超时）—— 别再往一个关掉的 socket 里推。 */
      stream.pushAudio(pcm.subarray(at, Math.min(pcm.length, at + bytesPerChunk)));
      opts.onProgress?.(Math.min(pcm.length, at + bytesPerChunk), pcm.length);
      await sleep(pause);
    }
    stream.endAudio();
  } catch (err) {
    stream.cancel();
    throw err;
  }

  /*
   * 等收尾。到点了就自己收摊 —— 厂商偶尔不发 `task-finished`，而挂着等的表现是这次上传
   * 永远转圈。到点时**已经认出来的那些照样交**：那不是半份文字，是「尾巴那一句可能缺了」，
   * 和连一个字都没有是两回事。
   */
  const timeout = new Promise<void>((r) => setTimeout(r, TAIL_MS).unref?.());
  await Promise.race([done, timeout]);
  if (!settled) stream.cancel();

  if (failure) throw failure;
  const text = order
    .map((k) => (sentences.get(k) ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (!text) throw new Error("这份录音里一个字都没认出来 —— 可能是静音，或者不是人声。");
  return text;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
