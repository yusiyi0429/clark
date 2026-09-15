import { asrProvider } from "./index";
import { listenConfig } from "./config";
import type { ASRStream } from "./types";

/**
 * 浏览器的麦克风 → 厂商的识别连接，中间这一段。
 *
 * ## 为什么需要一个「中转」这种东西
 *
 * 前端要往上推音频，服务端要往下推识别结果，而 **Next 的 Route Handler 拿不到 WebSocket**
 * —— 官方文档写得很直接（`docs/01-app/02-guides/backend-for-frontend.md`：连接会在超时或者
 * 响应生成之后关掉）。双向流式的 HTTP 请求体在 dev 下也不行，那要 HTTP/2 的 duplex。
 *
 * 所以这条路被拆成两个已经在这个项目里跑通的机制：
 *
 *   上行：`POST /api/listen` 一块一块的二进制 PCM（每 120 毫秒一块）
 *   下行：`GET  /api/listen` SSE，和 `/api/chat`、`/api/stage` 同一套编解码
 *
 * 两个请求要说上话，就得有个东西活在请求之外 —— 就是这个文件。它和 `lib/stage/bus.ts`
 * 是同一个路数，也继承同一个诚实的限制：**进程内内存**。控制台、屏幕、麦克风必须连到同一个
 * Node 进程。`next dev` 是单进程，会议室那台笔记本也是单进程，条件成立。哪天部署成多实例，
 * 这条中转会静默失效 —— 那时候要换成一个真的外部中转，不是在这里打补丁。
 *
 * ## 厂商那条连接不是一直开着的
 *
 * 开着要花钱，而且空转到一定时间厂商自己会断。所以：**第一块音频到了才开，静一会儿就关，
 * 下一块音频到了再开。** 参谋念稿的那半分钟前端根本不发音频（半双工，见
 * `lib/stage/listener.ts`），那半分钟这条连接是关着的。
 *
 * 重开的代价是一次握手（一个 RTT），而它被前端那个前置缓冲盖住了 —— 前端判断出他开口时会
 * 把之前 400 毫秒的音频一起补发，握手排在这段音频前面，第一个字不会丢。
 */

const relays = new Map<string, Relay>();

/** 连续几次开不起来就认输，让前端去用输入框。 */
const GIVE_UP_AFTER = 3;

export interface Relay {
  readonly session: string;
  /** 推一块音频进去。厂商那条连接没开就顺手开一条。 */
  feed(pcm: Uint8Array): void;
  /**
   * 他说完了 —— 把厂商那条连接收尾。
   *
   * 和 `close` 的区别是这个会等厂商把尾巴认完（`endAudio`），最后那半句还会回来。前端在
   * 提交完一句之后调它，所以下一句是一条干净的新连接，不会带着上一句的上下文。
   */
  flush(): void;
  /** 整个中转收摊。页面关了、换了一个订阅者、或者会散了。 */
  close(): void;
}

/**
 * 开一个中转，同时它就是那个订阅者。
 *
 * 一个 session 只留一个：页面刷新会带来第二个 `GET`，那时候旧的那个已经是个死连接了 ——
 * 不把它换掉，识别结果会推给一个没人在看的流。
 */
export function openRelay(
  session: string,
  push: (event: string, data: unknown) => void,
): Relay {
  relays.get(session)?.close();

  const cfg = listenConfig();
  let stream: ASRStream | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let failures = 0;

  const clearIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };

  /** 放掉厂商那条连接的引用。下一块音频会开一条新的。 */
  const drop = () => {
    clearIdle();
    stream = null;
  };

  const ensure = (): ASRStream | null => {
    if (closed || stream) return stream;
    if (failures >= GIVE_UP_AFTER) return null;

    let opened: ASRStream;
    try {
      opened = asrProvider().openStream(session, {
        sampleRate: cfg.sampleRate,
        silenceMs: cfg.silenceMs,
      });
    } catch (e) {
      failures++;
      /*
       * 开不起来。第一次就要说出来 —— 没配 key 是最常见的一种，而这时候前端必须知道
       * 「麦克风这条路今天不通」，好把那个输入框亮出来。三次之后不再重试。
       */
      push("error", {
        message: e instanceof Error ? e.message : "语音识别起不来。",
        fatal: failures >= GIVE_UP_AFTER,
      });
      return null;
    }

    opened.onResult((r) => {
      if (closed) return;
      failures = 0;
      push(r.final ? "final" : "partial", r);
    });

    opened.onDone((err) => {
      if (closed) return;
      /*
       * 厂商那条连接断了。
       *
       * 大多数时候这是正常收尾（我们自己 `flush` 的，或者空转到点了）。真的出错时也不当场
       * 报给屏幕 —— 断一次会自己重开，而每断一次就在投影上写一行错误，那比不识别更难看。
       * 只有连着开不起来（`failures`）才报出去。
       */
      if (err) failures++;
      if (stream === opened) drop();
      if (err && failures >= GIVE_UP_AFTER) {
        push("error", { message: err.message, fatal: true });
      }
    });

    stream = opened;
    return stream;
  };

  const relay: Relay = {
    session,

    feed(pcm: Uint8Array) {
      if (closed || !pcm.byteLength) return;
      const s = ensure();
      if (!s) return;
      s.pushAudio(pcm);

      // 空转计时重新起表。这一块音频之后静了 `idleMs`，就把厂商那条连接收掉。
      clearIdle();
      idle = setTimeout(() => {
        idle = null;
        stream?.endAudio();
      }, cfg.idleMs);
    },

    flush() {
      if (closed) return;
      clearIdle();
      stream?.endAudio();
    },

    close() {
      if (closed) return;
      closed = true;
      clearIdle();
      stream?.cancel();
      stream = null;
      if (relays.get(session) === relay) relays.delete(session);
    },
  };

  relays.set(session, relay);
  return relay;
}

/** 上行那条 POST 找的就是它。找不到说明屏幕那条 SSE 还没建立或者已经断了。 */
export const getRelay = (session: string): Relay | undefined => relays.get(session);
