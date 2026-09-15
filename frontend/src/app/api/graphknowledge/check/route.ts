/**
 * 本轮的主验收口：`GET /api/graphknowledge/check`。不调模型。
 *
 * 探针问题默认取库里第一条议题的标题 —— 用一条**真实**的题目跑锚点层，
 * 编出来的问题测出的只是「autopick 不崩」。要试别的就 `?q=`。
 *
 * `?recipe=S01|S02|S03` 把第 ④ 层从「单跑一次 P3」换成**整条配方装配**，锚点层
 * 同时切到该配方对应的频道（S01 认信号，S02/S03 认议题）。不给就是只验最后一跳。
 *
 * **不认识的参数一律 400**：曾经 `?recipe=S03` 被静默忽略，于是台账上记着「S03
 * 命中路已验」，实际跑的是另一组参数。静默忽略让「跑过了」和「其实没按这个参数
 * 跑」在屏幕上完全一样，这比报错难查得多。
 */
import { asRecipe, runGraphKnowledgeCheck } from "@/lib/graphknowledge/check";
import { api } from "@/lib/data/store";

export const dynamic = "force-dynamic";

const KNOWN = ["q", "recipe", "viewer", "as_of"];

const fail = (stoppedAt: string, error: string) =>
  Response.json({ ok: false, stoppedAt, error }, { status: 400 });

export async function GET(req: Request) {
  const url = new URL(req.url);

  const unknown = [...url.searchParams.keys()].filter((k) => !KNOWN.includes(k));
  if (unknown.length) {
    return fail("参数", `不认识的参数：${unknown.join("、")}。只接受 ${KNOWN.join(" / ")}`);
  }

  const recipeRaw = (url.searchParams.get("recipe") ?? "").trim();
  const recipe = recipeRaw ? asRecipe(recipeRaw) : undefined;
  if (recipeRaw && !recipe) {
    return fail("参数", `recipe 只能是 S01 / S02 / S03，收到「${recipeRaw}」`);
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  const probeQuery = q || (await api.listIssues())[0]?.title || "";
  if (!probeQuery) {
    return fail("锚点", "库里没有议题，也没传 ?q= —— 锚点层无从测起");
  }

  const result = await runGraphKnowledgeCheck({
    probeQuery,
    // `?? undefined`：上面那句已经把「填了但不认识」挡掉了，剩下的 null 只可能是没填。
    recipe: recipe ?? undefined,
    viewer: url.searchParams.get("viewer") ?? undefined,
    asOf: url.searchParams.get("as_of") ?? undefined,
  });
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
