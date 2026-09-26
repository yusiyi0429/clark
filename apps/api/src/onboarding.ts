import type { TOnboardingResponse, TSessionRole } from "@warmap/contracts";
import { listBattlefieldRows } from "./battlefields.js";
import { listCapabilityRows } from "./capabilities.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod, type MonthlyPlanRow } from "./monthlyPlans.js";
import { getStrategyConfig } from "./strategy.js";
import { voiceprintStatus, type VoiceprintDeps } from "./voiceprints.js";

export async function hasCompletedOnboarding(q: Query, personId: string): Promise<boolean> {
  const result = await q("SELECT 1 FROM person_onboarding WHERE person_id = $1", [personId]);
  return result.rowCount === 1;
}

export async function completeOnboarding(q: Query, personId: string, now: Date): Promise<void> {
  await q(
    "INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, $2) ON CONFLICT (person_id) DO NOTHING",
    [personId, now],
  );
}

type Plan = Pick<MonthlyPlanRow, "status" | "battlefields">;
type Next = TOnboardingResponse["next"];

async function ceoNext(q: Query, plan: Plan | undefined, period: string, now: Date): Promise<Next> {
  // 尚未生成的计划没有可打开的对象；不能把第一次进入的人带到空链接。
  if (plan && plan.status !== "confirmed") {
    const month = Number(period.slice(5));
    return { text: `${month} 月的目标等你核对和签发`, action: `核对 ${month} 月目标`, href: `/plans/${period}` };
  }
  const issues = await q("SELECT count(*)::int AS count FROM issues WHERE status = 'pending' AND urgency->>'level' = 'red'");
  const redCount = issues.rows[0].count as number;
  if (redCount > 0) return { text: `有 ${redCount} 个红色议题等你判断`, action: "去看看", href: "/" };
  const meetings = await q(
    `SELECT count(*)::int AS count FROM meetings
     WHERE status = 'scheduled'
       AND (scheduled_at AT TIME ZONE 'Asia/Shanghai')::date = ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
    [now],
  );
  const meetingCount = meetings.rows[0].count as number;
  if (meetingCount > 0) return { text: `今天有 ${meetingCount} 场会`, action: "进入工作台", href: "/" };
  return { text: "首页上暂时没有要你马上处理的事", action: "进入工作台", href: "/" };
}

/** 引导只读取持久事实；角色边界、月份、目标状态与下一步都由服务端决定。 */
export async function readOnboarding({ q, companyMemory, voiceprints, person, companyName, now }: {
  q: Query;
  companyMemory: CompanyMemoryRepository;
  voiceprints: VoiceprintDeps;
  person: { personId: string; role: TSessionRole };
  companyName?: string;
  now: Date;
}): Promise<TOnboardingResponse> {
  const period = companyPeriod(now);
  const people = companyMemory.searchPeople(undefined);
  const [voiceprint, battlefields, plans] = await Promise.all([
    voiceprintStatus(q, voiceprints, person.personId),
    listBattlefieldRows(q),
    q("SELECT status, battlefields FROM monthly_plans WHERE period = $1", [period]),
  ]);
  const plan = plans.rows[0] as Plan | undefined;
  const common = {
    displayName: people.find((entry) => entry.personId === person.personId)!.displayName,
    companyName: companyName?.trim() || null,
    voiceprint,
  };
  if (person.role === "ceo") {
    const [strategy, capabilities, next] = await Promise.all([
      getStrategyConfig(q), listCapabilityRows(q), ceoNext(q, plan, period, now),
    ]);
    const names = new Map(people.map((entry) => [entry.personId, entry.displayName]));
    return {
      ...common, role: "ceo", next,
      company: {
        sixMonthGoal: strategy.ltco,
        battlefields: battlefields.map(({ id, code, name, owner_id }) => ({
          id, code, name, ...(names.has(owner_id) ? { ownerName: names.get(owner_id)! } : {}),
        })),
        capabilities: capabilities.map(({ id, code, name }) => ({ id, code, name })),
        people: people.map(({ personId, displayName }) => ({ personId, displayName })),
      },
    };
  }

  const [missionRows, tasks] = await Promise.all([
    q("SELECT id, code, title, battlefield_ids FROM missions WHERE period = $1 AND owner_id = $2 ORDER BY code, id", [period, person.personId]),
    q("SELECT count(*)::int AS count FROM tasks WHERE owner_id = $1 AND status IN ('not_started', 'in_progress')", [person.personId]),
  ]);
  const missions = (missionRows.rows as { id: string; code: string; title: string; battlefield_ids: string[] }[])
    .map(({ id, code, title, battlefield_ids }) => ({ id, code, title, battlefieldIds: battlefield_ids }));
  const participating = new Set(missions.flatMap((mission) => mission.battlefieldIds));
  const taskCount = tasks.rows[0].count as number;
  return {
    ...common, role: "member",
    next: taskCount > 0
      ? { text: `你有 ${taskCount} 件执行事项在推进`, action: "看看我的执行事项", href: "/me" }
      : { text: "会后分给你的事，会出现在首页和通知栏", action: "进入工作台", href: "/me" },
    work: {
      period,
      planStatus: plan?.status ?? "none",
      battlefields: battlefields.filter((field) => field.owner_id === person.personId || participating.has(field.id))
        .map(({ id, name }) => ({
          id, name,
          monthTarget: plan?.status === "confirmed" ? plan.battlefields.find((field) => field.battlefieldId === id)?.outcome ?? null : null,
        })),
      missions,
    },
  };
}
