/**
 * 播报层的接口。厂商在这条线下面，换厂商不该动这条线上面任何一行。
 *
 * 为什么一定要有这一层：会前一天定的是阿里云百炼 CosyVoice，而会上真正会出问题的是额度、
 * 网络、和某个音色被下架。三件事都指向同一个动作 —— 换一家。所以厂商名字只出现在
 * `cosyvoice.ts` / `minimax.ts` 两个文件里，key 从环境变量来，音色语速从 `demo/voice.json`
 * 来，路由和前端只认这个 interface。
 *
 * 两个方法对应两条路：
 *
 * - `openStream` —— 会上现说。文字一段一段推进去，音频一块一块回来，边合边播。
 * - `synthesizeToFile` —— 会前预合成。固定台词批量落成文件，网断了照样有声音。
 *
 * 两条路走的是同一个厂商实现：预合成不是另写一遍，是把流接到文件上。所以「预合成跑通了」
 * 同时也证明了「现说这条路通」，这是会前唯一能拿到的那种保证。
 */

/** 音色和语速。都从 `demo/voice.json` 来，调用方一般只在试听脚本里显式传。 */
export interface TTSVoiceOpts {
  voice?: string;
  /** 语速倍率。1 是原速，1.1 稍快。 */
  speed?: number;
}

/**
 * 句边界。
 *
 * 字幕要跟着嘴走，就得知道现在念到哪一句 —— 而这件事只有厂商知道，它是按句合成的。
 * 厂商报得出来就报（CosyVoice 的 `sentence-begin` 带 `original_text`），报不出来这里
 * 一次都不响。字幕那边必须能在一次都不响的情况下正常工作：不能把「字幕有没有」押在
 * 一个我今晚验不了的字段上。
 */
export interface TTSMark {
  kind: "sentence";
  text: string;
}

export interface TTSStream {
  /** 推一段文字进去。可以是半句 —— 厂商那边自己攒到句末才开始合成。 */
  pushText(chunk: string): void;
  /** 没有更多文字了。厂商把尾巴合完就会收摊。 */
  endText(): void;
  /** 音频块。原始 PCM16、小端、单声道，采样率见 config。 */
  onAudio(cb: (chunk: Uint8Array) => void): void;
  /** 句边界。可选，见 `TTSMark`。 */
  onMark(cb: (mark: TTSMark) => void): void;
  /** 收摊。带 `err` 就是出错收的 —— 调用方要把这句话写到字幕上去，不许静默。 */
  onDone(cb: (err?: Error) => void): void;
  /**
   * 掐掉。
   *
   * 「停止播报」按下去之后，前端清播放队列是毫秒级的，但服务端这条流如果还挂着，厂商那边
   * 的字符还在计费、连接还占着额度。这个方法要真的把 socket 关掉，不是标一个 flag。
   */
  cancel(): void;
}

export interface TTSProvider {
  /** 厂商名。只用来写日志和回执，不参与任何判断。 */
  readonly name: string;
  openStream(sessionId: string, opts: TTSVoiceOpts): TTSStream;
  /** 合成到文件，返回文件路径。目录不存在会建。 */
  synthesizeToFile(text: string, opts: TTSVoiceOpts & { filePath: string }): Promise<string>;
}

/** 没配 key 的时候抛这个。路由要认出它，回一句人话，而不是 500。 */
export class TTSNotConfigured extends Error {}
