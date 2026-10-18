import type { TExecuteWeeklyReviewActionResponse, TWeeklyReviewField, TWeeklyReviewOrigin, TWeeklyReviewStatus } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { ReviewActionError, type ReviewAction } from "@/components/monthlyReview/reviewApi";

/** 五段沿用公司周复盘模板。 */
export const WEEKLY_FIELDS: TWeeklyReviewField[] = ["overall", "progress", "issues", "implications", "actions"];
export const WEEKLY_FIELD_LABELS: Record<TWeeklyReviewField, string> = {
  overall: "本周总体判断", progress: "关键进展与 Evidence", issues: "最重要的问题及 Why", implications: "判断变化 / Implication", actions: "当前处理",
};
export const WEEKLY_FIELD_HINTS: Record<TWeeklyReviewField, string> = {
  overall: "状态：绿 / 黄 / 红｜一句话",
  progress: "这周真正推进的结果，一条一行",
  issues: "最卡的一两个问题和原因",
  implications: "和上周比，判断变了什么",
  actions: "已经在做或下一步要做的处理",
};

/** 周的写法：10/12–10/18。 */
export const weekLabel = (weekStart: string, weekEnd: string) => `${weekStart.slice(5).replace("-", "/")}–${weekEnd.slice(5).replace("-", "/")}`;

export function weeklyStatusText(status: TWeeklyReviewStatus, origin: TWeeklyReviewOrigin, self: boolean): string {
  switch (status) {
    case "drafting": return "生成中";
    case "draft_failed": return self ? "生成没有成功" : "草稿中";
    case "draft": return self ? "待确认" : "草稿中";
    case "submitted": return origin === "import" ? "已提交（导入）" : "已提交";
  }
}

/** 执行周复盘动作；成功后通知名单重读。 */
export async function runWeeklyReviewAction(action: ReviewAction, input?: unknown): Promise<TExecuteWeeklyReviewActionResponse> {
  const { data, response, error } = await browserApi.POST("/api/weekly-reviews/actions/execute", { body: { actionId: action.actionId, ...(input === undefined ? {} : { input }) } });
  if (response.status === 401) { window.location.assign("/access"); throw new ReviewActionError("登录已过期", 401); }
  if (!response.ok || !data) {
    const failure = error as { message?: string; fieldErrors?: Record<string, string>; code?: string } | undefined;
    const message = response.status === 409 && failure?.code === "VERSION_CONFLICT" ? "内容刚被更新过，已刷新到最新，请再操作一次。" : failure?.message ?? "没有保存成功，请重试";
    throw new ReviewActionError(message, response.status, failure?.fieldErrors);
  }
  window.dispatchEvent(new Event("weekly-review-changed"));
  return data;
}
