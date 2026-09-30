import type { TOnboardingResponse, TMissionRoundSummary, TSessionRole } from "@warmap/contracts";
import { listBattlefieldRows } from "./battlefields.js";
import { listCapabilityRows } from "./capabilities.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod, type MonthlyPlanRow } from "./monthlyPlans.js";
import { getStrategyConfig } from "./strategy.js";
import { voiceprintStatus, type VoiceprintDeps } from "./voiceprints.js";
import { listMissionRoundCards, listMissionRoundDraftCards } from "./missionRounds.js";
import { readMemberWork } from "./memberWork.js";
import { readRadarSummary } from "./radarSettings.js";

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

export async function resetOnboarding(q: Query, personId: string): Promise<void> {
  await q("DELETE FROM person_onboarding WHERE person_id = $1", [personId]);
}

type Plan = Pick<MonthlyPlanRow, "status" | "battlefields">;
type Next = TOnboardingResponse["next"];
type WorkCard = Extract<TOnboardingResponse, { role: "member" }>["work"]["missionCards"][number];

function memberCardNext(cards: WorkCard[], deciders: Map<string, string>): Next | null {
  const card = cards.find((item) => item.phase === "open") ?? cards.find((item) => ["closed", "reviewing"].includes(item.phase));
  if (!card) return null;
  const month = Number(card.period.slice(5));
  const deadline = card.closesAt && new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(card.closesAt));
  return {
    text: card.phase === "open" ? deadline ? `${month} 月 Mission Card 讨论开放到 ${deadline}` : `${month} 月 Mission Card 讨论已开放`
      : `${month} 月 Mission Card 已截止，等${deciders.get(card.roundId)}拍板`,
    // 引导的最后一步统一进首页；本月卡的状态留在说明里，首页左侧能直接点开。
    action: "进入工作台", href: "/me",
  };
}

function ceoRoundNext(rounds: TMissionRoundSummary[]): Next | null {
  const round = rounds.find((item) => item.phase === "draft")
    ?? rounds.find((item) => item.phase === "reviewing" && item.counts.pending > 0)
    ?? rounds.find((item) => item.phase === "reviewing");
  if (!round) return null;
  if (!round.cards.length) return null;
  const month = Number(round.period.slice(5));
  return {
    text: round.phase === "draft" ? `${month} 月任务卡草稿已就绪，可以统一开放讨论`
      : round.counts.pending ? `${month} 月 Mission Card 有 ${round.counts.pending} 条意见待你处理` : "意见已全部处理，待你确认",
    action: "进入工作台", href: "/",
  };
}

async function ceoNext(q: Query, plan: Plan | undefined, period: string, now: Date): Promise<Next> {
  // 尚未生成的计划没有可打开的对象；不能把第一次进入的人带到空链接。
  if (plan && plan.status !== "confirmed") {
    const month = Number(period.slice(5));
    return { text: `${month} 月的目标等你核对和签发`, action: "进入工作台", href: "/" };
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
export async function readOnboarding({ q, companyMemory, voiceprints, person, companyName, now, secret, draftsDirectory }: {
  q: Query;
  companyMemory: CompanyMemoryRepository;
  voiceprints: VoiceprintDeps;
  person: { personId: string; role: TSessionRole };
  companyName?: string;
  now: Date;
  secret: string;
  draftsDirectory?: string;
}): Promise<TOnboardingResponse> {
  const period = companyPeriod(now);
  const people = companyMemory.searchPeople(undefined);
  const [voiceprint, battlefields, plans, radar] = await Promise.all([
    voiceprintStatus(q, voiceprints, person.personId),
    listBattlefieldRows(q),
    q("SELECT status, battlefields FROM monthly_plans WHERE period = $1", [period]),
    readRadarSummary(q, person),
  ]);
  const plan = plans.rows[0] as Plan | undefined;
  const common = {
    displayName: people.find((entry) => entry.personId === person.personId)!.displayName,
    companyName: companyName?.trim() || null,
    voiceprint,
    radar,
  };
  if (person.role === "ceo") {
    const [strategy, capabilities, rounds, slots] = await Promise.all([
      getStrategyConfig(q), listCapabilityRows(q),
      listMissionRoundCards(q, people, secret, person, period, now),
      listMissionRoundDraftCards(q, people, secret, person, period, now, draftsDirectory),
    ]);
    const month = Number(period.slice(5));
    const next = slots[0] ? { text: `${month} 月目标已签发，可以整理任务卡草稿`, action: "进入工作台", href: "/" }
      : ceoRoundNext(rounds.map((card) => card.payload as TMissionRoundSummary)) ?? await ceoNext(q, plan, period, now);
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

  const [{ work, deciders }, tasks] = await Promise.all([
    readMemberWork(q, people, secret, person, now),
    q("SELECT count(*)::int AS count FROM tasks WHERE owner_id = $1 AND status IN ('not_started', 'in_progress')", [person.personId]),
  ]);
  const taskCount = tasks.rows[0].count as number;
  return {
    ...common, role: "member",
    next: memberCardNext(work.missionCards, deciders) ?? (taskCount > 0
      ? { text: `你有 ${taskCount} 件执行事项在推进`, action: "看看我的执行事项", href: "/me" }
      : { text: "需要你留意的事情，会出现在通知栏", action: "进入工作台", href: "/me" }),
    work: {
      ...work,
      battlefields: work.battlefields.map(({ id, name, monthTarget }) => ({ id, name, monthTarget })),
    },
  };
}
