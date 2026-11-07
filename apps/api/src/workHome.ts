import type { Pool } from "pg";
import type { TBackgroundItem, TBackgroundResponse, TBackgroundState, TCard, TCardMerge, TCardTaskView, THomeItem, THomeProject, THomeProjectGoal,
  TLocalTaskBudgetView, TMyMeetingCard, TMyMeetingConfirm, TSubSession, TSubSessionState, TWorkerQueueReason, TWorkHomeResponse } from "@warmap/contracts";
import { assembleWaiting, HELD } from "./homeWaiting.js";
import { planTaskMissions, type MissionRow } from "./homePlan.js";
import { failStreak, type HandbackRow } from "./cardProjection.js";
import { askingQuestion, latestRuns, type RunAsk, type RunRow } from "./localDevices.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { readPlanTasks, type PlanTask, type PlanTaskSource } from "./planTasks.js";
import { roleRef, rolesById } from "./roles.js";
import type { MissionRoundPerson } from "./missionRounds.js";
import { CLAIM_TTL } from "./sessionStarts.js";
import { CardError, cardTaskViews, effectiveOutcome } from "./taskCards.js";
import { getTaskViews } from "./tasks.js";
import { ACTIVE, awaitsQuota, heldRuns, workerResources } from "./workers.js";
import { shanghaiDate } from "./workdays.js";
import { settlementsOf } from "./taskContinuity.js";
import { visibleMissions } from "./visibleMissions.js";
import { taskBasis } from "./planTaskAccess.js";
import { CARD_PROJECT, goalsOf, ownProject, PROJECT_SCOPE_PREFIX, projectScope } from "./projects.js";
import { syncProjects } from "./projectSync.js";
import { criteriaMetCounts, type StoredMerge } from "./taskFeed.js";

/**
 * 新首页（契约 workHome.ts，设计《新首页_伙伴总管线与Task管线》第 2、4、7、10.3 节）：左栏的树（Mission → 本人负责的 Task → 子会话和自己做的事项）、「等你」、右栏的后台任务。
 * 子会话的状态和 worker 列表（workers.ts）同一套判断：设备 10 分钟内上报过算在线，本机的会话还在但电脑不在线算等本机上线，本机报 queued 算等空位，
 * 本机报了 hold（订阅额度用完）、那台电脑在线、恢复时间没到算等额度恢复。「等你」的组装在 homeWaiting.ts。
 */

const SHANGHAI_DAY = (column: string, param: string) =>
  `(${column} AT TIME ZONE 'Asia/Shanghai')::date=(${param}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`;
/** 树上同一格里的先后：等你、没过、进行中、已排队、已完成。 */
const STATE_ORDER: TSubSessionState[] = ["waiting", "failed", "running", "queued", "done"];
const latest = (...times: (string | Date | null | undefined)[]) =>
  new Date(Math.max(...times.filter((time): time is string | Date => Boolean(time)).map((time) => new Date(time).getTime()))).toISOString();
/** 树上的一件 Task：本体的 Task，带它所在 Mission 的月份和本人确认完成的时间。 */
export type TreeTask = PlanTask & { period: string; completedAt: string | null };
/** carried：之前月份带过来的（本人这个月的 Mission 为 false，首页「本月」只列这些）。 */
type TreeMission = MissionRow & { period: string; owner_id: string; carried: boolean };
const MISSION_SELECT = `SELECT id,code,title,period,owner_id,personal_mission_card_id::text AS card_id,milestones,source_revision,
    world_scope_id,world_object_id,world_domain_id,world_status,world_status_label,world_read_at,world_gaps FROM missions`;

/**
 * 左栏的 Task（设计 10.3，不按月份硬切）。树和「自动」发给谁、后台任务的 Task 名共用这一份。Mission 取看得见的（visibleMissions.ts，B2）：
 * - 本人这个月的 Mission（本月没有就退回本人最近一个月；本月已从本体载入过就不退回）下本人负责的 Task（本体没登记负责人的算 Mission 负责人的），了结了也列（打勾）；
 * - 之前月份里本人动过、没了结的 Task（carried，openTaskIds；谁负责的 Mission 都算），再照本人负责过滤。动过：挂过执行事项或卡、开过专题、出过交付版本、开过 Task 管线。
 * 了结（确认完成、到此为止、已延续）照 taskContinuity.ts 的 settlementsOf；completedAt 是确认完成的时间。本体读不到（超时、出错）的 Task 不列。
 */
export async function treeTasks(q: Query, planTasks: PlanTaskSource, personId: string, now: Date): Promise<{ period: string; missions: TreeMission[]; tasks: TreeTask[] }> {
  const period = companyPeriod(now);
  const visible = await visibleMissions(q, now, { personId });
  const rows = visible.length ? (await q(`${MISSION_SELECT} WHERE id=ANY($1::text[])`, [visible.map((mission) => mission.id)])).rows as TreeMission[] : [];
  const byId = new Map(rows.map((mission) => [mission.id, mission]));
  const own = visible.filter((mission) => !mission.carried).flatMap((mission) => byId.get(mission.id) ?? []);
  const carried = visible.filter((mission) => mission.carried && byId.has(mission.id));
  const open = new Set(carried.flatMap((mission) => mission.openTaskIds));
  const mine = (task: PlanTask) => task.responsibleId ? task.responsibleId === personId : byId.get(task.missionId)?.owner_id === personId;
  const ownTasks = own.length ? (await readPlanTasks(planTasks, planTaskMissions(own))).filter(mine) : [];
  const shown = new Set(ownTasks.map((task) => task.taskId));
  const carriedTasks = carried.length ? (await readPlanTasks(planTasks, planTaskMissions(carried.map((mission) => byId.get(mission.id)!))))
    .filter((task) => open.has(task.taskId) && !shown.has(task.taskId) && mine(task)) : [];
  const settlements = await settlementsOf(q, [...ownTasks, ...carriedTasks].map((task) => task.taskId));
  const withState = (task: PlanTask): TreeTask => {
    const settlement = settlements.get(task.taskId);
    return { ...task, period: byId.get(task.missionId)!.period, completedAt: settlement?.kind === "completed" ? new Date(settlement.at).toISOString() : null };
  };
  const tasks = [...ownTasks.map(withState), ...carriedTasks.filter((task) => !settlements.has(task.taskId)).map(withState)];
  const listed = new Set(tasks.map((task) => task.missionId));
  // 本人这个月的在前（按 code），之前的按月份从近到远、再按 code；之前月份的 Mission 只在有 Task 时列。
  const missions = [...own.sort((a, b) => a.code.localeCompare(b.code)).map((mission) => ({ ...mission, carried: false })),
    ...carried.map((mission) => ({ ...byId.get(mission.id)!, carried: true })).filter((mission) => listed.has(mission.id))
      .sort((a, b) => b.period.localeCompare(a.period) || a.code.localeCompare(b.code))];
  return { period, missions, tasks };
}

/** 合回结果给界面：合进去了是 merged；没合是 needs_merge，带原因和给人看的话。 */
const cardMerge = (stored: StoredMerge): TCardMerge => ({ state: stored.merged ? "merged" : "needs_merge", commit: stored.commit ?? null,
  baseBranch: stored.baseBranch ?? null, reason: stored.merged ? null : stored.reason ?? null, message: stored.merged ? null : stored.message ?? null,
  at: new Date(stored.at).toISOString() });

/** 树和等你共用的子会话：外加挂的 Task、最近一次执行的时间、验收通过的时间（卡），以及交回那次执行在哪（等你合回用）。 */
export type HomeSub = TSubSession & { planTaskId: string | null; projectId: string | null; runUpdatedAt: string | null; acceptedAt: string | null;
  mergeRun: { sessionId: string | null; deviceId: string | null } | null;
  /** 最近一次执行在问本人的提问、在等批准的那一步（等你那一行用原话、就地答）。 */
  ask: RunAsk | null };
type MeetingPending = { meetings: TMyMeetingCard[]; confirms: TMyMeetingConfirm[] };

export type WorkHomeDeps = {
  q: Query; pool: Pool; planTasks: PlanTaskSource; now: Date; names: Map<string, string>;
  /** 接了 Chat 服务：项目对话的 id 记在 project_pipelines；没接时是天枢自己 scope 为 project:<projectId> 的对话。 */
  chat: boolean;
  /** 会议记录等我确认的（通知栏同一份，meetingCard.ts 的 pendingFor）。 */
  meetings: (personId: string) => Promise<MeetingPending>;
  /** 我看得到的 Mission Card 轮次（missionRounds.ts 的 listMissionRoundCards）。 */
  missionRounds: (person: MissionRoundPerson) => Promise<TCard[]>;
};

/** 这个月（YYYY-MM）的最后一天（YYYY-MM-DD）：本体的 Task 没有截止日，项目行的「{截止} 验收」取它所在月份的月底。 */
const monthEnd = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

/**
 * GET /api/me/work-home（第 16 节的 v2）；伙伴的汇总（/internal/me/work-home）读同一份。读之前先把项目理顺（上线迁移、自动挂接，projectSync.ts）。
 * 子会话、事项在哪个项目：挂着 Task 的跟着 Task 挂的项目，其次是自己记的 project_id；不在没归档的项目里的进「其他」。
 */
export async function readWorkHome(deps: WorkHomeDeps, person: MissionRoundPerson): Promise<TWorkHomeResponse> {
  const { q, now } = deps;
  const ownerId = person.personId;
  const { period, missions, tasks } = await treeTasks(q, deps.planTasks, ownerId, now);
  await syncProjects(deps.pool, ownerId, missions, tasks, now);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const projectRows = (await q("SELECT id::text,name,archived_at,created_at FROM projects WHERE owner_id=$1 ORDER BY created_at,id", [ownerId])).rows as
    { id: string; name: string; archived_at: Date | null; created_at: Date }[];
  const active = projectRows.filter((row) => !row.archived_at);
  const activeIds = new Set(active.map((row) => row.id));
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  const goals = await goalsOf(q, ownerId);
  /** 一件 Task 挂在哪个项目（没挂、取下来了为 null）。 */
  const taskProject = (taskId: string | null) => taskId ? goals.get(taskId)?.project_id ?? null : null;
  const devices = (await workerResources(q, ownerId, now)).devices;
  const online = new Set(devices.filter((device) => device.online).map((device) => device.id));
  // 还没有哪台电脑接下的：没了结、没人认领或认领过期（和 sessionStarts.ts 的 claimStarts 同一个条件，别处可以再认领）。
  const starts = (await q(`SELECT card_id::text,topic_id::text FROM session_starts WHERE owner_id=$1 AND closed_at IS NULL
    AND (claimed_at IS NULL OR claimed_at < $2::timestamptz - interval '${CLAIM_TTL}')`, [ownerId, now])).rows as { card_id: string | null; topic_id: string | null }[];
  const autoStart = new Set(starts.map((row) => (row.card_id ?? row.topic_id)!));
  /** 还没开过的：登记了要开工、本人又没有在线的电脑，是等本机上线；别的是等开工。 */
  const notStarted = (id: string): TWorkerQueueReason => autoStart.has(id) && !online.size ? "device_offline" : "not_dispatched";
  const priorWaits = new Set(((await q("SELECT id::text FROM local_runs WHERE owner_id=$1 AND state='queued' AND waiting_for IS NOT NULL", [ownerId])).rows as
    { id: string }[]).map((row) => row.id));
  const held = await heldRuns(q, ownerId);
  /**
   * 本机的会话停着等额度恢复（那台电脑在线、恢复时间没到）：等额度恢复；会话还在或停着等额度、那台电脑不在线：等本机上线；
   * 本机报 queued：等空位（在等前面的卡时是等前面的卡）。都不是为 null。
   */
  const queuedBy = (run: { id: string; deviceId: string; state: string }): TWorkerQueueReason | null =>
    held.has(run.id) && awaitsQuota(held.get(run.id) ?? null, run.deviceId, online, now) ? "quota"
      : (ACTIVE.has(run.state) || held.has(run.id)) && !online.has(run.deviceId) ? "device_offline"
        : run.state === "queued" ? priorWaits.has(run.id) ? "prior_cards" : "slot" : null;
  const holdUntil = (queueReason: TWorkerQueueReason | null, runId: string | undefined) => {
    const until = queueReason === "quota" && runId ? held.get(runId) : null;
    return until ? new Date(until).toISOString() : null;
  };

  // 卡：带岗位或交给 Claude Code 的、没退回的。完成的：挂在树上 Task 下的都列（不看月份），不挂 Task 的只要这个月（公司时区）完成的；
  // 挂在不在树上的 Task（了结了、不是本人负责）下、已完成的不列。没能自动合回的（最近一次算通过的交回上本机报了 merged = false）还在等你合，
  // 不看月份、不看 Task 在不在树上，一律列。
  const cardRows = (await q(`SELECT id::text,acceptance->>'at' AS accepted_at,project_id::text FROM tasks WHERE owner_id=$1 AND status<>'returned'
      AND (role_id IS NOT NULL OR executor='claude_code')
      AND (status<>'done' OR plan_task_id=ANY($3::text[]) OR (plan_task_id IS NULL
        AND date_trunc('month',(acceptance->>'at')::timestamptz AT TIME ZONE 'Asia/Shanghai')=date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Shanghai'))
        OR (SELECT h.merge->>'merged' FROM card_handbacks h WHERE h.task_id=tasks.id AND h.status='done'
          AND (h.outcome='pass' AND h.overruled_at IS NULL OR h.outcome='fail' AND h.overruled_at IS NOT NULL) ORDER BY h.attempt DESC LIMIT 1)='false')
    ORDER BY created_at,id`, [ownerId, now, tasks.map((task) => task.taskId)])).rows as { id: string; accepted_at: string | null; project_id: string | null }[];
  const acceptedAt = new Map(cardRows.map((row) => [row.id, row.accepted_at]));
  const cardProject = new Map(cardRows.map((row) => [row.id, row.project_id]));
  const cards = await cardTaskViews(q, cardRows.map((row) => row.id), deps.names);
  // 合回：每张卡最近一次算通过的交回（推翻过的按本人的判断算）上本机报的合回结果，和交回那次执行在哪台电脑。
  const handbacks = cards.length ? (await q(`SELECT h.task_id::text,h.status,h.outcome,h.overruled_at,h.merge,h.run_id::text,r.device_id::text
    FROM card_handbacks h LEFT JOIN local_runs r ON r.id=h.run_id WHERE h.task_id=ANY($1::uuid[]) ORDER BY h.attempt DESC`, [cards.map((view) => view.id)])).rows as
    { task_id: string; status: HandbackRow["status"]; outcome: "pass" | "fail" | null; overruled_at: Date | null; merge: StoredMerge | null; run_id: string | null; device_id: string | null }[] : [];
  const passed = new Map<string, (typeof handbacks)[number]>();
  for (const row of handbacks) if (!passed.has(row.task_id) && row.status === "done" && effectiveOutcome(row) === "pass") passed.set(row.task_id, row);
  /** 连续两次验收没过（受阻、等你拿主意）；卡的标记 blocked 还包括执行连续两次异常退出，那种首页算已暂停。 */
  const reviewBlocked = (cardId: string) => failStreak(handbacks.filter((row) => row.task_id === cardId)) >= 2;

  const runIds = cards.flatMap((view) => view.card.run ? [view.card.run.id] : []);
  const asks = new Map(runIds.length ? ((await q("SELECT id::text,ask FROM local_runs WHERE id=ANY($1::uuid[]) AND ask IS NOT NULL", [runIds])).rows as
    { id: string; ask: RunAsk }[]).map((row) => [row.id, row.ask]) : []);
  const subs: HomeSub[] = [];
  for (const view of cards) {
    const { stage, wait, run, role } = view.card;
    const pass = passed.get(view.id);
    const merge = pass?.merge ? cardMerge(pass.merge) : null;
    const base = { id: view.id, kind: "card" as const, title: view.title, role, sessionId: run?.id ?? null, deviceId: run?.deviceId ?? null,
      autoStart: autoStart.has(view.id), updatedAt: latest(view.updatedAt, run?.updatedAt), planTaskId: view.planTaskId,
      projectId: taskProject(view.planTaskId) ?? cardProject.get(view.id) ?? null, runUpdatedAt: run?.updatedAt ?? null,
      merge, acceptedAt: stage === "done" ? acceptedAt.get(view.id) ?? null : null, mergeRun: pass ? { sessionId: pass.run_id, deviceId: pass.device_id } : null,
      ask: run ? asks.get(run.id) ?? null : null };
    let state: TSubSessionState = "running", waiting: TSubSession["waiting"] = null, queueReason: TWorkerQueueReason | null = null;
    // 验收过了：合进去了（或不用合、本机没报）是完成；没能自动合回是等你合。
    if (stage === "done") [state, waiting] = merge?.state === "needs_merge" ? ["waiting", "merge"] : ["done", null];
    else if (stage === "review") state = "running";
    else if (stage === "todo") {
      // 还没开工；本机收下了在等空位、等前面的卡、等额度恢复时照本机报的。
      state = "queued";
      queueReason = run ? queuedBy(run) ?? notStarted(view.id) : notStarted(view.id);
    } else if (wait === "blocked" && reviewBlocked(view.id)) [state, waiting] = ["waiting", "verdict"];
    // 连续两次验收没过要你拿主意，不用等电脑：排在排队前面。
    else if (run && (queueReason = queuedBy(run))) state = "queued";
    else if (wait === "blocked") state = "waiting";
    else if (wait === "review_failed") state = "failed";
    else if (wait === "approval") [state, waiting] = ["waiting", "approval"];
    else if (wait === "reply") [state, waiting] = ["waiting", "question"];
    else if (wait === "paused") state = "waiting";
    subs.push({ ...base, state, waiting, queueReason, holdUntil: holdUntil(queueReason, run?.id) });
  }

  // 专题：没归档的都列；最近一次本机执行定状态。专题没有「完成」：会话停了、交完收工、异常退出都算已暂停（等你说一句接着做）。
  const topics = (await q(`SELECT id::text,title,role_id::text,plan_task_id,project_id::text,updated_at FROM research_topics WHERE owner_id=$1 AND status='active'
    ORDER BY created_at,id`, [ownerId])).rows as { id: string; title: string; role_id: string | null; plan_task_id: string | null; project_id: string | null; updated_at: Date }[];
  const topicRuns = await latestRuns(q, "topic_id", topics.map((topic) => topic.id), "topic");
  const topicRoles = await rolesById(q, topics.map((topic) => topic.role_id));
  const TOPIC_STATES: Record<RunRow["state"], [TSubSessionState, TSubSession["waiting"]]> = { queued: ["queued", null], starting: ["running", null],
    running: ["running", null], waiting_permission: ["waiting", "approval"], idle: ["waiting", "question"], exited: ["waiting", null], failed: ["waiting", null],
    done: ["waiting", null] };
  for (const topic of topics) {
    const run = topicRuns.get(topic.id);
    const role = topic.role_id ? topicRoles.get(topic.role_id) : undefined;
    const base = { id: topic.id, kind: "topic" as const, title: topic.title, role: role ? roleRef(role) : null, sessionId: run?.id ?? null, deviceId: run?.device_id ?? null,
      autoStart: autoStart.has(topic.id), updatedAt: latest(topic.updated_at, run?.updated_at), planTaskId: topic.plan_task_id,
      projectId: taskProject(topic.plan_task_id) ?? topic.project_id, runUpdatedAt: run?.updated_at.toISOString() ?? null,
      merge: null, acceptedAt: null, mergeRun: null, ask: run?.ask ?? null };
    if (!run) { subs.push({ ...base, state: "queued", waiting: null, queueReason: notStarted(topic.id), holdUntil: null }); continue; }
    const queueReason = queuedBy({ id: run.id, deviceId: run.device_id, state: run.state });
    // 一轮做完停下、没在问你：已停下（waiting / null），不进等你（9.6）。
    const [state, waiting] = queueReason ? ["queued" as const, null] : run.state === "idle" && !askingQuestion(run) ? ["waiting" as const, null] : TOPIC_STATES[run.state];
    subs.push({ ...base, state, waiting, queueReason, holdUntil: holdUntil(queueReason, run.id) });
  }

  const order = (a: HomeSub, b: HomeSub) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.updatedAt.localeCompare(a.updatedAt);
  const view = ({ planTaskId: _task, projectId: _project, runUpdatedAt: _at, acceptedAt: _accepted, mergeRun: _run, ask: _ask, ...sub }: HomeSub): TSubSession => sub;
  const onProject = (projectId: string | null) => projectId !== null && activeIds.has(projectId);

  // 规划员在拆：本机的规划员会话还没结束，或登记了拆卡还没开。
  const planRuns = (await q("SELECT plan_task_id FROM local_runs WHERE owner_id=$1 AND kind='plan' AND state=ANY($2::text[])",
    [ownerId, [...ACTIVE]])).rows as { plan_task_id: string }[];
  const splits = (await q("SELECT plan_task_id FROM card_split_requests WHERE owner_id=$1 AND closed_at IS NULL", [ownerId])).rows as { plan_task_id: string }[];
  const planning = new Set([...planRuns.map((run) => run.plan_task_id), ...splits.map((row) => row.plan_task_id)]);
  // 项目对话：接了 Chat 记在 project_pipelines；没接时是天枢自己 scope 为 project:<id> 的对话。
  const pipelines = new Map(active.length ? (deps.chat
    ? (await q("SELECT project_id::text AS project,conversation_id AS id FROM project_pipelines WHERE project_id=ANY($1::uuid[])", [[...activeIds]])).rows
    : (await q(`SELECT DISTINCT ON (scope) substr(scope,${PROJECT_SCOPE_PREFIX.length + 1}) AS project,id::text FROM conversations
        WHERE owner_id=$1 AND scope=ANY($2::text[]) AND deleted_at IS NULL AND archived_at IS NULL ORDER BY scope,created_at,id`,
      [ownerId, active.map((row) => projectScope(row.id))])).rows).map((row) => [row.project as string, row.id as string]) : []);

  // 自己做的执行事项（设计 9.10）：没有岗位、不交给 Agent 的，挂在树上的 Task 下（退回的不列），和直接放在项目里、没完成的；没挂 Mission 的进「其他」。
  const homeItem = (item: TCardTaskView): THomeItem => ({ id: item.id, title: item.title, status: item.status as THomeItem["status"], dueDate: item.dueDate,
    awaitingAcceptance: item.awaitingAcceptance, updatedAt: item.updatedAt });
  const itemRows = (await q(`SELECT id::text,project_id::text FROM tasks WHERE owner_id=$1 AND status<>'returned' AND role_id IS NULL AND executor IS DISTINCT FROM 'claude_code'
      AND (plan_task_id=ANY($2::text[]) OR plan_task_id IS NULL AND project_id=ANY($3::uuid[]) AND status<>'done') ORDER BY created_at,id`,
  [ownerId, tasks.map((task) => task.taskId), [...activeIds]])).rows as { id: string; project_id: string | null }[];
  const itemProject = new Map(itemRows.map((row) => [row.id, row.project_id]));
  const ownItems = itemRows.length ? await getTaskViews(q, itemRows.map((row) => row.id), deps.names) : [];
  const itemIn = (item: TCardTaskView) => taskProject(item.planTaskId) ?? itemProject.get(item.id) ?? null;
  // 「其他」里的事项（9.10）：没挂 Mission、不在项目里、没完成没退回的，会议或 Agent 分派来待归位的，和本人自己建的独立事项，新的在前。
  const loose = await getTaskViews(q, ((await q(`SELECT id::text FROM tasks WHERE owner_id=$1 AND mission_id IS NULL AND project_id IS NULL AND status NOT IN ('done','returned')
      AND role_id IS NULL AND executor IS DISTINCT FROM 'claude_code' ORDER BY created_at DESC,id`, [ownerId])).rows as { id: string }[]).map((row) => row.id), deps.names);

  const waiting = await assembleWaiting({ q, person, deps, period, subs, cards, taskById, taskProject, projectNames, devices, openSplits: splits.length });
  const today = shanghaiDate(now);

  // 目标：树上挂在没归档的项目上的 Task；标准几条达到、预算到没到 80%。
  const goalTasks = tasks.filter((task) => onProject(taskProject(task.taskId)));
  const criteriaOf = new Map(goalTasks.map((task) => [task.taskId, taskBasis(task).criteria]));
  const met = await criteriaMetCounts(q, ownerId, goalTasks.map((task) => ({ taskId: task.taskId, count: criteriaOf.get(task.taskId)!.length })));
  const budgets = goalTasks.length ? (await q("SELECT view FROM local_task_budgets WHERE owner_id=$1 AND subject_key=ANY($2::text[])",
    [ownerId, goalTasks.map((task) => `task:${task.taskId}`)])).rows as { view: TLocalTaskBudgetView }[] : [];
  const homeProjects = active.map((row): THomeProject => {
    const projectGoals: THomeProjectGoal[] = goalTasks.filter((task) => taskProject(task.taskId) === row.id).map((task) => ({ taskId: task.taskId,
      missionId: task.missionId, name: task.name, period: task.period, dueDate: monthEnd(task.period), criteria: criteriaOf.get(task.taskId)!,
      criteriaMet: met.get(task.taskId) ?? 0, criteriaTotal: criteriaOf.get(task.taskId)!.length, completedAt: task.completedAt }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
    const ids = new Set(projectGoals.map((goal) => goal.taskId));
    const mine = subs.filter((sub) => sub.projectId === row.id).sort(order);
    const items = ownItems.filter((item) => itemIn(item) === row.id);
    const count = (...states: TSubSessionState[]) => mine.filter((sub) => states.includes(sub.state)).length;
    const over = budgets.map((entry) => entry.view).filter((budget) => budget.taskId && ids.has(budget.taskId) && budget.state !== "ok")
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
    const linked = [...goals.values()].filter((goal) => goal.project_id === row.id).map((goal) => goal.linked_at);
    return { projectId: row.id, name: row.name, goals: projectGoals,
      budget: over ? { state: over.state as "warning" | "exhausted", percent: Math.round((over.ratio ?? 0) * 100), taskId: over.taskId! } : null,
      lastActivityAt: latest(row.created_at, ...linked, ...mine.map((sub) => sub.updatedAt), ...items.map((item) => item.updatedAt)),
      summary: { running: count("running"), waiting: count("waiting", "failed"), queued: count("queued"), done: count("done"),
        doneToday: mine.filter((sub) => sub.acceptedAt && shanghaiDate(new Date(sub.acceptedAt)) === today).length,
        needsYou: waiting.filter((item) => item.projectId === row.id).length },
      pipeline: { conversationId: pipelines.get(row.id) ?? null, scope: projectScope(row.id) },
      planning: projectGoals.some((goal) => planning.has(goal.taskId)), subSessions: mine.map(view), items: items.map(homeItem) };
  });
  // 16.2：有等你的在前；然后是有目标的、按最早的截止日；最后按最近动静从近到远。
  const rank = (project: THomeProject) => project.summary.needsYou ? 0 : project.goals.length ? 1 : 2;
  homeProjects.sort((a, b) => rank(a) - rank(b) || (a.goals[0]?.dueDate ?? "").localeCompare(b.goals[0]?.dueDate ?? "")
    || b.lastActivityAt.localeCompare(a.lastActivityAt) || a.projectId.localeCompare(b.projectId));

  // 本月（16.4）：本人这个月的 Mission，下面本人负责的 Task 和挂在哪个项目。
  const month = { missions: missions.filter((mission) => !mission.carried).map((mission) => ({ missionId: mission.id, title: mission.title, period: mission.period,
    tasks: tasks.filter((task) => task.missionId === mission.id).map((task) => {
      const projectId = taskProject(task.taskId);
      return { taskId: task.taskId, name: task.name, completedAt: task.completedAt, project: projectId ? { projectId, name: projectNames.get(projectId)! } : null };
    }) })) };

  return { period, projects: homeProjects, archivedCount: projectRows.length - active.length, month,
    other: { subSessions: subs.filter((sub) => !onProject(sub.projectId)).sort(order).map(view), items: loose.map(homeItem) }, waiting };
}

/**
 * scope：main 全部；project:<id> 这个项目挂过的 Task 的规划员，加项目里各卡（含验收员）、专题会话里的；task:<id> 这件 Task 的规划员和它下面各卡、专题会话里的；
 * card:<id>、topic:<id> 这张卡（含它的验收员）、这个专题会话里的；
 * resources 只要资源块（二级页、月份页）。
 */
type Scope = { kind: "main" | "resources" } | { kind: "task" | "card" | "topic" | "project"; id: string };
const parseScope = (scope: string): Scope => scope === "main" || scope === "resources" ? { kind: scope }
  : { kind: scope.slice(0, scope.indexOf(":")) as "task" | "card" | "topic" | "project", id: scope.slice(scope.indexOf(":") + 1) };

/** GET /api/me/background?scope=…：卡、专题不是本人的 404。 */
export async function readBackground(deps: { q: Query; now: Date; planTasks: PlanTaskSource }, ownerId: string, rawScope: string): Promise<TBackgroundResponse> {
  const { q, now } = deps;
  const scope = parseScope(rawScope);
  if (scope.kind === "resources") return { items: [], resources: await workerResources(q, ownerId, now) };
  if (scope.kind === "card" || scope.kind === "topic") {
    const table = scope.kind === "card" ? "tasks" : "research_topics";
    // 契约只限了字符和长度，不是 UUID 的先挡掉（id 是 uuid 列，直接查会报错）。
    if (!UUID_PATTERN.test(scope.id) || !(await q(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_id=$2`, [scope.id, ownerId])).rows.length)
      throw new CardError(404, "NOT_FOUND", scope.kind === "card" ? "找不到这张卡" : "找不到这个专题");
  }
  // 项目：本人的（不是 404），挂过的 Task 和项目里的卡、专题。
  const project = scope.kind === "project" ? await ownProject(q, ownerId, scope.id).then(async (row) => ({
    tasks: new Set(((await q("SELECT task_id FROM project_goals WHERE project_id=$1", [row.id])).rows as { task_id: string }[]).map((goal) => goal.task_id)),
    cards: new Set(((await q(`SELECT t.id::text FROM tasks t WHERE t.owner_id=$1 AND ${CARD_PROJECT("t")}=$2`, [ownerId, row.id])).rows as { id: string }[]).map((card) => card.id)),
    topics: new Set(((await q(`SELECT r.id::text FROM research_topics r WHERE r.owner_id=$1 AND ${CARD_PROJECT("r")}=$2`, [ownerId, row.id])).rows as { id: string }[])
      .map((topic) => topic.id)),
  })) : null;
  /** 一项挂在哪：Task（规划员拆的、卡或专题挂的）、卡、专题；项目看这几样有没有一样在项目里。 */
  const inScope = (at: { taskId: string | null; cardId: string | null; topicId: string | null }) => !("id" in scope)
    || (project ? Boolean(at.taskId && project.tasks.has(at.taskId) || at.cardId && project.cards.has(at.cardId) || at.topicId && project.topics.has(at.topicId))
      : scope.kind === "task" ? at.taskId === scope.id : scope.kind === "card" ? at.cardId === scope.id : at.topicId === scope.id);
  const items: TBackgroundItem[] = [];

  // 规划员、验收员：还在的、停着等额度恢复的（那台电脑在线、恢复时间没到），和今天结束的。
  const resources = await workerResources(q, ownerId, now);
  const online = new Set(resources.devices.filter((device) => device.online).map((device) => device.id));
  const runs = (await q(`SELECT r.id::text,r.kind,r.state,r.title,r.device_id::text,r.task_id::text,r.plan_task_id,r.started_at,r.ended_at,t.title AS card_title,t.plan_task_id AS card_task,
      CASE WHEN ${HELD} THEN r.hold->>'until' END AS hold_until,${HELD} AS held,COALESCE(${SHANGHAI_DAY("r.ended_at", "$3")},false) AS ended_today,
      CASE WHEN r.kind='plan' THEN EXISTS (SELECT 1 FROM card_plans p WHERE p.run_id=r.id) ELSE EXISTS (SELECT 1 FROM card_handbacks h WHERE h.verify_run_id=r.id) END AS delivered
    FROM local_runs r LEFT JOIN tasks t ON t.id=r.task_id
    WHERE r.owner_id=$1 AND r.kind IN ('plan','verify') AND (r.state=ANY($2::text[]) OR ${HELD} OR ${SHANGHAI_DAY("r.ended_at", "$3")})`, [ownerId, [...ACTIVE], now])).rows as
    { id: string; kind: "plan" | "verify"; state: string; title: string | null; device_id: string; task_id: string | null; plan_task_id: string | null; started_at: Date;
      ended_at: Date | null; card_title: string | null; card_task: string | null; hold_until: string | null; held: boolean; ended_today: boolean; delivered: boolean }[];
  const planTaskIds = runs.some((run) => run.kind === "plan")
    ? new Map((await treeTasks(q, deps.planTasks, ownerId, now)).tasks.map((task) => [task.taskId, task.name])) : new Map<string, string>();
  for (const run of runs) {
    const plan = run.kind === "plan";
    const at = plan ? { taskId: run.plan_task_id, cardId: null, topicId: null } : { taskId: run.card_task, cardId: run.task_id, topicId: null };
    const quota = run.held && awaitsQuota(run.hold_until, run.device_id, online, now);
    // 报了 hold 却不算等额度（电脑不在线、恢复时间过了）的，照没报 hold 算：会话退出了、又不是今天结束的不列。
    if (!inScope(at) || (!quota && !ACTIVE.has(run.state) && !run.ended_today)) continue;
    // 停着等额度恢复的在排队；交完收工（done）是完成；会话退出了：交了派活单（规划员）、交了结论（验收员）算完成，没交算被停了。
    const state: TBackgroundState = quota || run.state === "queued" ? "queued" : ACTIVE.has(run.state) ? "running" : run.state === "failed" ? "failed"
      : run.state === "done" || run.delivered ? "done" : "stopped";
    const open = state === "queued" || state === "running";
    const title = plan ? `拆卡：${planTaskIds.get(run.plan_task_id!) ?? run.title ?? run.plan_task_id}` : run.title ?? `验收：${run.card_title ?? ""}`;
    items.push({ id: `${run.kind}:${run.id}`, title, kind: run.kind, state, startedAt: run.started_at.toISOString(), finishedAt: open ? null : run.ended_at?.toISOString() ?? null,
      stoppable: ACTIVE.has(run.state), sessionId: run.id, itemId: null, deviceId: run.device_id, ...at,
      holdUntil: quota && run.hold_until ? new Date(run.hold_until).toISOString() : null });
  }

  // 子会话里的子 agent、后台命令（本机报的 background 同步条目）。
  const background = (await q(`SELECT b.item_id,b.kind,b.title,b.state,b.started_at,b.finished_at,b.stoppable,r.id::text AS run_id,r.state AS run_state,r.device_id::text,
      r.task_id::text,r.topic_id::text,COALESCE(r.plan_task_id,t.plan_task_id,rt.plan_task_id) AS plan_task_id
    FROM local_background_items b JOIN local_runs r ON r.id=b.run_id LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN research_topics rt ON rt.id=r.topic_id
    WHERE b.owner_id=$1 AND (b.state='running' OR ${SHANGHAI_DAY("COALESCE(b.finished_at,b.updated_at)", "$2")})`, [ownerId, now])).rows as
    { item_id: string; kind: "subagent" | "command"; title: string; state: TBackgroundState; started_at: Date; finished_at: Date | null; stoppable: boolean; run_id: string;
      run_state: string; device_id: string; task_id: string | null; topic_id: string | null; plan_task_id: string | null }[];
  for (const row of background) {
    const at = { taskId: row.plan_task_id, cardId: row.task_id, topicId: row.topic_id };
    if (!inScope(at)) continue;
    items.push({ id: `bg:${row.run_id}:${row.item_id}`, title: row.title, kind: row.kind, state: row.state, startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null, stoppable: row.stoppable && row.state === "running" && ACTIVE.has(row.run_state),
      sessionId: row.run_id, itemId: row.item_id, deviceId: row.device_id, ...at, holdUntil: null });
  }

  // 没结束的按开始时间在前，结束的按结束时间新的在前。
  const open = (item: TBackgroundItem) => item.state === "queued" || item.state === "running";
  items.sort((a, b) => Number(open(b)) - Number(open(a))
    || (open(a) ? (a.startedAt ?? "").localeCompare(b.startedAt ?? "") : (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")));
  return { items, resources };
}
