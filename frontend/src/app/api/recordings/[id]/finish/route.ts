/**
 * 「结束并转写」按下去的那一下（列表页上停在「录音中」那几行）。
 *
 * 那些是标签页被关掉留下的孤儿：录的那一侧没了，记录还停在 `recording`，而重启恢复
 * 那一路**故意不管它们**（`registry.interrupted` 把 `recording` 排除在外，理由写在
 * 那上面：自动替他转写是在替他做决定）。所以收尾这一下由人按，按完由这条路由把
 * 流水线叫起来 —— 和「重试」是同一件事，见 `../../_handoff.ts`。
 *
 * 这一份可能一片音频都没收到（现场录音那条链路目前只在浏览器里录完整段再走
 * `/api/recordings/upload`，分片那条路还没有人在用）。那种情况下流水线第一步就会说
 * 「这一场录音一片都没收到」并把它标成失败 —— **那也比停在「排队中」不动强**：
 * 屏幕上至少出现了一句指得出原因的话。
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
  return handOffToPipeline("结束并转写", id, () => api.finishRecording(id));
}
