/**
 * 听写的音频小工具（纯函数，可单测）：降采样到 16k 单声道 PCM16、音量、WAV 封装、整段 PCM 的内存仓、发包限速。
 *
 * 采音链路：getUserMedia → AudioContext（默认采样率）→ AudioWorklet 每 40ms 交回一帧 Float32 →
 * 主线程用 Resampler16k 转成 16k PCM16（48k 是整 3 倍：3 点均值再抽取；44.1k 等用线性插值）。
 */

export const TARGET_RATE = 16000;
/** 发给腾讯的一包：200ms = 3200 个样本 = 6400 字节。 */
export const PACKET_SAMPLES = 3200;
/** 单次听写上限 5 分钟（整段 PCM 留在内存里供后备：每秒 32KB，5 分钟 9.6MB）。 */
export const MAX_DICTATION_SAMPLES = 5 * 60 * TARGET_RATE;

function toInt16(sample: number): number {
  const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/** 流式降采样：一帧一帧喂进来，跨帧的零头留到下一帧，输出 16k PCM16。 */
export class Resampler16k {
  private readonly factor: number;
  private readonly step: number;
  /** 整倍数：上一帧剩下不满一组的样本。 */
  private carry: number[] = [];
  /** 线性插值：下一个输出点在「本帧」里的位置（-1 代表上一帧最后一个样本）。 */
  private position = 0;
  private previous = 0;

  constructor(readonly inputRate: number) {
    if (!(inputRate >= TARGET_RATE)) throw new Error(`采样率 ${inputRate} 低于 16k`);
    const ratio = inputRate / TARGET_RATE;
    this.factor = Number.isInteger(ratio) ? ratio : 0;
    this.step = ratio;
  }

  push(input: Float32Array): Int16Array {
    if (this.factor === 1) return Int16Array.from(input, toInt16);
    if (this.factor > 1) {
      const all = this.carry.length ? [...this.carry, ...input] : input;
      const groups = Math.floor(all.length / this.factor);
      const out = new Int16Array(groups);
      for (let g = 0; g < groups; g++) {
        let sum = 0;
        for (let k = 0; k < this.factor; k++) sum += all[g * this.factor + k];
        out[g] = toInt16(sum / this.factor);
      }
      this.carry = Array.from(all.slice(groups * this.factor));
      return out;
    }
    const n = input.length;
    if (!n) return new Int16Array(0);
    const out: number[] = [];
    let pos = this.position;
    while (pos <= n - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.previous : input[i];
      const b = frac > 0 ? input[i + 1] : a;
      out.push(toInt16(a + (b - a) * frac));
      pos += this.step;
    }
    this.position = pos - n;
    this.previous = input[n - 1];
    return Int16Array.from(out);
  }
}

/** 一帧的音量（0–1）：均方根放大后截到 1，正常说话大约 0.2–0.6。 */
export function rmsLevel(frame: Float32Array): number {
  if (!frame.length) return 0;
  let energy = 0;
  for (const sample of frame) energy += sample * sample;
  return Math.min(1, Math.sqrt(energy / frame.length) * 4);
}

/** 16 位单声道 PCM 封成 WAV（44 字节头）：火山「录完再转」后备直接上传它。 */
export function encodeWav(pcm: Int16Array, sampleRate = TARGET_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return buffer;
}

/** 这次听写的整段 PCM：按 16k 样本下标取任意一段（发包、断线补发、后备上传共用）。 */
export class PcmStore {
  private chunks: Int16Array[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  append(chunk: Int16Array) {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  slice(from: number, to = this.total): Int16Array {
    const start = Math.max(0, Math.min(from, this.total));
    const end = Math.max(start, Math.min(to, this.total));
    const out = new Int16Array(end - start);
    let offset = 0;
    let written = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > start && offset < end) {
        const a = Math.max(start, offset) - offset;
        const b = Math.min(end, chunkEnd) - offset;
        out.set(chunk.subarray(a, b), written);
        written += b - a;
      }
      offset = chunkEnd;
      if (offset >= end) break;
    }
    return out;
  }
}

/**
 * 发包限速（令牌桶，单位：样本）。腾讯：1 秒内收到超过 3 秒音频直接报 4000。
 * 允许先冲 2 秒（握手前缓冲的那一包），之后最多按 2 倍实时补发（断线重连补发、停下时的尾巴）。
 */
export class Pacer {
  private tokens: number;
  private last: number;

  constructor(
    private readonly now: () => number,
    private readonly burst = 2 * TARGET_RATE,
    /** 每毫秒补多少样本：2 倍实时 = 32。 */
    private readonly perMs = (2 * TARGET_RATE) / 1000,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.perMs);
    this.last = t;
  }

  /** 想发 n 个样本：够就扣掉并返回 true。 */
  take(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** 还差多久才够发 n 个样本（毫秒）。 */
  waitFor(n: number): number {
    this.refill();
    return this.tokens >= n ? 0 : Math.ceil((n - this.tokens) / this.perMs);
  }
}

/**
 * AudioWorklet 处理器（用字符串生成 Blob URL 再 addModule，不经打包器）：把输入的第一路声道按 40ms 攒成一帧，
 * 整帧 Float32 可转移地交回主线程。降采样、转 PCM16、算音量都在主线程做（上面那些纯函数），这里越薄越稳。
 */
export const CAPTURE_PROCESSOR = "pcm16-capture";
export const CAPTURE_WORKLET_SOURCE = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = options && options.processorOptions && options.processorOptions.frameSamples;
    this.size = size || Math.round(sampleRate * 0.04);
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("${CAPTURE_PROCESSOR}", Pcm16Capture);
`;
