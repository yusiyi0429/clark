/**
 * 听的那一层的接口。厂商在这条线下面，换厂商不该动这条线上面任何一行。
 *
 * 形状故意贴着 `lib/tts/types.ts`：一个 `openStream`，推数据进去、回调出来、`cancel` 掐掉。
 * 两层长得一样是有代价的（ASR 其实不需要 `synthesizeToFile` 那种第二条路），但换来的是
 * 一件更值钱的事 —— 会上出问题的时候，两层的排查路径是同一条：先看服务端有没有 key，
 * 再看厂商回了什么 `error_message`，再看前端收到几帧。
 *
 * key 只在服务端读，一次都不下发到前端。这是任务书里点名的一条。
 */

/** 识别参数。都从 `demo/voice.json` 的 `listen` 段来。 */
export interface ASROpts {
  /** 采样率。前端 `AudioContext` 用同一个数建，两边必须一致。 */
  sampleRate: number;
  /**
   * 静了多久算一句说完。
   *
   * 这个数交给厂商的 VAD（CosyVoice 那家叫 `max_sentence_silence`），所以「700 毫秒静音
   * 就收句」这件事主要是厂商在做，前端那个同名定时器只是它不响时候的保险。
   */
  silenceMs: number;
}

/**
 * 识别出来的一句。
 *
 * `key` 是这句话的身份，`final` 之前会带着同一个 `key` 报很多次（一个字一个字长出来）。
 * 前端靠 `key` 去重 —— 厂商的 `sentence_end` 和前端自己那个静音定时器可能都想提交同一句，
 * 没有 `key` 就会往 Agent 那一轮里塞两遍同样的话，而那在会上表现为参谋把同一个问题答两次。
 */
export interface ASRResult {
  key: string;
  text: string;
  final: boolean;
}

export interface ASRStream {
  /** 推一块音频。PCM16、小端、单声道。 */
  pushAudio(pcm: Uint8Array): void;
  /** 没有更多音频了。厂商把尾巴认完就收摊 —— 所以它和 `cancel` 不是一回事。 */
  endAudio(): void;
  onResult(cb: (result: ASRResult) => void): void;
  /** 收摊。带 `err` 就是出错收的，调用方要让前端知道，不许静默地不识别。 */
  onDone(cb: (err?: Error) => void): void;
  /** 掐掉。真的关 socket —— 挂着的连接在厂商那边占额度。 */
  cancel(): void;
}

export interface ASRProvider {
  /** 厂商名。只用来写日志和回执，不参与任何判断。 */
  readonly name: string;
  openStream(sessionId: string, opts: ASROpts): ASRStream;
}

/** 没配 key 的时候抛这个。路由要认出它，回一句人话加 503，而不是 500。 */
export class ASRNotConfigured extends Error {}
