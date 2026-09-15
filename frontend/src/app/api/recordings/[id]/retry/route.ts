/**
 * 「重试」按下去的那一下（列表页和详情页上那颗）。
 *
 * 状态怎么推、什么情况不许重跑，全在 `store.retryRecording` 里（推回 `uploaded` 而不是
 * 从倒下的那一段接着，理由写在那上面）。**这条路由自己只多做一件事：`kick()`。**
 * 少了那一句，这份录音会翻回「排队中」然后一动不动 —— 那正是 2026-08-31 实测到的样子。
 * 为什么这一句非得在路由这一层，见 `../../_handoff.ts`。
 */
import { api } from "@/lib/data/store";

import { handOffToPipeline } from "../../_handoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return handOffToPipeline("重试", id, () => api.retryRecording(id));
}
