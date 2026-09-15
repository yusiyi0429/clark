import type { PoolClient, QueryResult } from "pg";
import type { TCard } from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";

export type FixtureHomeRow = {
  id: string;
  version: number;
  notice_dismissed: boolean;
  notice_fingerprint: string | null;
};

type Query = (sql: string, params?: unknown[]) => QueryResult;

/** GET 无副作用：只读。 */
export async function getFixtureHome(q: Query): Promise<FixtureHomeRow> {
  const res = await q(
    "SELECT id, version, notice_dismissed, notice_fingerprint FROM fixture_home WHERE id = 'default'",
  );
  if (res.rowCount !== 1) throw new Error("fixture_home seed row missing");
  return res.rows[0] as FixtureHomeRow;
}

export function projectHomeCard(row: FixtureHomeRow, secret: string): TCard {
  const scope: ActionScope = {
    actionType: "home.dismiss_notice",
    objectType: "home",
    objectId: row.id,
    objectVersion: row.version,
  };
  return {
    schemaVersion: 1,
    id: `home:${row.id}`,
    version: row.version,
    kind: "home",
    objectRef: { type: "home", id: row.id, version: row.version },
    title: "公司战况",
    badge: "FIXTURE",
    urgency: "normal",
    payload: {
      notice: {
        text: "本周雷达发现 2 条新信号（fixture 演示数据）",
        dismissed: row.notice_dismissed,
      },
    },
    navigation: [{ href: "/radar", label: "Radar" }],
    conversation: { scope: "global" },
    actions: row.notice_dismissed ? [] : [{ actionId: signActionId(secret, scope), ...{ actionType: scope.actionType, label: "知道了" } }],
  };
}
