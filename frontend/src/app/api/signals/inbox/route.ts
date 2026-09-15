/**
 * 抓取作业的收件口。**这一层只做三件事：验口令、解析、落库。**
 *
 * 不做研判、不做过滤（rollout §9：这一侧一装过滤器，实验台调出来的阈值就不再是
 * 最终阈值）。方向永远是作业推过来 —— 定时在作业那边，正式版不必知道实验台存在，
 * 也不必为机器再开一条穿过访问口令的鉴权路。
 *
 * **它在 `src/proxy.ts` 的 `PUBLIC_PATHS` 里**，因为作业没有访问 cookie。那不是
 * 「公开」：它有下面这道 `x-operator-token`。少了那一条的话，作业带着完全正确的
 * 口令也只会拿到 `{"error":"unauthorized"}`，而那句话看起来像口令配错了。
 *
 * 契约的另一半在 `tkos-lab/src/tkos_lab/deliver.py`。形状校验在
 * `src/lib/data/inbox.ts`（纯函数，有单测）—— 这个文件里没有一行形状判断。
 */
import { parseInboxPayload } from "@/lib/data/inbox";
import { inboxSignalsPut, scanRoundPut } from "@/lib/data/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // 没配 token 就直接拒，不留「没配就放行」的口子（同 `api/stage/route.ts`）。
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "服务端没有配 OPERATOR_TOKEN，抓取作业现在推不进来。" },
      { status: 503 }
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

  const parsed = parseInboxPayload(body);
  if (!parsed.ok) {
    /*
     * 400 而不是 422：这是契约破了，属于「这批请求本身不合规」。作业那边会把这句话
     * 记进 trace 并以非零码退出，改完重投即可 —— 幂等键保证重投安全。
     */
    console.warn(`[tkos:inbox] 拒收一批：${parsed.error}`);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const { inserted, updated } = inboxSignalsPut(parsed.signals);
  /*
   * 这一轮扫过了，记一条时间。**`signals` 是空数组也照记** —— 一轮什么都没过线是
   * 合格输出，而不记的话扫描记录那一页上它和「这一轮没跑」分不开（见 `ScanRound`）。
   * 作业那边定时扫完就该推一次，哪怕这一批是空的。
   */
  scanRoundPut({
    runId: parsed.runId,
    scannedAt: parsed.scannedAt,
    nominated: parsed.signals.length,
    // 这条路就是定时作业推过来的那一条，屏幕上的节奏只数这一种。
    trigger: "auto",
  });
  console.log(
    `[tkos:inbox] run ${parsed.runId}（扫描于 ${parsed.scannedAt}）` +
      `收到 ${parsed.signals.length} 条 → 新增 ${inserted} / 更新 ${updated}`
  );
  return Response.json({ ok: true, inserted, updated });
}
