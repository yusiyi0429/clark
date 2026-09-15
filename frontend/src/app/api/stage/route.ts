import { encodeSse } from "@/lib/agent/sse";
import { parseStageEvent } from "@/lib/stage/events";
import {
  DEFAULT_SESSION,
  listenerCount,
  publish,
  subscribe,
  type BusMessage,
} from "@/lib/stage/bus";

/**
 * 秘书控制台那一条线。
 *
 * `GET`  —— 投影那块屏订阅（SSE）。一直挂着，没消息就每 25 秒一个注释帧当心跳。
 * `POST` —— 控制台推一条命令上来。要带 token。
 *
 * 为什么不做成 WebSocket：这条线是单向的（控制台推、屏幕收），SSE 就够，而且它和
 * `/api/chat` 共用同一套编解码（`lib/agent/sse.ts`），屏幕那边接收逻辑是同一个。少一种
 * 协议就少一类会上出问题的地方。
 *
 * 鉴权是一道很浅的门：环境变量里一个 token，控制台带在请求头上。它挡的是「同一个网段
 * 里别人误开了这个页面」，不是攻击者 —— 这条路由只在会议室的这一台机器上活着。没配
 * token 就直接拒，不留「没配就放行」的口子：那种口子会一路活到线上。
 */

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const session = sessionOf(req);
  const encoder = new TextEncoder();

  /*
   * `?probe=1` —— 只问「有几块屏连着」，不订阅。
   *
   * 控制台要在按任何键**之前**就知道屏幕接上了没有。如果它靠订阅来知道，它自己就成了
   * 一个订阅者，那个数字会永远比真实多一 —— 而秘书看着「1 块屏在听」按下去，东西却
   * 没上投影，这是会上最难查的一种错。
   */
  if (new URL(req.url).searchParams.get("probe")) {
    return Response.json(
      { screens: listenerCount(session) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      /*
       * 收摊要做的事，在 `push` 之前先留一个空位。
       *
       * 顺序被一件事逼成这样：写不出去的时候必须能当场退订，而退订要用到下面才拿到的
       * `off` 和 `beat`。第一版写的是 `catch { open = false }` —— 那一版的账是错的：
       * 流已经断了，订阅还挂在总线上，`listenerCount` 从此永远多算一块屏。秘书看着
       * 「1 块屏在听」按下去、投影上什么都没发生，就是从这里出来的。
       */
      let teardown = () => {};

      const close = () => {
        if (!open) return;
        open = false;
        teardown();
        try {
          controller.close();
        } catch {
          /* 已经关了。 */
        }
      };

      const push = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 写不出去就是这一头没了。连心跳都推不动的时候，这是唯一能察觉的时机。
          close();
        }
      };

      const off = subscribe(session, (message: BusMessage) => push(encodeSse("bus", message)));
      const beat = setInterval(() => push(`: beat\n\n`), HEARTBEAT_MS);
      teardown = () => {
        clearInterval(beat);
        off();
      };

      // 屏幕要知道自己接上了 —— 控制台上那个「已连接」是靠这一帧点亮的。
      push(encodeSse("ready", { session }));

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "服务端没有配 OPERATOR_TOKEN，控制台现在推不了东西。" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-operator-token") !== expected) {
    return Response.json({ error: "口令不对。" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是 JSON。" }, { status: 400 });
  }

  const message = readMessage(body);
  if (!message) return Response.json({ error: "这条命令读不懂。" }, { status: 400 });

  const session = sessionOf(req);
  const screens = publish(session, message);
  // 推给了几块屏。0 就是屏幕没连上 —— 控制台必须当场看见这个 0，而不是以为按下去了。
  return Response.json({ screens, listening: listenerCount(session) }, {
    headers: { "Cache-Control": "no-store" },
  });
}

function sessionOf(req: Request): string {
  const s = new URL(req.url).searchParams.get("session");
  return s && s.trim() ? s.trim() : DEFAULT_SESSION;
}

function readMessage(body: unknown): BusMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const { kind } = body as { kind?: unknown };
  if (kind === "stop" || kind === "explore" || kind === "replay" || kind === "wake") {
    return { kind };
  }
  if (kind === "play") {
    const { lineId } = body as { lineId?: unknown };
    if (typeof lineId !== "string" || !lineId.trim()) return null;
    return { kind: "play", lineId: lineId.trim() };
  }
  if (kind === "mic") {
    const { on } = body as { on?: unknown };
    return { kind: "mic", on: on === true };
  }
  if (kind === "advance") {
    const { delta } = body as { delta?: unknown };
    return { kind: "advance", delta: delta === -1 ? -1 : 1 };
  }
  if (kind === "say") {
    const { text } = body as { text?: unknown };
    if (typeof text !== "string" || !text.trim()) return null;
    return { kind: "say", text: text.trim() };
  }
  if (kind === "event") {
    const event = parseStageEvent((body as { event?: unknown }).event);
    return event ? { kind: "event", event } : null;
  }
  return null;
}
