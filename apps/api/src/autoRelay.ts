import type { Query } from "./meetingStore.js";
import { CardError } from "./taskCards.js";
import { ownProject } from "./projects.js";

/**
 * 自动接力的空转保护（18 节第 12 条，契约 Project.autoRelayLimit、等你 auto_relay）：每个项目单独计数。
 * 主管线代本人给子会话的转话、重开，每次算一步（子会话停了的报告从主循环第 63 条起不再触发主管线，不算步）；
 * 连续到上限之间本人一句话没说，就停止自动触发（这一步照做，下一步起不做），「等你」里出一条问继续还是停下。上限为 NULL 不限。
 * 本人在这个项目对话里说任何一句话清零；本人发的话、点的按钮不算步、不受限。
 */

/** 记一步自动接力：停着时返回 false（这一步不做）；没停着计数加一，到上限就停住。 */
export async function autoRelayStep(q: Query, projectId: string, now: Date): Promise<boolean> {
  return Boolean((await q(`UPDATE projects SET auto_relay_count=auto_relay_count+1,
      auto_relay_paused_at=CASE WHEN auto_relay_limit IS NOT NULL AND auto_relay_count+1>=auto_relay_limit THEN $2::timestamptz END,
      auto_relay_asked=(auto_relay_limit IS NOT NULL AND auto_relay_count+1>=auto_relay_limit)
    WHERE id=$1 AND auto_relay_paused_at IS NULL`, [projectId, now])).rowCount);
}

/** 本人在这个项目对话里说了话：清零、恢复。 */
export async function resetAutoRelay(q: Query, projectId: string): Promise<void> {
  await q("UPDATE projects SET auto_relay_count=0,auto_relay_paused_at=NULL,auto_relay_asked=false WHERE id=$1 AND (auto_relay_count>0 OR auto_relay_paused_at IS NOT NULL)",
    [projectId]);
}

/** 答「等你」里那条：continue 清零恢复；stop 收起那一条，照旧停着等本人说话。没停着 409。 */
export async function decideAutoRelay(q: Query, ownerId: string, projectId: string, decision: "continue" | "stop"): Promise<void> {
  const project = await ownProject(q, ownerId, projectId) as { auto_relay_paused_at: Date | null };
  if (!project.auto_relay_paused_at) throw new CardError(409, "NOT_PAUSED", "这个项目的自动接力没停着");
  if (decision === "continue") await resetAutoRelay(q, projectId);
  else await q("UPDATE projects SET auto_relay_asked=false WHERE id=$1", [projectId]);
}
