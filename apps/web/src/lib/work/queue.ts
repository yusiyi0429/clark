/**
 * 一次开工（V2 设计第 20.3、20.6 节）：派活单点一次「开工」，一个请求交给本机（POST /v1/sessions/batch）。
 * 本机同时跑满了（默认 3）的会话回来是 queued（排第几），有空位本机自己接上（先来先跑）。
 * 规划员（拆卡 · 等开工）和卡一起交：页头「开工 N 件」一次全开。
 */
import type { TLocalEffort, TLocalPermissionMode } from "@warmap/contracts";
import type { LocalRunner, TLocalCreateSessionRequest, TLocalModelProfile } from "@/lib/local/runner";
import { cardStartRequest } from "@/lib/local/start";
import type { CardItem } from "@/lib/board/cards";
import type { RoleView } from "@/lib/team/roles";

export const SLOT_CAP = 3;

/** permissionMode：所在项目新开子会话的默认档（Project.permissionMode）；不给本机按「自动」。 */
export type StartPlan = { item: CardItem; model: TLocalModelProfile; cwd: string; role: RoleView | null; permissionMode?: TLocalPermissionMode; effort?: TLocalEffort | null };

/**
 * 开工：开了几件、排了几件、没开成几件（没开成的那件还是等开工，别的照常）；opened 按交进来的顺序（先卡后规划员）写每件开没开成。
 */
export async function startBatch(runner: LocalRunner, plans: StartPlan[], planners: TLocalCreateSessionRequest[] = []): Promise<{ started: number; queued: number; failed: number; opened: boolean[] }> {
  if (!plans.length && !planners.length) return { started: 0, queued: 0, failed: 0, opened: [] };
  const items = [...await Promise.all(plans.map((plan) => cardStartRequest(plan.item, plan.model, plan.cwd, plan.role, plan.permissionMode, plan.effort))), ...planners];
  const results = await runner.createSessionBatch(items);
  const ok = results.filter((result) => result.ok).map((result) => (result as Extract<typeof result, { ok: true }>).session);
  return { started: ok.filter((session) => session.status !== "queued").length, queued: ok.filter((session) => session.status === "queued").length, failed: results.length - ok.length,
    opened: results.map((result) => result.ok) };
}

/** 「开工 2 件 · 排队 1 件」 */
export const startedText = ({ started, queued, failed }: { started: number; queued: number; failed: number }) =>
  [`开工 ${started} 件`, queued ? `排队 ${queued} 件` : null, failed ? `${failed} 件没开成` : null].filter(Boolean).join(" · ");
