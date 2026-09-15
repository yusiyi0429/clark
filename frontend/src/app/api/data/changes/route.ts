/**
 * 「库改过了」这条线。浏览器挂一个 `EventSource` 在这里，服务端一改就推一帧。
 *
 * 为什么要有它：读面全都关掉了 SWR 的自动重验证（`lib/use-resource.ts` 里讲了理由），
 * 于是**不是他点出来的**那些变化 —— 深研跑完、报告读成判断、一条信号被开成议题、
 * 预研落地 —— 在屏幕上根本不会出现，他得按 F5。号本身和为什么是全局一个号，见
 * `lib/data/revision.ts`。
 *
 * 只推一个数字，不推内容。推内容要在这里把「哪几个 key 受影响」列一遍，而列漏一个的
 * 表现就是屏幕上某处一直是旧值 —— 那张表迟早会跟 store 的四十来处写对不上。客户端
 * 收到号就把自己屏幕上挂着的那几份重问一遍，问的是 `/api/data`，鉴权、可见性、署名
 * 全走原来那一条路，这里一个字都不用重复。
 *
 * 编解码复用 `lib/agent/sse.ts`，和 `/api/stage`、`/api/chat` 是同一套；连接生命周期
 * 那几处（写不出去就当场退订、心跳、abort）也照 `/api/stage` 那一版，理由在那里。
 */
import { cookies } from "next/headers";

import { ACCESS_COOKIE_NAME, isAccessCookieValid } from "@/lib/access";
import { WHO_COOKIE_NAME, personIdFromToken } from "@/lib/identity";
import { encodeSse } from "@/lib/agent/sse";
import { revision, subscribeRevision } from "@/lib/data/revision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 25 秒一个注释帧。
 *
 * 有它才能察觉「这一头没了」：SSE 是服务端往下写，客户端悄悄走掉（关标签、笔记本
 * 合盖）不会通知服务端，只有下一次写不出去的时候才暴露。没有心跳的话一条死连接会
 * 一直挂在订阅名单上（同 `/api/stage`）。也顺手挡住中间那些代理的空闲超时。
 */
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  /*
   * 身份要验。
   *
   * `src/proxy.ts` 已经挡过一次（`/api/data` 那条前缀连带子路径都在名单里），但那一层
   * 只验签，认不认人是数据层的事 —— 和 `/api/data` 里同一句话、同一个理由。
   *
   * 这里**不查 `METHOD_SCOPE`**：这条线不返回任何内容，只说一句「库改过了」。谁能看见
   * 什么，在客户端拿着号回头问 `/api/data` 的时候照原样查一遍。
   */
  const jar = await cookies();
  const known =
    isAccessCookieValid(jar.get(ACCESS_COOKIE_NAME)?.value) ||
    Boolean(personIdFromToken(jar.get(WHO_COOKIE_NAME)?.value));
  if (!known) {
    return Response.json(
      { ok: false, error: "没有身份。" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      // 收摊要做的事先留个空位：写不出去的时候要能当场退订，而退订用的是下面才拿到的
      // `off`/`beat`。少了这一步，流断了订阅还挂着，名单只会越长（同 `/api/stage`）。
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
          close();
        }
      };

      const off = subscribeRevision((rev) => push(encodeSse("rev", { rev })));
      const beat = setInterval(() => push(`: beat\n\n`), HEARTBEAT_MS);
      teardown = () => {
        clearInterval(beat);
        off();
      };

      /*
       * 先报眼下这个号。
       *
       * 客户端断线重连（笔记本合盖、网切了）是 `EventSource` 自己做的，而断着的那几分钟
       * 里发生的改动**没有补发** —— 只有这一帧能让它发现「号比我上次见到的大」，从而
       * 补问一轮。没有这一帧，合过一次盖的屏幕就会一直停在合盖前那一份。
       */
      push(encodeSse("ready", { rev: revision() }));

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
