import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FRAME_AUDIO,
  FRAME_ERROR,
  FRAME_MARK,
  encodeFrame,
  encodeTextFrame,
} from "@/lib/tts/frames";
import { audioRelPath, findLine } from "@/lib/tts/lines";
import {
  TTSNotConfigured,
  ttsProvider,
  voiceConfig,
  type TTSProvider,
  type TTSStream,
} from "@/lib/tts";

/**
 * 播报层的下行 —— 一条独立的流式 HTTP 响应。
 *
 * 前端把一段话 POST 上来，这里边合成边把音频吐回去。**不建 WebSocket**：这是单向的，
 * 一个流式响应就够，而且它天然带着 `AbortController` —— 前端 `abort()` 一下，`req.signal`
 * 当场响，厂商那条连接立刻掐掉。「停止播报」要求「服务端的流也真的取消」，靠的就是这条。
 *
 * ## 优先级：先找预合成的文件，找不到才去厂商
 *
 * 带 `line` 上来的是**固定台词**（开场、每件事的口播、收尾、过渡语）。会前跑过 pregen 的话，
 * 这些是磁盘上的文件 —— 网断了、额度用完了、厂商挂了，这条路照样出声。这不是优化，这是
 * 会前那份保险：主线全灭的时候，秘书按热键把整场会用预合成的音频走完。
 *
 * 找不到文件就现合成同一段文字。所以秘书按下去**永远有反应**，只是延迟不一样。
 */

const CHUNK_BYTES = 8192; // PCM16 要偶数字节，8192 是整数个采样。

interface Body {
  text?: unknown;
  line?: unknown;
  voice?: unknown;
  speed?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "请求体不是 JSON。" }, { status: 400 });
  }

  const lineId = str(body.line);
  const line = lineId ? findLine(lineId) : undefined;
  if (lineId && !line) {
    return Response.json({ error: `没有这条台词：${lineId}` }, { status: 404 });
  }

  const text = (line?.text ?? str(body.text) ?? "").trim();
  if (!text) return Response.json({ error: "没有要念的东西。" }, { status: 400 });

  // 命中预合成就直接吐文件。这一条在前，是因为它是那条不依赖任何外部服务的路。
  if (line) {
    const canned = await readCanned(line.id);
    if (canned) {
      return streamBytes(canned.bytes, line.text, canned.sampleRate);
    }
  }

  const opts = {
    ...(str(body.voice) ? { voice: str(body.voice) as string } : {}),
    ...(num(body.speed) !== undefined ? { speed: num(body.speed) as number } : {}),
  };

  return streamLive(req, text, opts);
}

/* -------------------------------------------------------------------------- */
/* 预合成那条路                                                                */
/* -------------------------------------------------------------------------- */

interface Manifest {
  sampleRate?: number;
}

async function readCanned(
  id: string,
): Promise<{ bytes: Uint8Array; sampleRate: number } | null> {
  try {
    // turbopackIgnore: 这个路径是运行时算出来的，静态分析会因此把整个项目
    // （src/、docs/、assets/、设计文档）全部 trace 进 server 产物。语音是本版
    // 封存的链路，这里显式退出追踪，standalone 只留真正要跑的东西。
    const bytes = new Uint8Array(
      await readFile(join(/*turbopackIgnore: true*/ process.cwd(), audioRelPath(id))),
    );
    if (!bytes.byteLength) return null;
    /*
     * 采样率跟着文件走，不跟着当前 config 走。
     *
     * 试听完把 config 里的 sampleRate 改了、但没重跑 pregen 的话，两边不一致 —— 那时候放
     * 出来的是一段变调的声音（快半个八度），而这种错在会上没法当场解释。manifest 是 pregen
     * 写的，它记的是这批文件真正的采样率。
     */
    let sampleRate = voiceConfig().sampleRate;
    try {
      const m = JSON.parse(
        await readFile(join(process.cwd(), "demo/audio/manifest.json"), "utf8"),
      ) as Manifest;
      if (typeof m.sampleRate === "number" && m.sampleRate > 0) sampleRate = m.sampleRate;
    } catch {
      /* 没有 manifest 就按当前 config 算。 */
    }
    return { bytes, sampleRate };
  } catch {
    return null;
  }
}

function streamBytes(bytes: Uint8Array, markText: string, sampleRate: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeTextFrame(FRAME_MARK, JSON.stringify({ text: markText })));
      for (let at = 0; at < bytes.byteLength; at += CHUNK_BYTES) {
        controller.enqueue(encodeFrame(FRAME_AUDIO, bytes.subarray(at, at + CHUNK_BYTES)));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: headers(sampleRate, "file") });
}

/* -------------------------------------------------------------------------- */
/* 现合成那条路                                                                */
/* -------------------------------------------------------------------------- */

function streamLive(
  req: Request,
  text: string,
  opts: { voice?: string; speed?: number },
): Response {
  const cfg = voiceConfig();

  let provider: TTSProvider;
  try {
    provider = ttsProvider();
  } catch (e) {
    // 没配 key 的时候前端一个字节都还没收到，可以老老实实回一个 503 和一句人话。
    if (e instanceof TTSNotConfigured) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  let open = true;
  let tts: TTSStream | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  /*
   * 收摊。三条路都到这儿：厂商说合完了、前端 abort、前端 cancel 读流。
   *
   * 「停止播报」按下去之后，前端清播放队列是毫秒级的，但**服务端这条流如果还挂着，厂商那边
   * 的字符还在计费、连接还占着额度**。所以这里必须真的 `tts.cancel()`。这一条和 `/api/stage`
   * 里那个订阅泄漏是同一类账 —— 断了这一头，另一头也要退掉。
   */
  const close = () => {
    if (!open) return;
    open = false;
    req.signal.removeEventListener("abort", close);
    tts?.cancel();
    try {
      controller?.close();
    } catch {
      /* 已经关了。 */
    }
  };

  const push = (chunk: Uint8Array) => {
    if (!open) return;
    try {
      controller?.enqueue(chunk);
    } catch {
      // 写不出去就是前端那一头没了。当场把厂商那条连接掐掉，别让字符继续计费。
      close();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      req.signal.addEventListener("abort", close);

      try {
        tts = provider.openStream("stage", opts);
      } catch (e) {
        const why = e instanceof Error ? e.message : "语音合成起不来。";
        push(encodeTextFrame(FRAME_ERROR, why));
        close();
        return;
      }

      tts.onAudio((chunk) => push(encodeFrame(FRAME_AUDIO, chunk)));
      tts.onMark((m) => push(encodeTextFrame(FRAME_MARK, JSON.stringify({ text: m.text }))));
      tts.onDone((err) => {
        /*
         * 出错也要把话说出来。
         *
         * 一个 500 在这里没有用：响应头早就发出去了（流已经开始），前端只会看到流突然断掉，
         * 然后什么都不显示 —— 而「没声音也没提示」是会上最糟的一种状态。所以错误当一帧数据
         * 往下发，前端把它写到字幕上。
         */
        if (err) push(encodeTextFrame(FRAME_ERROR, err.message));
        close();
      });

      tts.pushText(text);
      tts.endText();
    },
    cancel() {
      // 前端 `reader.cancel()` 走这里。和 abort 是两条不同的路，都要掐得到厂商。
      close();
    },
  });

  return new Response(stream, { headers: headers(cfg.sampleRate, "live") });
}

const headers = (sampleRate: number, source: "file" | "live"): HeadersInit => ({
  "Content-Type": "application/octet-stream",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
  /** 前端建 AudioBuffer 要用它。两边不一致就会变调，所以由服务端说。 */
  "X-Sample-Rate": String(sampleRate),
  /** `file` = 放的是预合成；`live` = 现合成。控制台上要看得见这个。 */
  "X-Tts-Source": source,
});

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
