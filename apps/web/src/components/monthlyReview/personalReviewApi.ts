import type { TExecutePersonalReviewActionResponse, TPersonalReviewStatus } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { ReviewActionError, type ReviewAction } from "./reviewApi";

/** 发给自己 AI 工具的一句话：让它经天枢 MCP 起草个人复盘（只写草稿，提交在天枢里点）。 */
export const REVIEW_INSTRUCTION = "用天枢 MCP 改写我的月度个人复盘：先调用 tianshu 的 get_my_review 看我这个月的 Mission、进展和 Co-Agent 已起草的草稿，再结合我手边的周复盘、文档和提交记录，按它给的要求补充改写四部分，用 save_review_draft 保存。只写有依据的事，缺材料就写缺少材料，不要编造。写完告诉我去天枢确认提交。";

/** 个人复盘状态的一句话：本人和看板上的其他人各看各的。 */
export function personalStatusText(status: TPersonalReviewStatus, self: boolean): string {
  switch (status) {
    case "waiting": return "Co-Agent 起草中";
    case "drafting": return "Co-Agent 起草中";
    case "draft_failed": return self ? "起草没有成功" : "起草中";
    case "draft": return self ? "草稿 · 确认后提交" : "草稿中";
    case "submitted": return "已提交";
    case "skipped": return "CEO 已跳过";
  }
}

export const personalDone = (status: TPersonalReviewStatus) => status === "submitted" || status === "skipped";

/** 执行个人复盘动作；成功后通知通知栏和看板重读。 */
export async function runPersonalReviewAction(action: ReviewAction, input?: unknown): Promise<TExecutePersonalReviewActionResponse> {
  const { data, response, error } = await browserApi.POST("/api/personal-reviews/actions/execute", { body: { actionId: action.actionId, ...(input === undefined ? {} : { input }) } });
  if (response.status === 401) { window.location.assign("/access"); throw new ReviewActionError("登录已过期", 401); }
  if (!response.ok || !data) {
    const failure = error as { message?: string; fieldErrors?: Record<string, string>; code?: string } | undefined;
    const message = response.status === 409 && failure?.code === "VERSION_CONFLICT" ? "内容刚被更新过，已刷新到最新，请再操作一次。" : failure?.message ?? "没有保存成功，请重试";
    throw new ReviewActionError(message, response.status, failure?.fieldErrors);
  }
  window.dispatchEvent(new Event("monthly-review-changed"));
  return data;
}

/** 打开个人菜单里的「连接到外部工具」（AccountMenu 监听）。 */
export const openConnectionDialog = () => window.dispatchEvent(new Event("open-connection-dialog", { cancelable: true }));
