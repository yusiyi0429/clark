import type { TLocalRunPlanProgress, TLocalSlots, TWorkerCost, TWorkerItem, TWorkerMark, TWorkersResponse } from "@warmap/contracts";
import { ownMissions, planTaskMissions } from "./homePlan.js";
import { latestRuns, RUN_SELECT, runBrief, type RunRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { readPlanTasks, type PlanTaskSource } from "./planTasks.js";
import { plannerRole, reviewerRole, roleRef, rolesById } from "./roles.js";
import { cardTaskViews } from "./taskCards.js";

/**
 * worker 列表（V2 设计第 20 节）：本人所有 worker（带岗位的卡、带岗位的专题、本机的规划员和验收员会话），跨 Task 分进行中、已排队、已完成（今天），加资源摘要。
 * 规划员、验收员（第 21 节）从本机同步上来的 plan、verify 会话来：手机和别的电脑上没有本机程序，也看得到本机在跑什么。
 * 验收中的卡：本机起了验收员就列那个会话；没起时云端验收开着（cloudAgents）照旧算云端的验收员，关着算等本机。
 * 没有岗位的执行事项是人自己的活，不算。#号读的时候算：本人列出来的同一岗位的 worker 按开工时间排。
 * 卡在验收中时干活的是云端的验收员。设备 10 分钟内上报过算在线；本机的执行还没结束、但设备不在线的，算「等本机上线」；
 * 本机报 queued 的是「等空位」，排第几和本机程序一样：这台电脑上等空位的按开工先后排。资源的 running、cap 取在线设备最近一批报的 slots。
 * 专题没有「完成」：最近一次执行还没结束的算进行中，带岗位还没开过的算等开工。
 */

/** 设备多久没上报算不在线。跑着的时候状态、计划、花费都会报；闲着时本机每 5 分钟发一批空的当心跳（本机程序契约 LocalSyncBatchRequest）。 */
export const ONLINE_WINDOW_MS = 10 * 60_000;
const ACTIVE = new Set<string>(["queued", "starting", "running", "waiting_permission", "idle"]);
const NEEDS_YOU = new Set<TWorkerMark>(["approval", "reply", "review_failed", "blocked"]);
const ZERO: TWorkerCost = { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null };
const COST_SUM = "sum((tokens->>'input')::bigint) AS input,sum((tokens->>'output')::bigint) AS output,sum(cost_usd) AS usd";

type CostRow = { input: string | null; output: string | null; usd: string | null };
const costOf = (row: CostRow | undefined): TWorkerCost => !row ? ZERO
  : { inputTokens: Number(row.input ?? 0), outputTokens: Number(row.output ?? 0), costUsd: row.usd === null ? null : Number(row.usd), costCny: null };
/** 本机的会话在等空位（本机程序加了同时跑的上限以后会报 queued）。 */
const isQueued = (state: string) => state === "queued";
/** 按开工时间排，等开工（没有开工时间）的排在后面。 */
const byStart = (a: { startedAt: string | null; key: string }, b: { startedAt: string | null; key: string }) =>
  (a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY) - (b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY) || a.key.localeCompare(b.key);

type Draft = Omit<TWorkerItem, "workerNo"> & { group: "running" | "queued" | "done" };

export async function listWorkers(deps: { q: Query; planTasks: PlanTaskSource; now: Date; names: Map<string, string>; reviewModel: string; cloudAgents: boolean },
  ownerId: string): Promise<TWorkersResponse> {
  const { q, now } = deps;
  const devices = (await q("SELECT id::text,name,last_sync_at,slots FROM local_devices WHERE owner_id=$1 AND revoked_at IS NULL ORDER BY created_at", [ownerId])).rows as
    { id: string; name: string; last_sync_at: Date | null; slots: TLocalSlots | null }[];
  const since = now.getTime() - ONLINE_WINDOW_MS;
  const onlineDevices = devices.filter((device) => device.last_sync_at && device.last_sync_at.getTime() > since);
  const online = new Set(onlineDevices.map((device) => device.id));
  const slots = onlineDevices.flatMap((device) => device.slots ? [device.slots] : []);
  const positions = new Map(((await q(`SELECT id::text,row_number() OVER (PARTITION BY device_id ORDER BY started_at,id)::int AS position FROM local_runs
    WHERE owner_id=$1 AND state='queued'`, [ownerId])).rows as { id: string; position: number }[]).map((row) => [row.id, row.position]));
  const elapsed = (start: string | null, end: Date = now) => start ? Math.max(0, Math.round((end.getTime() - Date.parse(start)) / 1000)) : null;

  // 卡：带岗位的、没退回的；完成的只要今天（公司时区）完成的。
  const cardRows = (await q(`SELECT id::text,mission_id,plan_task_id,(acceptance->>'at')::timestamptz AS finished_at FROM tasks
    WHERE owner_id=$1 AND role_id IS NOT NULL AND status<>'returned'
      AND (status<>'done' OR ((acceptance->>'at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
    ORDER BY created_at,id`, [ownerId, now])).rows as { id: string; mission_id: string | null; plan_task_id: string | null; finished_at: Date | null }[];
  const cards = await cardTaskViews(q, cardRows.map((row) => row.id), deps.names);
  const cardCosts = new Map(cardRows.length ? ((await q(`SELECT task_id::text AS id,${COST_SUM} FROM local_runs WHERE task_id=ANY($1::uuid[]) AND kind='card' GROUP BY task_id`,
    [cardRows.map((row) => row.id)])).rows as (CostRow & { id: string })[]).map((row) => [row.id, costOf(row)]) : []);
  const reviewing = cards.filter((card) => card.card.stage === "review");
  const reviewer = reviewing.length ? await reviewerRole(q, ownerId) : null;
  const verifyRuns = await latestRuns(q, "task_id", reviewing.map((card) => card.id), "verify");

  // 本机的规划员：还没结束的 plan 会话。
  const planRuns = (await q(`${RUN_SELECT} WHERE r.owner_id=$1 AND r.kind='plan' AND r.state=ANY($2::text[]) ORDER BY r.started_at,r.id`,
    [ownerId, [...ACTIVE]])).rows as RunRow[];
  const planner = planRuns.length ? await plannerRole(q, ownerId) : null;

  // 专题：带岗位、没归档的。
  const topics = (await q("SELECT id::text,title,role_id::text,plan_task_id,mission_id FROM research_topics WHERE owner_id=$1 AND role_id IS NOT NULL AND status='active'",
    [ownerId])).rows as { id: string; title: string; role_id: string; plan_task_id: string | null; mission_id: string | null }[];
  const topicRuns = await latestRuns(q, "topic_id", topics.map((topic) => topic.id), "topic");
  const topicRoles = await rolesById(q, topics.map((topic) => topic.role_id));
  const topicCosts = new Map(topics.length ? ((await q(`SELECT topic_id::text AS id,${COST_SUM} FROM local_runs WHERE topic_id=ANY($1::uuid[]) GROUP BY topic_id`,
    [topics.map((topic) => topic.id)])).rows as (CostRow & { id: string })[]).map((row) => [row.id, costOf(row)]) : []);

  // Task 名字（本人这个月的 Task，读不到时写 id）和 Mission 名字（规划员的 Mission 取它拆的那个 Task 的）。
  const hasTasks = [...cardRows, ...topics, ...planRuns].some((row) => row.plan_task_id);
  const planTasks = new Map(hasTasks ? (await readPlanTasks(deps.planTasks, planTaskMissions((await ownMissions(q, ownerId, companyPeriod(now))).rows)))
    .map((task) => [task.taskId, task]) : []);
  const missionIds = [...new Set([...cardRows.map((row) => row.mission_id), ...topics.map((topic) => topic.mission_id),
    ...planRuns.map((run) => planTasks.get(run.plan_task_id!)?.missionId ?? null)].filter((id): id is string => Boolean(id)))];
  const missions = new Map(missionIds.length ? ((await q("SELECT id,title FROM missions WHERE id=ANY($1::text[])", [missionIds])).rows as { id: string; title: string }[])
    .map((row) => [row.id, row.title]) : []);
  const taskOf = (id: string | null) => id ? { id, name: planTasks.get(id)?.name ?? id } : null;
  const missionOf = (id: string | null) => id ? { id, title: missions.get(id) ?? "" } : null;
  const step = (plan: TLocalRunPlanProgress | null) => plan?.current ? { n: plan.step, total: plan.total, label: plan.current } : null;
  /**
   * 本机一个会话（专题、规划员、验收员）在列表里的那几样：那台电脑不在线算等本机上线，本机报 queued 算等空位（带排第几）；
   * 等批准、等回复照会话状态；会话停了（exited、failed）算已暂停。
   */
  const session = (run: RunRow) => {
    const brief = runBrief(run);
    const queueReason = ACTIVE.has(run.state) && !online.has(run.device_id) ? "device_offline" as const : isQueued(run.state) ? "slot" as const : null;
    const wait: TWorkerMark | null = queueReason ? null : run.state === "waiting_permission" ? "approval" : run.state === "idle" ? "reply" : ACTIVE.has(run.state) ? null : "paused";
    return { group: queueReason ? "queued" as const : "running" as const, step: step(brief.plan),
      resource: { where: "local" as const, deviceId: brief.deviceId, deviceName: brief.deviceName, modelLabel: brief.modelLabel },
      startedAt: brief.startedAt, elapsedSeconds: elapsed(brief.startedAt), finishedAt: null,
      cost: { inputTokens: brief.cost.inputTokens, outputTokens: brief.cost.outputTokens, costUsd: brief.cost.costUsd, costCny: null },
      wait, needsYou: wait !== null && NEEDS_YOU.has(wait), queueReason, queuePosition: queueReason === "slot" ? positions.get(run.id) ?? null : null };
  };

  const drafts: Draft[] = [];
  for (const card of cards) {
    const row = cardRows.find((item) => item.id === card.id)!;
    const run = card.card.run;
    const role = card.card.role!;
    const base = { key: `card:${card.id}`, kind: "card" as const, cardId: card.id, topicId: null, title: card.title, task: taskOf(row.plan_task_id),
      mission: missionOf(row.mission_id), cost: cardCosts.get(card.id) ?? null, stage: card.card.stage };
    const local = run ? { where: "local" as const, deviceId: run.deviceId, deviceName: run.deviceName, modelLabel: run.modelLabel } : null;
    if (card.card.stage === "todo" && run && isQueued(run.state)) {
      // 本机收下了、在等空位（还没开工，卡在待开始）；那台电脑不在线时算等本机上线。
      const queueReason = online.has(run.deviceId) ? "slot" as const : "device_offline" as const;
      drafts.push({ ...base, group: "queued", role, step: null, resource: local, startedAt: null, elapsedSeconds: null, finishedAt: null,
        wait: null, needsYou: false, queueReason, queuePosition: queueReason === "slot" ? positions.get(run.id) ?? null : null });
    } else if (card.card.stage === "todo") {
      drafts.push({ ...base, group: "queued", role, step: null, resource: null, startedAt: null, elapsedSeconds: null, finishedAt: null,
        wait: null, needsYou: false, queueReason: "not_dispatched", queuePosition: null });
    } else if (card.card.stage === "done") {
      drafts.push({ ...base, group: "done", role, step: null, resource: local, startedAt: run?.startedAt ?? null,
        elapsedSeconds: elapsed(run?.startedAt ?? null, row.finished_at ?? now), finishedAt: row.finished_at?.toISOString() ?? null, wait: null, needsYou: false,
        queueReason: null, queuePosition: null });
    } else if (card.card.stage === "review") {
      const verifier = reviewer ? roleRef(reviewer) : role;
      const handedBack = card.card.handback?.createdAt ?? null;
      // 本机为这次交回起的验收员（交回以后开的那个会话）。
      const verifyRun = verifyRuns.get(card.id);
      const current = verifyRun && handedBack && verifyRun.started_at.getTime() >= Date.parse(handedBack) ? verifyRun : undefined;
      const verify = { ...base, key: `verify:${card.id}`, kind: "verify" as const, role: verifier };
      if (current) drafts.push({ ...verify, ...session(current) });
      else if (deps.cloudAgents) drafts.push({ ...base, group: "running", role: verifier, step: null,
        resource: { where: "cloud", deviceId: null, deviceName: null, modelLabel: deps.reviewModel }, startedAt: handedBack, elapsedSeconds: elapsed(handedBack), finishedAt: null,
        wait: "reviewing", needsYou: false, queueReason: null, queuePosition: null });
      else {
        // 本机还没起验收员：交回的那台电脑在线是等开工，不在线是等本机上线。
        const queueReason = run && online.has(run.deviceId) ? "not_dispatched" as const : "device_offline" as const;
        drafts.push({ ...verify, group: "queued", step: null, resource: run ? { where: "local", deviceId: run.deviceId, deviceName: run.deviceName, modelLabel: null } : null,
          startedAt: null, elapsedSeconds: null, finishedAt: null, cost: null, wait: null, needsYou: false, queueReason, queuePosition: null });
      }
    } else {
      const active = Boolean(run && ACTIVE.has(run.state));
      const queueReason = run && active && !online.has(run.deviceId) ? "device_offline" as const : run && isQueued(run.state) ? "slot" as const : null;
      const wait = queueReason ? null : card.card.wait;
      drafts.push({ ...base, group: queueReason ? "queued" : "running", role, step: step(run?.plan ?? null), resource: local,
        startedAt: run?.startedAt ?? null, elapsedSeconds: elapsed(run?.startedAt ?? null), finishedAt: null, wait, needsYou: wait !== null && NEEDS_YOU.has(wait), queueReason,
        queuePosition: run && queueReason === "slot" ? positions.get(run.id) ?? null : null });
    }
  }
  for (const topic of topics) {
    const role = topicRoles.get(topic.role_id);
    const run = topicRuns.get(topic.id);
    if (!role || (run && !ACTIVE.has(run.state))) continue;
    const base = { key: `topic:${topic.id}`, kind: "topic" as const, cardId: null, topicId: topic.id, title: topic.title, role: roleRef(role),
      task: taskOf(topic.plan_task_id), mission: missionOf(topic.mission_id), cost: topicCosts.get(topic.id) ?? null, finishedAt: null };
    if (!run) {
      drafts.push({ ...base, group: "queued", step: null, resource: null, startedAt: null, elapsedSeconds: null, stage: "todo", wait: null, needsYou: false,
        queueReason: "not_dispatched", queuePosition: null });
      continue;
    }
    const { cost: _cost, ...rest } = session(run);
    drafts.push({ ...base, ...rest, stage: "doing" });
  }
  for (const run of planRuns) {
    if (!planner) break;
    const task = taskOf(run.plan_task_id)!;
    drafts.push({ key: `plan:${run.id}`, kind: "plan", cardId: null, topicId: null, title: task.name, role: roleRef(planner), task,
      mission: missionOf(planTasks.get(task.id)?.missionId ?? null), stage: "doing", ...session(run) });
  }

  // #号：同一岗位按开工时间排（等开工的排在后面）。
  const numbered = new Map<string, number>(), counters = new Map<string, number>();
  for (const draft of [...drafts].sort(byStart)) {
    const next = (counters.get(draft.role.id) ?? 0) + 1;
    counters.set(draft.role.id, next);
    numbered.set(draft.key, next);
  }
  const items = (group: Draft["group"]) => drafts.filter((draft) => draft.group === group)
    .map(({ group: _group, ...item }): TWorkerItem => ({ ...item, workerNo: numbered.get(item.key)! }));

  const today = (await q(`SELECT ${COST_SUM} FROM local_runs WHERE owner_id=$1
    AND (started_at AT TIME ZONE 'Asia/Shanghai')::date=($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`, [ownerId, now])).rows[0] as CostRow;
  const month = (await q(`SELECT ${COST_SUM} FROM local_runs WHERE owner_id=$1
    AND date_trunc('month',started_at AT TIME ZONE 'Asia/Shanghai')=date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Shanghai')`, [ownerId, now])).rows[0] as CostRow;
  return {
    running: items("running").sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || byStart(a, b)),
    queued: items("queued").sort(byStart),
    done: items("done").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")),
    resources: {
      devices: devices.map((device) => ({ id: device.id, name: device.name, lastSeenAt: device.last_sync_at?.toISOString() ?? null, online: online.has(device.id) })),
      running: slots.reduce((sum, slot) => sum + slot.running, 0),
      cap: slots.length ? slots.reduce((sum, slot) => sum + slot.max, 0) : null,
      cost: { today: costOf(today), month: costOf(month) },
    },
  };
}
