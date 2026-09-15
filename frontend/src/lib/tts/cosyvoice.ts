import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { voiceConfig } from "./config";
import { splitSentences } from "./sentences";
import { TTSNotConfigured, type TTSProvider, type TTSStream, type TTSVoiceOpts } from "./types";

/**
 * 阿里云百炼（DashScope）语音合成，WebSocket 双工。
 *
 * **零新增依赖**：Node 24 自带全局 `WebSocket`，而且 undici 那个实现允许在构造时带自定义
 * 请求头 —— 这一点是这个文件成立的前提（`Authorization` 必须在握手时带上）。已经在这台机器上
 * 实测过：`new WebSocket(url, { headers })` 的 header 确实到了服务端。所以不引 `ws`。
 *
 * 协议四步，`task_id` 全程同一个：
 *
 *   → run-task        开一个任务，参数（音色/语速/格式/采样率）在这一帧里
 *   ← task-started    必须等到它才能推文字。抢跑会被判协议错。
 *   → continue-task   推一段文字，可以推很多次
 *   ← result-generated 句边界元信息（`sentence-begin` / `-synthesis` / `-end`）
 *   ← 二进制帧         音频本体。它**不在** JSON 里，是另一条二进制通道。
 *   → finish-task     没有更多文字了
 *   ← task-finished   合完了
 *
 * key 只在服务端读，一次都不下发到前端。
 */

const READY_TIMEOUT_MS = 8_000;

export function cosyvoice(): TTSProvider {
  /*
   * key 在这一层就读掉，不等到开流的时候。
   *
   * 差别在于错怎么报出来：这里抛，路由那边响应头还没发，能老老实实回一个 503 加一句人话；
   * 等流开起来才发现，HTTP 状态码已经是 200 了，只能把错误当成一帧数据往下塞 —— 那时候
   * 命令行脚本和控制台都看不出这是「没配 key」而不是「厂商挂了」。
   */
  const key = apiKey();
  return {
    name: "cosyvoice",
    openStream: (sessionId, opts) => open(sessionId, opts, key),
    synthesizeToFile: (text, opts) => toFile(text, opts, key),
  };
}

function apiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY ?? process.env.TTS_API_KEY;
  if (!key) {
    throw new TTSNotConfigured(
      "没配 DASHSCOPE_API_KEY，播报层现在出不了声。预合成的音频还能放。",
    );
  }
  return key;
}

function open(sessionId: string, opts: TTSVoiceOpts, key: string): TTSStream {
  const cfg = voiceConfig();
  const taskId = crypto.randomUUID();

  let audio: (chunk: Uint8Array) => void = () => {};
  let mark: (m: { kind: "sentence"; text: string }) => void = () => {};
  let done: (err?: Error) => void = () => {};

  /** 收摊只许一次。socket 关闭、task-failed、cancel 三条路都会走到这儿。 */
  let settled = false;
  let cancelled = false;
  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    done(err);
  };

  /*
   * `task-started` 之前推进来的文字先攒着。
   *
   * 前端第一段话到得比握手快是常态（本地毫秒级，握手要一个 RTT）。没有这个队列的话，第一段
   * 会被丢掉 —— 而第一段正是他最先要听到的那一句。
   */
  let started = false;
  const pending: string[] = [];
  let ended = false;
  /** 最近一次报出去的句子。厂商会在多个事件里重复同一句，重复的不往上报。 */
  let lastMark = "";

  /*
   * 带请求头开 WebSocket。
   *
   * `Authorization` 必须在握手那一下带上，而 WHATWG 那个构造函数签名里没有放请求头的地方 ——
   * Node 的实现（undici）额外收一个 options 对象，DOM 的类型声明里没有它，所以这里要把构造
   * 函数重新标一次类型。这不是在绕过类型检查，是在补一个标准之外的真实签名。已实测过。
   */
  const WS = WebSocket as unknown as new (
    url: string,
    opts: { headers: Record<string, string> },
  ) => WebSocket;

  const ws = new WS(cfg.endpoint, { headers: { Authorization: `Bearer ${key}` } });
  ws.binaryType = "arraybuffer";

  const readyTimer = setTimeout(() => {
    if (!started) {
      try {
        ws.close();
      } catch {
        /* 已经不在了。 */
      }
      finish(new Error("语音合成握手超时：8 秒内没收到 task-started。"));
    }
  }, READY_TIMEOUT_MS);

  const send = (frame: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });

  const pushOne = (text: string) => {
    send({ header: header("continue-task"), payload: { input: { text } } });
  };

  const flushPending = () => {
    while (pending.length) pushOne(pending.shift() as string);
    if (ended) send({ header: header("finish-task"), payload: { input: {} } });
  };

  ws.onopen = () => {
    send({
      header: header("run-task"),
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: cfg.model,
        parameters: {
          text_type: "PlainText",
          voice: opts.voice ?? cfg.voice,
          format: "pcm",
          sample_rate: cfg.sampleRate,
          volume: cfg.volume,
          rate: opts.speed ?? cfg.speed,
          pitch: cfg.pitch,
        },
        input: {},
      },
    });
  };

  ws.onmessage = (e: MessageEvent) => {
    // 二进制帧就是音频。它和 JSON 帧交替到达，顺序就是播放顺序。
    if (typeof e.data !== "string") {
      const buf = e.data as ArrayBuffer;
      if (buf.byteLength) audio(new Uint8Array(buf));
      return;
    }

    let msg: DashMessage | null = null;
    try {
      msg = JSON.parse(e.data) as DashMessage;
    } catch {
      return;
    }

    switch (msg.header?.event) {
      case "task-started":
        started = true;
        clearTimeout(readyTimer);
        flushPending();
        break;

      case "result-generated": {
        /*
         * 句边界。
         *
         * 字幕靠它跟着嘴走。但它是**可选的**：`original_text` 这个字段今晚没有 key 验不了，
         * 所以一次都不响的情况必须是能正常工作的 —— 前端那边有整段兜底。
         */
        const text = msg.payload?.output?.original_text?.trim();
        if (text && text !== lastMark) {
          lastMark = text;
          mark({ kind: "sentence", text });
        }
        break;
      }

      case "task-finished":
        finish();
        break;

      case "task-failed":
        finish(
          new Error(
            `语音合成失败：${msg.header.error_message ?? "厂商没说原因"}（${msg.header.error_code ?? "无错误码"}）`,
          ),
        );
        break;
    }
  };

  ws.onerror = () => {
    // undici 的 error 事件不带原因，能说的只有「连不上」。
    finish(new Error("语音合成连不上（WebSocket 出错）。"));
  };

  ws.onclose = () => {
    // 没收到 task-finished 就断了。掐掉的那次不算错。
    finish(cancelled ? undefined : new Error("语音合成连接提前断开。"));
  };

  return {
    pushText(chunk: string) {
      if (settled || ended) return;
      // 按句推给厂商，和前端切段用的是同一份规则（见 `sentences.ts` 顶上那段）。
      const parts = splitSentences(chunk, cfg.maxSegmentChars);
      if (!parts.length) return;
      if (!started) {
        pending.push(...parts);
        return;
      }
      for (const p of parts) pushOne(p);
    },
    endText() {
      if (settled || ended) return;
      ended = true;
      if (started) send({ header: header("finish-task"), payload: { input: {} } });
    },
    onAudio(cb) {
      audio = cb;
    },
    onMark(cb) {
      mark = cb;
    },
    onDone(cb) {
      done = cb;
    },
    cancel() {
      cancelled = true;
      try {
        ws.close();
      } catch {
        /* 已经不在了。 */
      }
      finish();
    },
  };
}

/**
 * 合成到文件。
 *
 * 走的是同一个 `openStream`，不是另一条实现 —— 所以「预合成全部跑通」这件事同时证明了会上
 * 现说那条路是通的。这是会前唯一拿得到的那种保证。
 */
async function toFile(
  text: string,
  opts: TTSVoiceOpts & { filePath: string },
  key: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const stream = open("pregen", opts, key);

  await new Promise<void>((resolve, reject) => {
    stream.onAudio((c) => chunks.push(c));
    stream.onDone((err) => (err ? reject(err) : resolve()));
    stream.pushText(text);
    stream.endText();
  });

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  if (!total) throw new Error("合成回来是 0 字节 —— 音色 id 或者模型名可能不对。");

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }

  await mkdir(dirname(opts.filePath), { recursive: true });
  await writeFile(opts.filePath, out);
  return opts.filePath;
}

/** 厂商回帧的形状。只窄化用得到的那几个字段，其余不管。 */
interface DashMessage {
  header?: {
    event?: string;
    task_id?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      type?: string;
      original_text?: string;
    };
  };
}
