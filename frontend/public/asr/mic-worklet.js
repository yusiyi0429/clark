/**
 * 麦克风那一端，跑在音频线程上。
 *
 * 它故意很笨：**攒够一块就往主线程扔，附一个音量，不做任何判断。** 「他是不是在说话」
 * 「这是不是抢话」「这一句说完了没有」全部在主线程的 `lib/stage/listener.ts` 里做。
 *
 * 这样分是因为音频线程上的代码调不了、看不见、也不能在会上改：它每 2.7 毫秒被叫一次
 * （128 个采样），里面放一个判断错了的阈值，表现是「麦克风灯亮着但一个字都不出来」，
 * 而且没有任何地方能打印出来看。判断留在主线程，会议室里改 `demo/voice.json` 就能调。
 *
 * 往上扔的是 Float32（不是 PCM16），因为浏览器给的采样率不一定就是要的那个 —— 万一不是，
 * 主线程还要重采样一次，那一步得在转成整数之前做。
 */

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ms = (options && options.processorOptions && options.processorOptions.chunkMs) || 120;
    // `sampleRate` 是音频线程的全局量，就是这个 context 真实的采样率。
    this.size = Math.max(128, Math.round((sampleRate * ms) / 1000));
    this.buf = new Float32Array(this.size);
    this.at = 0;
    this.sum = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // 麦克风还没开始出数据的时候这里是空的。返回 true 让这个节点活着等它。
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      this.buf[this.at++] = s;
      this.sum += s * s;

      if (this.at === this.size) {
        const buffer = this.buf.buffer;
        this.port.postMessage(
          {
            audio: buffer,
            /* 这一块的均方根，0–1。主线程拿它跟阈值比。 */
            rms: Math.sqrt(this.sum / this.size),
            rate: sampleRate,
          },
          // 转移所有权，不复制 —— 一秒 8 块，复制的那份纯属浪费。
          [buffer],
        );
        this.buf = new Float32Array(this.size);
        this.at = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic", MicProcessor);
