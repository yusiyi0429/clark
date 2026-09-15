/**
 * 给一段裸 PCM 套一个 WAV 头。
 *
 * 只为一件事存在：**试听**。裸 `.pcm` 双击打不开，而试听的整个意义就是会前十一点有人戴着
 * 耳机一个一个听、然后在 `demo/voice.json` 里填两个值。给它 44 个字节的头，就变成一个能
 * 双击播放的文件。
 *
 * 会上播放那条路不用它：前端拿到的是裸 PCM，自己建 AudioBuffer，不需要头。
 */

export function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const bytesPerSample = 2;
  const channels = 1;

  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 1 = 无压缩 PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // 字节率
  view.setUint16(32, channels * bytesPerSample, true); // 块对齐
  view.setUint16(34, bytesPerSample * 8, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
