import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { voiceConfig } from "./config";
import { splitSentences } from "./sentences";
import { TTSNotConfigured, type TTSProvider, type TTSStream, type TTSVoiceOpts } from "./types";

/**
 * MiniMax t2a，第二家。
 *
 * 它在这儿的作用不是「更好」，是**换得掉**。会上真正会出问题的是额度、网络和某个音色被
 * 下架，三件事都指向同一个动作：改 `demo/voice.json` 里的 `provider`，别的一行不动。这个
 * 文件存在，那个动作才有地方落。
 *
 * 和 CosyVoice 的形状差别在这里说清楚：MiniMax 不是双工的，一次请求合成一段文字，SSE 回
 * 十六进制的音频。所以这个适配器把推进来的文字排成队，**一段一段串行**发请求 —— 串行是
 * 必须的：并发发出去的三段回来的顺序不保证，而音频错序在会上是听得出来的。
 */

export function minimax(): TTSProvider {
  /* key 在这一层读掉。理由和 CosyVoice 那边同一条：没配 key 要能回 503，不能回 200 加一帧错误。 */
  const cred = credentials();
  return {
    name: "minimax",
    openStream: (sessionId, opts) => open(sessionId, opts, cred),
    synthesizeToFile: (text, opts) => toFile(text, opts, cred),
  };
}

function credentials(): { key: string; groupId: string } {
  const key = process.env.MINIMAX_API_KEY ?? process.env.TTS_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID ?? "";
  if (!key) {
    throw new TTSNotConfigured("没配 MINIMAX_API_KEY，播报层现在出不了声。");
  }
  return { key, groupId };
}

function open(
  _sessionId: string,
  opts: TTSVoiceOpts,
  cred: { key: string; groupId: string },
): TTSStream {
  const cfg = voiceConfig();
  const { key, groupId } = cred;

  let audio: (chunk: Uint8Array) => void = () => {};
  let mark: (m: { kind: "sentence"; text: string }) => void = () => {};
  let done: (err?: Error) => void = () => {};

  const queue: string[] = [];
  let running = false;
  let ended = false;
  let settled = false;
  let cancelled = false;
  const ctl = new AbortController();

  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    done(err);
  };

  const url = groupId
    ? `${cfg.endpoint}${cfg.endpoint.includes("?") ? "&" : "?"}GroupId=${encodeURIComponent(groupId)}`
    : cfg.endpoint;

  /** 一段一段来。队列空了而且文字也推完了，就收摊。 */
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const text = queue.shift() as string;
        // 句边界这边是自己切的，所以报得准 —— 报的就是即将念的那一段。
        mark({ kind: "sentence", text });
        await one(text);
        if (cancelled) return;
      }
      if (ended) finish();
    } catch (e) {
      if (!cancelled) finish(e instanceof Error ? e : new Error("语音合成失败。"));
    } finally {
      running = false;
      if (!settled && ended && !queue.length && !cancelled) finish();
    }
  };

  const one = async (text: string) => {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.model,
        text,
        stream: true,
        voice_setting: {
          voice_id: opts.voice ?? cfg.voice,
          speed: opts.speed ?? cfg.speed,
          vol: 1,
          pitch: 0,
        },
        audio_setting: { sample_rate: cfg.sampleRate, format: "pcm", channel: 1 },
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`语音合成失败（HTTP ${res.status}）。`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const hex = pluckAudio(line.slice(5).trim());
        if (hex) audio(fromHex(hex));
      }
    }
  };

  return {
    pushText(chunk: string) {
      if (settled || ended) return;
      queue.push(...splitSentences(chunk, cfg.maxSegmentChars));
      void pump();
    },
    endText() {
      if (settled || ended) return;
      ended = true;
      if (!running && !queue.length) finish();
      else void pump();
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
      queue.length = 0;
      ctl.abort();
      finish();
    },
  };
}

async function toFile(
  text: string,
  opts: TTSVoiceOpts & { filePath: string },
  cred: { key: string; groupId: string },
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const stream = open("pregen", opts, cred);
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

/** SSE 那一帧里的音频是十六进制串。取不出来就返回空 —— 一帧坏掉不该让整段停住。 */
function pluckAudio(data: string): string {
  try {
    const parsed = JSON.parse(data) as { data?: { audio?: unknown } };
    const audio = parsed.data?.audio;
    return typeof audio === "string" ? audio : "";
  } catch {
    return "";
  }
}

function fromHex(hex: string): Uint8Array {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
