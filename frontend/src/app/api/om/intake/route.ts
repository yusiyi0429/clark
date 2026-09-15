/**
 * 纲领的收件口。**这一层只做三件事：验口令、解析、落库。**
 *
 * 为什么是机器口而不是页面：一个月一次的操作，做一整个页面是为一次动作建一个实体
 * （spec §2）。和抓取作业推信号同一个路数：`x-operator-token` + 一条本地命令。
 *
 * **它在 `src/proxy.ts` 的 `PUBLIC_PATHS` 里**，因为作业没有访问 cookie。那不是
 * 「公开」：它有下面这道 `x-operator-token`。少了那一条的话，作业带着完全正确的
 * 口令也只会拿到 `{"error":"unauthorized"}`，而那句话看起来像口令配错了。
 *
 * 契约的另一半是灌纲领的那条命令。形状校验在 `src/lib/data/om-intake.ts`（纯函数，
 * 有单测）—— 这个文件里没有一行形状判断。
 */
import { parseOmIntake } from "@/lib/data/om-intake";
import { commitmentsIntake } from "@/lib/data/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // 没配 token 就直接拒，不留「没配就放行」的口子（同 `api/signals/inbox/route.ts`）。
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "服务端没有配 OPERATOR_TOKEN，纲领现在灌不进来。" },
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

  const parsed = parseOmIntake(body);
  if (!parsed.ok) {
    /*
     * 400 而不是 422：这是契约破了，属于「这批请求本身不合规」。作业那边会把这句话
     * 记进 trace 并以非零码退出，改完重投即可 —— 幂等保证重投安全。
     */
    console.warn(`[tkos:om-intake] 拒收纲领：${parsed.error}`);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const { periodCreated, drafted, skipped } = commitmentsIntake(parsed.payload);

  // skipped 非空时 console.warn —— 跳过的那几个域是「有人的回传没被覆盖」，那件事必须喊出来。
  if (skipped.length > 0) {
    console.warn(
      `[tkos:om-intake] 周期 ${parsed.payload.period.id}：` +
        `${periodCreated ? "新建周期、" : ""}` +
        `起草 ${drafted} 份承诺、跳过 ${skipped.length} 个域（${skipped.join("、")}）`
    );
  } else {
    console.log(
      `[tkos:om-intake] 周期 ${parsed.payload.period.id}：` +
        `${periodCreated ? "新建周期、" : ""}` +
        `起草 ${drafted} 份承诺`
    );
  }

  return Response.json({ ok: true, periodCreated, drafted, skipped });
}
