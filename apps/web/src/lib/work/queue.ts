/**
 * 一次开工（V2 设计第 20.3、20.6 节）：派活单点一次「开工」，一个请求交给本机（POST /v1/sessions/batch）。
 * 本机同时跑满了（默认 3）的会话回来是 queued（排第几），有空位本机自己接上（先来先跑）。
 */
import type { LocalRunner, TLocalModelProfile } from "@/lib/local/runner";
import { cardStartRequest } from "@/lib/local/start";
import type { CardItem } from "@/lib/board/cards";
import type { RoleView } from "@/lib/team/roles";

export const SLOT_CAP = 3;

export type StartPlan = { item: CardItem; model: TLocalModelProfile; cwd: string; role: RoleView | null };

/** 开工：开了几件、排了几件、没开成几件（没开成的那件还是等开工，别的照常）。 */
export async function startBatch(runner: LocalRunner, plans: StartPlan[]): Promise<{ started: number; queued: number; failed: number }> {
  if (!plans.length) return { started: 0, queued: 0, failed: 0 };
  const items = await Promise.all(plans.map((plan) => cardStartRequest(plan.item, plan.model, plan.cwd, plan.role)));
  const results = await runner.createSessionBatch(items);
  const ok = results.filter((result) => result.ok).map((result) => (result as Extract<typeof result, { ok: true }>).session);
  return { started: ok.filter((session) => session.status !== "queued").length, queued: ok.filter((session) => session.status === "queued").length, failed: results.length - ok.length };
}

/** 「开工 2 件 · 排队 1 件」 */
export const startedText = ({ started, queued, failed }: { started: number; queued: number; failed: number }) =>
  [`开工 ${started} 件`, queued ? `排队 ${queued} 件` : null, failed ? `${failed} 件没开成` : null].filter(Boolean).join(" · ");
