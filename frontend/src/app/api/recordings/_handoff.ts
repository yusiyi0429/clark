/**
 * 「改完状态之后，谁把流水线叫起来」——`[id]/retry` 和 `[id]/finish` 共用的那一下。
 *
 * ## 为什么这两个动作不能走 `/api/data`
 *
 * 那条是 JSON-RPC，它对所有方法一视同仁：调完、落盘、返回。而这两个方法改完状态之后
 * **还差一步** —— 把 `lib/recording/pipeline.ts` 那个圈叫起来（`kick()`）。流水线在没活
 * 的时候会把自己的定时器停掉（见那个文件头），所以「只把状态推回 `uploaded`」在队列
 * 空着的时候等于什么都没发生：接口返回 ok、状态真的翻回去了、屏幕上写着「排队中」，
 * 然后永远停在那里 —— 没有报错、没有进度，看起来就像在排队。
 *
 * 让通用 RPC 路由认得「这几个方法调完要 kick 一下」，等于在那一层维护一张方法名表；
 * 而让 `store.ts` 自己去 `import kick`，会把对象库和这条纯 node 的流水线绑死（那条
 * 分层的理由写在 `store.retryRecording` 上）。所以两个动作各走一条自己的路由 ——
 * 和 `/api/recordings/upload` 一样：**调 store 的方法，然后 `kick()`。**
 *
 * ## 身份
 *
 * `/api/recordings/*` 不在 `src/proxy.ts` 的 `PUBLIC_PATHS` 也不在 `DRI_PATHS` 里，
 * 也就是说走到这里的一定带着一号位那把口令（`METHOD_SCOPE` 给这两个方法标的正是
 * `ceo`）。所以这里直接 `CEO_ACTOR`，和上传那条路一样。
 */
import { runAsActor } from "@/lib/data/actor";
import { ApiError } from "@/lib/data/shared";
import { CEO_ACTOR } from "@/lib/data/store";
import { kick } from "@/lib/recording/pipeline";

/**
 * 跑 `flip`（把状态推到一个在途档），成了就叫 `kick()`。
 *
 * **`kick()` 只在 `flip` 没抛的时候叫。** 抛了说明状态压根没动（比如「这一份没有失败，
 * 不用重跑」），这时候再扫一遍是白扫。
 */
export async function handOffToPipeline(
  /** 出错时写进服务端日志的那个词，例如「重试」。 */
  what: string,
  id: string,
  flip: () => Promise<void>,
): Promise<Response> {
  try {
    await runAsActor(CEO_ACTOR, flip);
  } catch (err) {
    if (err instanceof ApiError) {
      /* 业务性失败：原话带回去，屏幕原样显示。409 的含义和 `/api/data` 那条一致。 */
      return Response.json({ error: err.message }, { status: 409 });
    }
    console.error(`[api/recordings] ${id} ${what} 抛出：`, err);
    return Response.json(
      { error: "这一步在服务端出错了。原因已经写进服务端日志，不在这句话里。" },
      { status: 500 },
    );
  }

  /* 后台开跑。**不 await** —— 这条请求的活到「叫起来」为止，转写要几分钟到几十分钟。 */
  kick();
  return Response.json({ ok: true });
}
