import { listenConfig } from "./config";
import { ASRNotConfigured, type ASROpts, type ASRProvider, type ASRStream } from "./types";

/**
 * 阿里云百炼（DashScope）实时语音识别，WebSocket 双工。
 *
 * 和播报层那家是**同一个端点、同一个 key、同一套四步协议**（见 `lib/tts/cosyvoice.ts` 顶上
 * 那段）。这不是巧合，是选它的理由：会前只需要配一个 `DASHSCOPE_API_KEY`，两层一起活；
 * 而会上如果这个 key 出了问题（额度、风控），两层一起死 —— 一起死比一半死好，因为一半死
 * 的那种状态最难现场判断。
 *
 * 和播报层的差别只有两处：
 *
 * 1. **音频是往上推的**，而且走二进制帧。不是 `continue-task` 那种 JSON —— PCM 塞进 JSON
 *    要先 base64，白涨三分之一的体积，而这条路上每 120 毫秒就有一块。
 * 2. **句子是厂商切的**。`semantic_punctuation_enabled: false` 时它按静音切，静多久算一句
 *    由 `max_sentence_silence` 定 —— 任务书里那个「700 毫秒静音就收句」正好落在这个参数上。
 *    所以前端那个同名定时器只是保险，不是主力。
 *
 * key 只在服务端读，一次都不下发到前端。
 */

const READY_TIMEOUT_MS = 8_000;

export function paraformer(): ASRProvider {
  /* key 在这一层读掉。和播报层同一条理由：没配 key 要能回 503，不能回 200 加一帧错误。 */
  const key = apiKey();
  return {
    name: "paraformer",
    openStream: (sessionId, opts) => open(sessionId, opts, key),
  };
}

function apiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY ?? process.env.ASR_API_KEY;
  if (!key) {
    throw new ASRNotConfigured(
      "没配 DASHSCOPE_API_KEY，语音识别现在听不见。语音条那个输入框还能用。",
    );
  }
  return key;
}

function open(sessionId: string, opts: ASROpts, key: string): ASRStream {
  const cfg = listenConfig();
  const taskId = crypto.randomUUID();

  let result: (r: { key: string; text: string; final: boolean }) => void = () => {};
  let done: (err?: Error) => void = () => {};

  let settled = false;
  let cancelled = false;
  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    done(err);
  };

  /*
   * `task-started` 之前推进来的音频先攒着。
   *
   * 这个队列不是可选的：握手要一个 RTT，而前端是「判断出他开口了」就立刻开始发的（还带着
   * 400 毫秒的前置缓冲）。没有这个队列，每句话的开头都会被吃掉一截 —— 而开头那几个字正是
   * 「他到底问了什么」最关键的部分。
   */
  let started = false;
  const pending: Uint8Array[] = [];
  let ended = false;

  /*
   * 带请求头开 WebSocket。
   *
   * `Authorization` 必须在握手那一下带上，而 WHATWG 的构造函数签名里没有放请求头的地方 ——
   * Node（undici）额外收一个 options 对象。理由和实测记录见 `lib/tts/cosyvoice.ts`。
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
      finish(new Error("语音识别握手超时：8 秒内没收到 task-started。"));
    }
  }, READY_TIMEOUT_MS);

  const send = (frame: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  };

  const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });

  const pushOne = (pcm: Uint8Array) => {
    if (ws.readyState !== WebSocket.OPEN || !pcm.byteLength) return;
    /*
     * 复制一份再发。
     *
     * `pcm` 很可能是某个更大的 buffer 上的一个视图（路由那边是从请求体上切下来的），而
     * `ws.send` 对 `Uint8Array` 的处理在 undici 里是把**整个底层 buffer** 发出去的 ——
     * 那样厂商会收到一段前后带着别人数据的音频，表现为每句话夹一声杂音。
     */
    ws.send(pcm.slice().buffer);
  };

  ws.onopen = () => {
    send({
      header: header("run-task"),
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: cfg.model,
        parameters: {
          format: "pcm",
          sample_rate: opts.sampleRate,
          /*
           * 按静音切句，不按语义。
           *
           * 语义切句（`semantic_punctuation_enabled: true`）标点更漂亮，但它要等后文才敢
           * 断句 —— 那意味着他说完话之后还要多等一截才轮到参谋开口。这一场要的是轮次快，
           * 不是标点好看。
           */
          semantic_punctuation_enabled: false,
          max_sentence_silence: opts.silenceMs,
          /* 「呃」「那个」不用送到模型那一轮去。 */
          disfluency_removal_enabled: true,
          language_hints: ["zh", "en"],
        },
        input: {},
      },
    });
  };

  ws.onmessage = (e: MessageEvent) => {
    // 识别这条路上二进制帧没有用处（音频是我们往上推的），来了也忽略。
    if (typeof e.data !== "string") return;

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
        while (pending.length) pushOne(pending.shift() as Uint8Array);
        if (ended) send({ header: header("finish-task"), payload: { input: {} } });
        break;

      case "result-generated": {
        const sentence = msg.payload?.output?.sentence;
        if (!sentence) break;
        const text = (sentence.text ?? "").trim();
        if (!text) break;
        /*
         * 用 `begin_time` 当这句话的身份。
         *
         * 它是这句话在音频里的起点（毫秒），同一句的每一次增量报的都是同一个值，下一句必然
         * 不同 —— 正好是前端去重需要的那个 key。厂商没有给「第几句」这种编号，`end_time`
         * 会随着他继续说而变，都不能拿来当身份。
         */
        result({
          key: `s${sentence.begin_time ?? 0}`,
          text,
          final: sentence.sentence_end === true,
        });
        break;
      }

      case "task-finished":
        finish();
        break;

      case "task-failed":
        finish(
          new Error(
            `语音识别失败：${msg.header.error_message ?? "厂商没说原因"}（${msg.header.error_code ?? "无错误码"}）`,
          ),
        );
        break;
    }
  };

  ws.onerror = () => {
    // undici 的 error 事件不带原因，能说的只有「连不上」。
    finish(new Error("语音识别连不上（WebSocket 出错）。"));
  };

  ws.onclose = () => {
    // 没收到 task-finished 就断了。掐掉的那次不算错。
    finish(cancelled ? undefined : new Error("语音识别连接提前断开。"));
  };

  void sessionId; /* 厂商这边不需要它；留着是为了两层的 `openStream` 签名一致。 */

  return {
    pushAudio(pcm: Uint8Array) {
      if (settled || ended) return;
      if (!started) {
        pending.push(pcm.slice());
        return;
      }
      pushOne(pcm);
    },
    endAudio() {
      if (settled || ended) return;
      ended = true;
      // 还没握手完就别急着发 finish-task —— 抢跑会被判协议错，`task-started` 那边会补发。
      if (started) send({ header: header("finish-task"), payload: { input: {} } });
    },
    onResult(cb) {
      result = cb;
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
      sentence?: {
        begin_time?: number;
        end_time?: number | null;
        text?: string;
        sentence_end?: boolean;
      };
    };
  };
}
