/**
 * 解 WAV。
 *
 * 这里钉的四条，每一条错了以后**在屏幕上都只表现为「这份录音没转出字来」**：
 *
 *   · 块表要走一遍，不能按固定偏移取 `data` —— 录音软件常在中间插 `LIST`/`fact`/`bext`，
 *     按固定偏移取会把元数据当成音频，听起来是一片白噪。
 *   · `WAVE_FORMAT_EXTENSIBLE`（0xFFFE）要认 —— Windows 录音机默认写的就是这个头，
 *     不认的话那台机器上录的每一份都会被拒掉。
 *   · 多声道要并成单声道，采样率要落到 16 k —— 识别那一侧只收这一种。
 *   · 认不出来的要抛 `WavNotSupported`，而且**消息能直接上屏**：那句话里得写清要什么，
 *     不然他手上那份 m4a 就成了死路。
 */
import { describe, expect, it } from "vitest";

import { decodeWav, TARGET_RATE, WavNotSupported } from "./wav";

/**
 * 拼一份 WAV。`extra` 是插在 `fmt ` 和 `data` 之间的杂块（模拟录音软件写的元数据）。
 */
function wav(opts: {
  format: number;
  bits: number;
  channels: number;
  rate: number;
  frames: number;
  /** 第 i 帧第 c 声道的值，−1..1。 */
  sample?: (i: number, c: number) => number;
  /** 额外的块：`[id, 字节数]`。 */
  extra?: [string, number][];
  /** `fmt ` 块写多长（extensible 是 40）。 */
  fmtSize?: number;
  /** extensible 的子格式。 */
  subFormat?: number;
}): ArrayBuffer {
  const { format, bits, channels, rate, frames } = opts;
  const sample = opts.sample ?? (() => 0);
  const bytes = bits / 8;
  const dataSize = frames * channels * bytes;
  const fmtSize = opts.fmtSize ?? 16;
  const extra = opts.extra ?? [];
  // 块是双字节对齐的：长度是奇数时后面补一个字节。真实的写入方都这么干，
  // 而解码那一侧正是靠这一条跳到下一个块（`chunks`）。
  const pad = (n: number) => n + (n % 2);
  const extraSize = extra.reduce((n, [, size]) => n + 8 + pad(size), 0);
  const total = 12 + (8 + fmtSize) + extraSize + (8 + dataSize);

  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let at = 0;
  const ascii = (s: string) => {
    for (const ch of s) v.setUint8(at++, ch.charCodeAt(0));
  };

  ascii("RIFF");
  v.setUint32(at, total - 8, true);
  at += 4;
  ascii("WAVE");

  ascii("fmt ");
  v.setUint32(at, fmtSize, true);
  at += 4;
  const fmtAt = at;
  v.setUint16(fmtAt, format, true);
  v.setUint16(fmtAt + 2, channels, true);
  v.setUint32(fmtAt + 4, rate, true);
  v.setUint32(fmtAt + 8, (rate * channels * bits) / 8, true);
  v.setUint16(fmtAt + 12, (channels * bits) / 8, true);
  v.setUint16(fmtAt + 14, bits, true);
  if (fmtSize >= 40) v.setUint16(fmtAt + 24, opts.subFormat ?? 1, true);
  at += fmtSize;

  for (const [id, size] of extra) {
    ascii(id);
    v.setUint32(at, size, true);
    at += 4;
    at += pad(size); /* 内容全是 0，无所谓 —— 要钉的是「跳过它」。 */
  }

  ascii("data");
  v.setUint32(at, dataSize, true);
  at += 4;
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channels; c += 1) {
      const x = sample(f, c);
      if (format === 3) {
        v.setFloat32(at, x, true);
        at += 4;
      } else if (bits === 16) {
        v.setInt16(at, Math.round(x * 32767), true);
        at += 2;
      } else if (bits === 8) {
        // 8 位 WAV 是无符号的。这一支只为了造一份「格式合法但我们不支持」的文件。
        v.setUint8(at, Math.round((x + 1) * 127.5));
        at += 1;
      } else {
        const n = Math.round(x * 8388607);
        v.setUint8(at, n & 0xff);
        v.setUint8(at + 1, (n >> 8) & 0xff);
        v.setUint8(at + 2, (n >> 16) & 0xff);
        at += 3;
      }
    }
  }
  return buf;
}

/** 解出来那一串 PCM16 的第 i 个采样。 */
const at = (pcm: Uint8Array, i: number): number =>
  new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(i * 2, true);

describe("认得出来的那几种", () => {
  it("16 位单声道 16k：原样过，长度和时长都对得上", () => {
    const out = decodeWav(
      wav({ format: 1, bits: 16, channels: 1, rate: 16000, frames: 1600, sample: () => 0.5 }),
    );
    expect(out.sampleRate).toBe(TARGET_RATE);
    expect(out.pcm.length).toBe(1600 * 2);
    expect(out.seconds).toBeCloseTo(0.1, 3);
    expect(at(out.pcm, 10)).toBeGreaterThan(16000);
  });

  it("48k 降到 16k：采样数变成三分之一，时长不变", () => {
    const out = decodeWav(
      wav({ format: 1, bits: 16, channels: 1, rate: 48000, frames: 4800, sample: () => 0.25 }),
    );
    expect(out.pcm.length / 2).toBe(1600);
    expect(out.seconds).toBeCloseTo(0.1, 3);
  });

  it("双声道并成单声道 —— 取两边的平均，不是丢掉一边", () => {
    // 左满幅、右静音：并完应该在半幅上下。丢掉右声道的写法会得到满幅。
    const out = decodeWav(
      wav({
        format: 1,
        bits: 16,
        channels: 2,
        rate: 16000,
        frames: 800,
        sample: (_i, c) => (c === 0 ? 0.8 : 0),
      }),
    );
    expect(at(out.pcm, 100) / 32767).toBeCloseTo(0.4, 1);
  });

  it("24 位也认 —— 专业录音笔默认就录这个", () => {
    const out = decodeWav(
      wav({ format: 1, bits: 24, channels: 1, rate: 16000, frames: 800, sample: () => 0.5 }),
    );
    expect(at(out.pcm, 100) / 32767).toBeCloseTo(0.5, 1);
  });

  it("32 位浮点也认", () => {
    const out = decodeWav(
      wav({ format: 3, bits: 32, channels: 1, rate: 16000, frames: 800, sample: () => -0.5 }),
    );
    expect(at(out.pcm, 100) / 32767).toBeCloseTo(-0.5, 1);
  });

  it("浮点里超过 1 的采样夹住，不许绕回成一声爆音", () => {
    const out = decodeWav(
      wav({ format: 3, bits: 32, channels: 1, rate: 16000, frames: 800, sample: () => 1.8 }),
    );
    expect(at(out.pcm, 100)).toBe(32767);
  });

  it("WAVE_FORMAT_EXTENSIBLE：真正的编码在扩展块里，要去那儿读", () => {
    const out = decodeWav(
      wav({
        format: 0xfffe,
        fmtSize: 40,
        subFormat: 1,
        bits: 16,
        channels: 1,
        rate: 16000,
        frames: 800,
        sample: () => 0.5,
      }),
    );
    expect(out.pcm.length / 2).toBe(800);
  });

  it("中间插着 LIST / fact 这类杂块时，data 仍然找得到", () => {
    const out = decodeWav(
      wav({
        format: 1,
        bits: 16,
        channels: 1,
        rate: 16000,
        frames: 800,
        sample: () => 0.5,
        extra: [
          ["LIST", 26],
          ["fact", 4],
        ],
      }),
    );
    expect(out.pcm.length / 2).toBe(800);
    expect(at(out.pcm, 100) / 32767).toBeCloseTo(0.5, 1);
  });

  it("杂块长度是奇数时也不错位 —— RIFF 的块是双字节对齐的", () => {
    const out = decodeWav(
      wav({
        format: 1,
        bits: 16,
        channels: 1,
        rate: 16000,
        frames: 800,
        sample: () => 0.5,
        extra: [["LIST", 13]],
      }),
    );
    expect(at(out.pcm, 100) / 32767).toBeCloseTo(0.5, 1);
  });
});

describe("认不出来的要说清楚", () => {
  it("不是 WAV", () => {
    const buf = new ArrayBuffer(64);
    expect(() => decodeWav(buf)).toThrow(WavNotSupported);
  });

  it("8 位 PCM 这类没实现的编码，拒的那句话里要写清要什么", () => {
    let msg = "";
    try {
      decodeWav(wav({ format: 1, bits: 8, channels: 1, rate: 16000, frames: 100 }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("16 位");
  });

  it("空的 data 块", () => {
    expect(() =>
      decodeWav(wav({ format: 1, bits: 16, channels: 1, rate: 16000, frames: 0 })),
    ).toThrow(WavNotSupported);
  });
});
