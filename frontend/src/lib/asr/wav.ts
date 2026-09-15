/**
 * 把一份 WAV 拆成识别那一侧要的东西：**16 kHz、单声道、PCM16、小端。**
 *
 * ## 为什么只认 WAV
 *
 * 会后交上来的那份录音要走的是同一家实时识别（`paraformer.ts`），而它收的就是这一种
 * PCM。MP3 / M4A / OGG 要先解码，而纯 JS 解码器意味着往这个仓库里塞一个几百 KB 的
 * 二进制解析器，或者在镜像里装 ffmpeg —— 两条都不是「会后传一份录音」这件事该付的代价。
 *
 * 所以这一层的规矩是**认得出就认，认不出就照实说**：拒的那句话里写清要什么格式，以及
 * 还有一条不用转码的路（直接贴会议记录的文字）。给一个「正在处理」然后静默失败，比
 * 当场拒掉糟得多。
 *
 * ## 重采样是线性插值，够用
 *
 * 语音识别的输入带宽只到 8 kHz（16 kHz 采样），而降采样（48 k → 16 k 是最常见的一种）
 * 用线性插值引入的混叠落在这个带宽的边上，对识别率的影响远小于房间混响。为它上一套
 * 多相滤波器，是在一条不影响结果的路上花力气。
 */

/** 一份认出来的音频。`sampleRate` 已经是 16000 —— 这个类型只在转换之后出现。 */
export type DecodedPcm = {
  pcm: Uint8Array;
  sampleRate: number;
  /** 多长，秒。屏幕上要说得出「这份录音多长」。 */
  seconds: number;
};

/** 识别那一侧要的采样率。和 `listenConfig().sampleRate` 是同一个数，那边是配置，这里是目标。 */
export const TARGET_RATE = 16000;

export class WavNotSupported extends Error {}

const ascii = (view: DataView, at: number, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(view.getUint8(at + i));
  return s;
};

/**
 * 走一遍 RIFF 的块表，把 `fmt ` 和 `data` 挑出来。
 *
 * 不假设 `data` 紧跟在 `fmt ` 后面：录音软件常常在中间插 `LIST`（写软件名）、`fact`、
 * 甚至几 KB 的 `bext`（广播元数据）。按固定偏移取的那种写法在自己录的文件上一直是对的，
 * 换一台设备录的就会把元数据当成音频，听起来是一片白噪。
 */
function chunks(view: DataView): Record<string, { at: number; size: number }> {
  const out: Record<string, { at: number; size: number }> = {};
  let at = 12; /* RIFF(4) + size(4) + WAVE(4) */
  while (at + 8 <= view.byteLength) {
    const id = ascii(view, at, 4);
    const size = view.getUint32(at + 4, true);
    out[id] = { at: at + 8, size };
    // 块是双字节对齐的：奇数长度后面补一个字节，不跳过它下一块的 id 就错位一位。
    at += 8 + size + (size % 2);
  }
  return out;
}

/**
 * 解一份 WAV。认不出就抛 `WavNotSupported`，**消息可以直接上屏**。
 *
 * 收三种编码：PCM16、PCM24、32 位浮点。24 位单独收是因为专业录音笔默认就录这个，
 * 而它在别处（浏览器、剪辑软件）都能正常播放 —— 拒掉它，用户看到的是「我的文件明明
 * 是 WAV」。
 */
export function decodeWav(buf: ArrayBuffer): DecodedPcm {
  if (buf.byteLength < 44) throw new WavNotSupported("这个文件太小了，不像一份录音。");
  const view = new DataView(buf);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new WavNotSupported("这不是一份 WAV。");
  }

  const cs = chunks(view);
  const fmt = cs["fmt "];
  const data = cs["data"];
  if (!fmt || !data) throw new WavNotSupported("这份 WAV 缺 fmt 或 data 块，读不出音频。");

  let format = view.getUint16(fmt.at, true);
  const channels = view.getUint16(fmt.at + 2, true);
  const rate = view.getUint32(fmt.at + 4, true);
  const bits = view.getUint16(fmt.at + 14, true);
  /*
   * `WAVE_FORMAT_EXTENSIBLE`（0xFFFE）。Windows 的录音机默认就写这个头，而真正的编码
   * 藏在扩展块开头那两个字节里。不认它的话，Windows 上录的每一份 WAV 都会被拒掉 ——
   * 而那恰好是最可能被交上来的那一种。
   */
  if (format === 0xfffe && fmt.size >= 40) format = view.getUint16(fmt.at + 24, true);

  if (channels < 1 || channels > 8) throw new WavNotSupported(`声道数读出来是 ${channels}，读不下去。`);
  if (!rate || rate > 192000) throw new WavNotSupported(`采样率读出来是 ${rate}，读不下去。`);

  /** 一帧（所有声道各一个采样）的样本，已经归一到 −1..1。 */
  let frames: number;
  let sampleAt: (frame: number, ch: number) => number;

  if (format === 1 && bits === 16) {
    frames = Math.floor(data.size / (2 * channels));
    sampleAt = (f, c) => view.getInt16(data.at + (f * channels + c) * 2, true) / 32768;
  } else if (format === 1 && bits === 24) {
    frames = Math.floor(data.size / (3 * channels));
    sampleAt = (f, c) => {
      const at = data.at + (f * channels + c) * 3;
      // 小端三字节有符号：高位那个字节带符号，左移 16 位之后按 32 位整数补齐。
      const v = (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16));
      return v / 8388608;
    };
  } else if (format === 3 && bits === 32) {
    frames = Math.floor(data.size / (4 * channels));
    sampleAt = (f, c) => view.getFloat32(data.at + (f * channels + c) * 4, true);
  } else {
    throw new WavNotSupported(
      `这份 WAV 的编码读不了（format ${format}、${bits} 位）。要的是 16 位或 24 位 PCM，或者 32 位浮点。`,
    );
  }

  if (frames === 0) throw new WavNotSupported("这份 WAV 里没有音频。");

  /*
   * 先并成单声道，再重采样。顺序反过来（先重采样再并）要对每个声道各做一次插值，
   * 结果一样、代价乘以声道数。
   */
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += sampleAt(f, c);
    mono[f] = sum / channels;
  }

  const outFrames = Math.max(1, Math.round((frames * TARGET_RATE) / rate));
  const pcm = new Uint8Array(outFrames * 2);
  const out = new DataView(pcm.buffer);
  const step = frames / outFrames;
  for (let i = 0; i < outFrames; i += 1) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(frames - 1, i0 + 1);
    const t = x - i0;
    const v = mono[i0] * (1 - t) + mono[i1] * t;
    // 夹到 −1..1 再放大。不夹的话，浮点源里超过 1 的采样会绕回成一声爆音。
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
    out.setInt16(i * 2, Math.round(clamped * 32767), true);
  }

  return { pcm, sampleRate: TARGET_RATE, seconds: frames / rate };
}
