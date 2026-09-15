import { encodeSse } from "@/lib/agent/sse";
import { asrProvider, clientListenConfig, listenConfig, ASRNotConfigured } from "@/lib/asr";
import { getRelay, openRelay } from "@/lib/asr/relay";
import { DEFAULT_SESSION } from "@/lib/stage/bus";

/**
 * 听他说话那一条线。
 *
 * `GET`  —— 屏幕订阅识别结果（SSE）。这一下同时把中转建起来。
 * `POST` —— 上行：`application/octet-stream` 是一块 PCM16；`application/json` 是一条控制命令。
 *
 * 为什么是「两个请求」而不是一个 WebSocket：Route Handler 拿不到 WebSocket（官方文档写在
 * `docs/01-app/02-guides/backend-for-frontend.md`），双向流式请求体在 dev 的 HTTP/1.1 上也
 * 不行。拆成一条 SSE 加一串小 POST，用的是这个项目里已经跑通两次的两个机制 —— 少一种协议
 * 就少一类会上出问题的地方。整条链子的形状和取舍见 `lib/asr/relay.ts` 顶上那段。
 *
 * 厂商的 key 只在服务端读。前端从头到尾只看得见 PCM 和文字。
 */

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const session = sessionOf(req);

  /*
   * 先探一下厂商配没配。
   *
   * 放在开流**之前**：这时候响应头还没发，能老老实实回一个 503 加一句人话，前端据此把
   * 语音条那个输入框亮出来。等流开起来才发现，HTTP 状态码已经是 200 了，只能把错误当成
   * 一帧数据往下塞 —— 前端那边就分不清「没配 key」和「网断了」。播报层踩过这个坑。
   */
  try {
    asrProvider();
  } catch (e) {
    if (e instanceof ASRNotConfigured) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  const cfg = listenConfig();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      /* 收摊要做的事先留一个空位 —— 写不出去的时候要能当场退订。理由同 `/api/stage`。 */
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
          // 写不出去就是这一头没了。麦克风还在往上推的话，中转会一直开着厂商那条连接。
          close();
        }
      };

      const relay = openRelay(session, (event, data) => push(encodeSse(event, data)));
      const beat = setInterval(() => push(`: beat\n\n`), HEARTBEAT_MS);
      teardown = () => {
        clearInterval(beat);
        relay.close();
      };

      /*
       * 门槛、静音时长、分块大小一起下发。
       *
       * 前端不自己写一份默认值 —— 那样会议室里改了 `demo/voice.json` 之后，服务端按新值切句、
       * 前端按旧值判「他在说话」，两边错开。配置只有一个来源，这一帧就是它到前端的路。
       */
      push(encodeSse("ready", { session, config: clientListenConfig(cfg) }));

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
  const session = sessionOf(req);
  const relay = getRelay(session);
  /*
   * 409 而不是 404。
   *
   * 它的意思是「这条线还没建起来」，前端收到就去重连那条 SSE —— 而不是把麦克风关掉。会议室
   * 的 wifi 抖一下就会走到这里，那时候要的是自己接回去，不是让他发现语音没了。
   */
  if (!relay) {
    return Response.json({ error: "这一场的识别中转还没建立。" }, { status: 409 });
  }

  const type = req.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    let action: unknown;
    try {
      action = ((await req.json()) as { action?: unknown }).action;
    } catch {
      return Response.json({ error: "请求体不是 JSON。" }, { status: 400 });
    }
    // 提交完一句就 flush：让厂商把尾巴认完，下一句从一条干净的连接开始。
    if (action === "flush") relay.flush();
    else if (action === "close") relay.close();
    else return Response.json({ error: "这条命令读不懂。" }, { status: 400 });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return Response.json({ ok: true, bytes: 0 });
  relay.feed(new Uint8Array(buf));
  /*
   * 回一个很小的 JSON，不回 204。
   *
   * 前端要按这个回执判上行还活着 —— 每 120 毫秒一次，回执小到可以忽略，而「上行断了但麦克风
   * 灯还亮着」是这条链子上最难当场发现的一种故障。
   */
  return Response.json(
    { ok: true, bytes: buf.byteLength },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function sessionOf(req: Request): string {
  const s = new URL(req.url).searchParams.get("session");
  return s && s.trim() ? s.trim() : DEFAULT_SESSION;
}
