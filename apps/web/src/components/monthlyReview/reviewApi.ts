import type { TMonthlyReviewComment, TMonthlyReviewItemPayload, TMonthlyReviewPayload, TMonthlyReviewField } from "@warmap/contracts";
import { browserApi, type CardAction } from "@/lib/api/client";

export type ReviewAction = Pick<CardAction, "actionId" | "actionType" | "label">;
export type ReviewActionResult = { item?: TMonthlyReviewItemPayload; review?: TMonthlyReviewPayload };

/** 战场 / 能力域月度复盘的四部分（与 Co-Agent Design 的 BR 一致）。 */
export const FIELD_LABELS: Record<TMonthlyReviewField, string> = {
  overall: "本周期总体结果",
  judgments: "关键经营判断",
  nextFocus: "下周期经营重点",
  escalations: "待上层决策事项",
};
export const FIELDS: TMonthlyReviewField[] = ["overall", "judgments", "nextFocus", "escalations"];
/** 每一栏写什么：编辑时作占位提示。 */
export const FIELD_HINTS: Record<TMonthlyReviewField, string> = {
  overall: "对照本月目标：完成了什么、没完成什么",
  judgments: "每条写清结果、证据、和目标的差距、原因，以及判断有没有变化；多条用 1. 2. 分行",
  nextFocus: "下个月最该推进的几件事（只作定目标的输入，不写任务指派和排期）",
  escalations: "需要 CEO 拍板的事；没有可以不写",
};
/** 提交时可以留空的栏。 */
export const OPTIONAL_FIELDS: TMonthlyReviewField[] = ["escalations"];

/** 页面外的「反馈问题」：打开一份飞书记录，大家在复盘、拆解时遇到的问题都记在那里。 */
export const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || "https://tokenking.feishu.cn/wiki/ZcECwgmoIi8NiDkvJb5c4AFhnXe?table=tblijUsl4RW879Wf&view=vewoG6aNBa";

export const monthOf = (period: string) => Number(period.slice(5));

/** 复盘项状态的一句话，负责人与 CEO 各看各的。 */
export function itemStatusText(item: Pick<TMonthlyReviewItemPayload, "status">, forOwner: boolean): string {
  switch (item.status) {
    case "drafting": return "Co-Agent 正在起草";
    case "draft_failed": return "起草没有成功";
    case "draft": return forOwner ? "草稿 · 改好后提交" : "负责人修改中";
    case "returned": return forOwner ? "被打回 · 改好后重新提交" : "已打回 · 等负责人修改";
    case "submitted": return forOwner ? "已提交 · 等 CEO 确认" : "已提交 · 待你确认";
    case "confirmed": return "已确认";
  }
}

export class ReviewActionError extends Error {
  constructor(message: string, readonly status: number, readonly fieldErrors?: Record<string, string>) { super(message); }
}

/** 执行复盘动作；版本冲突时抛错，调用方重新读取。 */
export async function runReviewAction(action: ReviewAction, input?: unknown): Promise<ReviewActionResult> {
  const { data, response, error } = await browserApi.POST("/api/monthly-reviews/actions/execute", { body: { actionId: action.actionId, ...(input === undefined ? {} : { input }) } });
  if (response.status === 401) { window.location.assign("/access"); throw new ReviewActionError("登录已过期", 401); }
  if (!response.ok || !data) {
    const failure = error as { message?: string; fieldErrors?: Record<string, string>; code?: string } | undefined;
    const message = response.status === 409 && failure?.code === "VERSION_CONFLICT" ? "内容刚被别人更新过，已刷新到最新，请再操作一次。" : failure?.message ?? "没有保存成功，请重试";
    throw new ReviewActionError(message, response.status, failure?.fieldErrors);
  }
  window.dispatchEvent(new Event("monthly-review-changed"));
  return data;
}

export function requestError(cause: unknown, fallback: string): string {
  if (cause instanceof ReviewActionError) return cause.message;
  if (!(cause instanceof Error) || cause instanceof TypeError || /failed to fetch|fetch failed|networkerror|load failed/i.test(cause.message)) return fallback;
  return cause.message;
}

/** 讨论与补充：按 clientId 幂等，原样重试复用同一个 clientId。 */
export async function postReviewComment(itemId: string, clientId: string, body: string): Promise<TMonthlyReviewComment> {
  const { data, response, error } = await browserApi.POST("/api/monthly-review-items/{itemId}/comments", { params: { path: { itemId } }, body: { clientId, body } });
  if (response.status === 401) { window.location.assign("/access"); throw new ReviewActionError("登录已过期", 401); }
  if (!response.ok || !data) throw new ReviewActionError((error as { message?: string } | undefined)?.message ?? "没有发出去，请重试；输入已保留。", response.status);
  return data.comment;
}
