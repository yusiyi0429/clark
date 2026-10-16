import { describe, expect, it } from "vitest";
import { encodeWav, Pacer, PcmStore, Resampler16k, rmsLevel } from "./dictationAudio";

const sine = (rate: number, seconds: number, amplitude = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / rate));

describe("降采样到 16k PCM16", () => {
  it("48k：整 3 倍，3 点均值再抽取；跨帧零头留到下一帧，总样本数不丢", () => {
    const resampler = new Resampler16k(48000);
    // 40ms 一帧 = 1920 个样本；故意切成不是 3 的倍数的帧
    const input = sine(48000, 1);
    let total = 0;
    for (let at = 0; at < input.length; at += 1000) total += resampler.push(input.subarray(at, at + 1000)).length;
    expect(total).toBe(16000);
    const exact = new Resampler16k(48000).push(Float32Array.of(0.3, 0.6, 0.9, -0.3, -0.6, -0.9));
    expect(Array.from(exact)).toEqual([Math.round(0.6 * 0x7fff), Math.round(-0.6 * 0x8000)]);
  });

  it("44.1k：线性插值，1 秒约 16000 个样本（误差 ≤1）", () => {
    const resampler = new Resampler16k(44100);
    const input = sine(44100, 1);
    let total = 0;
    for (let at = 0; at < input.length; at += 1764) total += resampler.push(input.subarray(at, at + 1764)).length;
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
  });

  it("截幅：超过 ±1 的样本压到 Int16 两端；16k 原样转换", () => {
    const out = new Resampler16k(16000).push(Float32Array.of(2, -3, 0, 1, -1));
    expect(Array.from(out)).toEqual([32767, -32768, 0, 32767, -32768]);
    const fromHigh = new Resampler16k(48000).push(Float32Array.of(5, 5, 5));
    expect(fromHigh[0]).toBe(32767);
  });

  it("低于 16k 的采样率不支持", () => {
    expect(() => new Resampler16k(8000)).toThrow();
  });
});

describe("音量", () => {
  it("静音是 0，说话在 0–1 之间，太响截到 1", () => {
    expect(rmsLevel(new Float32Array(640))).toBe(0);
    const level = rmsLevel(sine(16000, 0.04, 0.1));
    expect(level).toBeGreaterThan(0.2);
    expect(level).toBeLessThan(0.5);
    expect(rmsLevel(Float32Array.from({ length: 640 }, () => 0.9))).toBe(1);
  });
});

describe("WAV 封装", () => {
  it("44 字节头：RIFF / WAVE / PCM 单声道 16k 16 位，数据小端", () => {
    const pcm = Int16Array.of(1, -2, 32767);
    const wav = encodeWav(pcm);
    const view = new DataView(wav);
    const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(wav, at, n));
    expect(wav.byteLength).toBe(44 + 6);
    expect(text(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([1, -2, 32767]);
  });
});

describe("整段 PCM 的内存仓", () => {
  it("按样本下标跨块取任意一段", () => {
    const store = new PcmStore();
    store.append(Int16Array.of(0, 1, 2));
    store.append(Int16Array.of(3, 4));
    store.append(Int16Array.of(5, 6, 7, 8));
    expect(store.length).toBe(9);
    expect(Array.from(store.slice(2, 6))).toEqual([2, 3, 4, 5]);
    expect(Array.from(store.slice(7))).toEqual([7, 8]);
    expect(Array.from(store.slice(20))).toEqual([]);
  });
});

describe("发包限速", () => {
  it("先冲一小包，之后最多 2 倍实时", () => {
    let now = 0;
    const pacer = new Pacer(() => now, 12800);
    expect(pacer.take(12800)).toBe(true);
    expect(pacer.take(3200)).toBe(false);
    expect(pacer.waitFor(3200)).toBe(100);
    now = 100;
    expect(pacer.take(3200)).toBe(true);
    // 补满也不超过冲量上限
    now = 100000;
    expect(pacer.take(12800)).toBe(true);
    expect(pacer.take(1)).toBe(false);
  });
});
