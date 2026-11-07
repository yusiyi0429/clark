import type { TBackgroundItem, TBackgroundResponse, TBackgroundState, TCard, TCardMerge, TCardTaskView, THomeItem, THomeMission, THomeTask,
  TMyMeetingCard, TMyMeetingConfirm, TSubSession, TSubSessionState, TWorkerQueueReason, TWorkHomeResponse } from "@warmap/contracts";
import { ACTIVE_CONVERSATION_WHERE } from "./conversations.js";
import { assembleWaiting, HELD } from "./homeWaiting.js";
import { planTaskMissions, type MissionRow } from "./homePlan.js";
import { failStreak, type HandbackRow } from "./cardProjection.js";
import { latestRuns, type RunRow } from "./localDevices.js";
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
/** YYYY-MM 往前数 n 个月。 */
const monthsBefore = (period: string, n: number) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 - n, 1)).toISOString().slice(0, 7);
};

/** 树上的一件 Task：本体的 Task，带它所在 Mission 的月份和本人确认完成的时间。 */
export type TreeTask = PlanTask & { period: string; completedAt: string | null };
type TreeMission = MissionRow & { period: string; owner_id: string };
const MISSION_SELECT = `SELECT id,code,title,period,owner_id,personal_mission_card_id::text AS card_id,milestones,source_revision,
    world_scope_id,world_object_id,world_domain_id,world_status,world_status_label,world_read_at,world_gaps FROM missions`;

/**
 * 了结（设计 10.3）：了结的 Task 不在左栏（本月的照列、打勾）。现在只认本人确认完成（completedAt）。
 * 复盘定了到此为止、已延续成新月份的 Task：B2 做，数据到了改成调它的辅助函数。
 */
export const settled = (task: Pick<TreeTask, "completedAt">) => task.completedAt !== null;

/**
 * 本人确认完成的时间（V1 的交付）：这件 Task 最新一版交付物交付了，且交付以后这件 Task 下没开过返工卡；否则不在表里。
 */
async function completedTimes(q: Query, taskIds: string[]): Promise<Map<string, string>> {
  if (!taskIds.length) return new Map();
  const rows = (await q(`SELECT v.task_id,v.delivered_at FROM (SELECT DISTINCT ON (task_id) task_id,delivered_at FROM deliverable_versions
      WHERE task_id=ANY($1::text[]) ORDER BY task_id,number DESC) v
    WHERE v.delivered_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.plan_task_id=v.task_id AND t.rework_of_card_id IS NOT NULL AND t.created_at>v.delivered_at)`,
  [taskIds])).rows as { task_id: string; delivered_at: Date }[];
  return new Map(rows.map((row) => [row.task_id, row.delivered_at.toISOString()]));
}

/**
 * 左栏的 Task（设计 10.3，不按月份硬切）。树和「自动」发给谁、后台任务的 Task 名共用这一份。
 * - 本月：本人本月的 Mission（不是占位的；不回退到上个月）下本人负责的 Task（本体没登记负责人的算本人的），了结了也列。
 * - 之前月份：本人在天枢里动过的（开过 Task 管线，或挂着子会话）、本人负责的、没了结的。它在哪个 Mission：卡和专题记着 mission_id；
 *   只有管线的，在本人最近 3 个月（本月以外）的 Mission 里找，更早的读不到就不列。本体读不到（超时、出错）的也不列。
 * chat：接了 Chat 服务时管线记在 task_pipelines；没接时是天枢自己 scope 为 plan-task:<id> 的对话。
 */
export async function treeTasks(q: Query, planTasks: PlanTaskSource, personId: string, now: Date, chat: boolean): Promise<{ period: string; missions: TreeMission[]; tasks: TreeTask[] }> {
  const period = companyPeriod(now);
  const current = (await q(`${MISSION_SELECT} WHERE owner_id=$1 AND period=$2 AND NOT placeholder ORDER BY code`, [personId, period])).rows as TreeMission[];
  const thisMonth = current.length
    ? (await readPlanTasks(planTasks, planTaskMissions(current))).filter((task) => !task.responsibleId || task.responsibleId === personId) : [];
  const shown = new Set(thisMonth.map((task) => task.taskId));

  // 动过的：挂着子会话（卡、专题），开过 Task 管线。
  const touched = ((await q(`SELECT plan_task_id AS task_id,mission_id FROM tasks
      WHERE owner_id=$1 AND plan_task_id IS NOT NULL AND status<>'returned' AND (role_id IS NOT NULL OR executor='claude_code')
    UNION SELECT plan_task_id,mission_id FROM research_topics WHERE owner_id=$1 AND plan_task_id IS NOT NULL AND status='active'
    UNION SELECT plan_task_id,NULL FROM task_pipelines WHERE owner_id=$1
    ${chat ? "" : `UNION SELECT substr(scope,11),NULL FROM conversations WHERE owner_id=$1 AND scope LIKE 'plan-task:%' AND deleted_at IS NULL AND archived_at IS NULL`}`,
  [personId])).rows as { task_id: string; mission_id: string | null }[]).filter((row) => !shown.has(row.task_id));
  let earlierMissions: TreeMission[] = [], earlier: PlanTask[] = [];
  if (touched.length) {
    const ids = new Set(touched.map((row) => row.task_id));
    const missionIds = [...new Set(touched.flatMap((row) => row.mission_id ? [row.mission_id] : []))];
    const pipelineOnly = [...ids].some((id) => !touched.some((row) => row.task_id === id && row.mission_id));
    earlierMissions = (await q(`${MISSION_SELECT} WHERE NOT placeholder AND period<$2 AND (id=ANY($3::text[]) OR ($4::text IS NOT NULL AND owner_id=$1 AND period>=$4))`,
      [personId, period, missionIds, pipelineOnly ? monthsBefore(period, 3) : null])).rows as TreeMission[];
    const owners = new Map(earlierMissions.map((mission) => [mission.id, mission.owner_id]));
    earlier = earlierMissions.length ? (await readPlanTasks(planTasks, planTaskMissions(earlierMissions))).filter((task) => ids.has(task.taskId)
      && (task.responsibleId ? task.responsibleId === personId : owners.get(task.missionId) === personId)) : [];
  }
  const completed = await completedTimes(q, [...thisMonth, ...earlier].map((task) => task.taskId));
  const periods = new Map([...current, ...earlierMissions].map((mission) => [mission.id, mission.period]));
  const withState = (task: PlanTask): TreeTask => ({ ...task, period: periods.get(task.missionId)!, completedAt: completed.get(task.taskId) ?? null });
  const tasks = [...thisMonth.map(withState), ...earlier.map(withState).filter((task) => !settled(task))];
  const listed = new Set(tasks.map((task) => task.missionId));
  // 本月的在前（按 code），之前的按月份从近到远、再按 code；之前月份的 Mission 只在有 Task 时列。
  const missions = [...current, ...earlierMissions.filter((mission) => listed.has(mission.id))
    .sort((a, b) => b.period.localeCompare(a.period) || a.code.localeCompare(b.code))];
  return { period, missions, tasks };
}

/** 本机报的合回结果（迁移 237 的 card_handbacks.merge，同一次交回存最新的一条）。 */
type StoredMerge = { merged: boolean; commit: string | null; baseBranch: string | null; reason: TCardMerge["reason"]; message: string | null; at: string };
/** 合回结果给界面：合进去了是 merged；没合是 needs_merge，带原因和给人看的话。 */
const cardMerge = (stored: StoredMerge): TCardMerge => ({ state: stored.merged ? "merged" : "needs_merge", commit: stored.commit ?? null,
  baseBranch: stored.baseBranch ?? null, reason: stored.merged ? null : stored.reason ?? null, message: stored.merged ? null : stored.message ?? null,
  at: new Date(stored.at).toISOString() });

/** 树和等你共用的子会话：外加挂的 Task、最近一次执行的时间、验收通过的时间（卡），以及交回那次执行在哪（等你合回用）。 */
export type HomeSub = TSubSession & { planTaskId: string | null; runUpdatedAt: string | null; acceptedAt: string | null;
  mergeRun: { sessionId: string | null; deviceId: string | null } | null };
type MeetingPending = { meetings: TMyMeetingCard[]; confirms: TMyMeetingConfirm[] };

export type WorkHomeDeps = {
  q: Query; planTasks: PlanTaskSource; now: Date; names: Map<string, string>;
  /** 接了 Chat 服务：Task 管线的对话 id 记在 task_pipelines；没接时是天枢自己 scope 为 plan-task:<taskId> 的对话。 */
  chat: boolean;
  /** 会议记录等我确认的（通知栏同一份，meetingCard.ts 的 pendingFor）。 */
  meetings: (personId: string) => Promise<MeetingPending>;
  /** 我看得到的 Mission Card 轮次（missionRounds.ts 的 listMissionRoundCards）。 */
  missionRounds: (person: MissionRoundPerson) => Promise<TCard[]>;
};

/** GET /api/me/work-home；伙伴的汇总（/internal/me/work-home）读同一份。 */
export async function readWorkHome(deps: WorkHomeDeps, person: MissionRoundPerson): Promise<TWorkHomeResponse> {
  const { q, now } = deps;
  const ownerId = person.personId;
  const { period, missions, tasks } = await treeTasks(q, deps.planTasks, ownerId, now, deps.chat);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
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
  // 不看月份、不看 Task 在不在树上，一律列（不在树上的进「其他」）。
  const cardRows = (await q(`SELECT id::text,acceptance->>'at' AS accepted_at FROM tasks WHERE owner_id=$1 AND status<>'returned' AND (role_id IS NOT NULL OR executor='claude_code')
      AND (status<>'done' OR plan_task_id=ANY($3::text[]) OR (plan_task_id IS NULL
        AND date_trunc('month',(acceptance->>'at')::timestamptz AT TIME ZONE 'Asia/Shanghai')=date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Shanghai'))
        OR (SELECT h.merge->>'merged' FROM card_handbacks h WHERE h.task_id=tasks.id AND h.status='done'
          AND (h.outcome='pass' AND h.overruled_at IS NULL OR h.outcome='fail' AND h.overruled_at IS NOT NULL) ORDER BY h.attempt DESC LIMIT 1)='false')
    ORDER BY created_at,id`, [ownerId, now, tasks.map((task) => task.taskId)])).rows as { id: string; accepted_at: string | null }[];
  const acceptedAt = new Map(cardRows.map((row) => [row.id, row.accepted_at]));
  const cards = await cardTaskViews(q, cardRows.map((row) => row.id), deps.names);
  // 合回：每张卡最近一次算通过的交回（推翻过的按本人的判断算）上本机报的合回结果，和交回那次执行在哪台电脑。
  const handbacks = cards.length ? (await q(`SELECT h.task_id::text,h.status,h.outcome,h.overruled_at,h.merge,h.run_id::text,r.device_id::text
    FROM card_handbacks h LEFT JOIN local_runs r ON r.id=h.run_id WHERE h.task_id=ANY($1::uuid[]) ORDER BY h.attempt DESC`, [cards.map((view) => view.id)])).rows as
    { task_id: string; status: HandbackRow["status"]; outcome: "pass" | "fail" | null; overruled_at: Date | null; merge: StoredMerge | null; run_id: string | null; device_id: string | null }[] : [];
  const passed = new Map<string, (typeof handbacks)[number]>();
  for (const row of handbacks) if (!passed.has(row.task_id) && row.status === "done" && effectiveOutcome(row) === "pass") passed.set(row.task_id, row);
  /** 连续两次验收没过（受阻、等你拿主意）；卡的标记 blocked 还包括执行连续两次异常退出，那种首页算已暂停。 */
  const reviewBlocked = (cardId: string) => failStreak(handbacks.filter((row) => row.task_id === cardId)) >= 2;

  const subs: HomeSub[] = [];
  for (const view of cards) {
    const { stage, wait, run, role } = view.card;
    const pass = passed.get(view.id);
    const merge = pass?.merge ? cardMerge(pass.merge) : null;
    const base = { id: view.id, kind: "card" as const, title: view.title, role, sessionId: run?.id ?? null, deviceId: run?.deviceId ?? null,
      autoStart: autoStart.has(view.id), updatedAt: latest(view.updatedAt, run?.updatedAt), planTaskId: view.planTaskId, runUpdatedAt: run?.updatedAt ?? null,
      merge, acceptedAt: stage === "done" ? acceptedAt.get(view.id) ?? null : null, mergeRun: pass ? { sessionId: pass.run_id, deviceId: pass.device_id } : null };
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
  const topics = (await q("SELECT id::text,title,role_id::text,plan_task_id,updated_at FROM research_topics WHERE owner_id=$1 AND status='active' ORDER BY created_at,id",
    [ownerId])).rows as { id: string; title: string; role_id: string | null; plan_task_id: string | null; updated_at: Date }[];
  const topicRuns = await latestRuns(q, "topic_id", topics.map((topic) => topic.id), "topic");
  const topicRoles = await rolesById(q, topics.map((topic) => topic.role_id));
  const TOPIC_STATES: Record<RunRow["state"], [TSubSessionState, TSubSession["waiting"]]> = { queued: ["queued", null], starting: ["running", null],
    running: ["running", null], waiting_permission: ["waiting", "approval"], idle: ["waiting", "question"], exited: ["waiting", null], failed: ["waiting", null],
    done: ["waiting", null] };
  for (const topic of topics) {
    const run = topicRuns.get(topic.id);
    const role = topic.role_id ? topicRoles.get(topic.role_id) : undefined;
    const base = { id: topic.id, kind: "topic" as const, title: topic.title, role: role ? roleRef(role) : null, sessionId: run?.id ?? null, deviceId: run?.device_id ?? null,
      autoStart: autoStart.has(topic.id), updatedAt: latest(topic.updated_at, run?.updated_at), planTaskId: topic.plan_task_id, runUpdatedAt: run?.updated_at.toISOString() ?? null,
      merge: null, acceptedAt: null, mergeRun: null };
    if (!run) { subs.push({ ...base, state: "queued", waiting: null, queueReason: notStarted(topic.id), holdUntil: null }); continue; }
    const queueReason = queuedBy({ id: run.id, deviceId: run.device_id, state: run.state });
    const [state, waiting] = queueReason ? ["queued" as const, null] : TOPIC_STATES[run.state];
    subs.push({ ...base, state, waiting, queueReason, holdUntil: holdUntil(queueReason, run.id) });
  }

  const order = (a: HomeSub, b: HomeSub) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.updatedAt.localeCompare(a.updatedAt);
  const view = ({ planTaskId: _task, runUpdatedAt: _at, acceptedAt: _accepted, mergeRun: _run, ...sub }: HomeSub): TSubSession => sub;
  const onTree = (sub: HomeSub) => sub.planTaskId !== null && taskById.has(sub.planTaskId);

  // 规划员在拆：本机的规划员会话还没结束，或登记了拆卡还没开。
  const planRuns = (await q("SELECT plan_task_id FROM local_runs WHERE owner_id=$1 AND kind='plan' AND state=ANY($2::text[])",
    [ownerId, [...ACTIVE]])).rows as { plan_task_id: string }[];
  const splits = (await q("SELECT plan_task_id FROM card_split_requests WHERE owner_id=$1 AND closed_at IS NULL", [ownerId])).rows as { plan_task_id: string }[];
  const planning = new Set([...planRuns.map((run) => run.plan_task_id), ...splits.map((row) => row.plan_task_id)]);
  const pipelines = new Map(tasks.length ? (deps.chat
    ? (await q("SELECT plan_task_id,conversation_id FROM task_pipelines WHERE owner_id=$1 AND plan_task_id=ANY($2::text[])", [ownerId, tasks.map((task) => task.taskId)])).rows
      .map((row) => [row.plan_task_id as string, row.conversation_id as string])
    : await Promise.all(tasks.map(async (task) => [task.taskId, ((await q(`SELECT id::text FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} ORDER BY created_at ASC,id ASC LIMIT 1`,
      [ownerId, `plan-task:${task.taskId}`])).rows[0]?.id as string | undefined) ?? null] as const))) : []);

  // 自己做的执行事项（设计 9.10）：没有岗位、不交给 Agent 的，挂在树上的 Task 下（退回的不列）；没挂 Mission 的进「其他」。
  const homeItem = (item: TCardTaskView): THomeItem => ({ id: item.id, title: item.title, status: item.status as THomeItem["status"], dueDate: item.dueDate,
    awaitingAcceptance: item.awaitingAcceptance, updatedAt: item.updatedAt });
  const ownItems = tasks.length ? await getTaskViews(q, ((await q(`SELECT id::text FROM tasks WHERE owner_id=$1 AND plan_task_id=ANY($2::text[]) AND status<>'returned'
      AND role_id IS NULL AND executor IS DISTINCT FROM 'claude_code' ORDER BY created_at,id`, [ownerId, tasks.map((task) => task.taskId)])).rows as { id: string }[])
    .map((row) => row.id), deps.names) : [];
  // 「其他」里的事项（9.10）：没挂 Mission、没完成没退回的，会议或 Agent 分派来待归位的，和本人自己建的独立事项，新的在前。
  const loose = await getTaskViews(q, ((await q(`SELECT id::text FROM tasks WHERE owner_id=$1 AND mission_id IS NULL AND status NOT IN ('done','returned')
      AND role_id IS NULL AND executor IS DISTINCT FROM 'claude_code' ORDER BY created_at DESC,id`, [ownerId])).rows as { id: string }[]).map((row) => row.id), deps.names);

  const waiting = await assembleWaiting({ q, person, deps, period, subs, cards, taskById, devices, openSplits: splits.length });
  const today = shanghaiDate(now);
  const homeTask = (task: TreeTask): THomeTask => {
    const mine = subs.filter((sub) => sub.planTaskId === task.taskId).sort(order);
    const count = (...states: TSubSessionState[]) => mine.filter((sub) => states.includes(sub.state)).length;
    return { taskId: task.taskId, missionId: task.missionId, name: task.name,
      subtitle: task.doneDefinition?.trim() || task.criteria[0]?.trim() || null,
      summary: { running: count("running"), waiting: count("waiting", "failed"), queued: count("queued"), done: count("done"),
        doneToday: mine.filter((sub) => sub.acceptedAt && shanghaiDate(new Date(sub.acceptedAt)) === today).length,
        needsYou: waiting.filter((item) => item.taskId === task.taskId).length },
      pipeline: { conversationId: pipelines.get(task.taskId) ?? null, scope: `plan-task:${task.taskId}` },
      planning: planning.has(task.taskId), completedAt: task.completedAt, subSessions: mine.map(view),
      items: ownItems.filter((item) => item.planTaskId === task.taskId).map(homeItem) };
  };
  const homeMissions: THomeMission[] = missions.map((mission) => ({ missionId: mission.id, title: mission.title, period: mission.period,
    tasks: tasks.filter((task) => task.missionId === mission.id).map(homeTask) }));

  // 其他：不挂 Task 的，和挂在不在树上的 Task 下、还没完成的（已完成的在取卡时就没取，等你合的除外）。
  return { period, missions: homeMissions, other: { subSessions: subs.filter((sub) => !onTree(sub)).sort(order).map(view), items: loose.map(homeItem) }, waiting };
}

/**
 * scope：main 全部；task:<id> 这件 Task 的规划员和它下面各卡、专题会话里的；card:<id>、topic:<id> 这张卡（含它的验收员）、这个专题会话里的；
 * resources 只要资源块（二级页、月份页）。
 */
type Scope = { kind: "main" | "resources" } | { kind: "task" | "card" | "topic"; id: string };
const parseScope = (scope: string): Scope => scope === "main" || scope === "resources" ? { kind: scope }
  : { kind: scope.slice(0, scope.indexOf(":")) as "task" | "card" | "topic", id: scope.slice(scope.indexOf(":") + 1) };

/** GET /api/me/background?scope=…：卡、专题不是本人的 404。 */
export async function readBackground(deps: { q: Query; now: Date; planTasks: PlanTaskSource; chat: boolean }, ownerId: string, rawScope: string): Promise<TBackgroundResponse> {
  const { q, now } = deps;
  const scope = parseScope(rawScope);
  if (scope.kind === "resources") return { items: [], resources: await workerResources(q, ownerId, now) };
  if (scope.kind === "card" || scope.kind === "topic") {
    const table = scope.kind === "card" ? "tasks" : "research_topics";
    // 契约只限了字符和长度，不是 UUID 的先挡掉（id 是 uuid 列，直接查会报错）。
    if (!UUID_PATTERN.test(scope.id) || !(await q(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_id=$2`, [scope.id, ownerId])).rows.length)
      throw new CardError(404, "NOT_FOUND", scope.kind === "card" ? "找不到这张卡" : "找不到这个专题");
  }
  /** 一项挂在哪：Task（规划员拆的、卡或专题挂的）、卡、专题。 */
  const inScope = (at: { taskId: string | null; cardId: string | null; topicId: string | null }) => !("id" in scope)
    || (scope.kind === "task" ? at.taskId === scope.id : scope.kind === "card" ? at.cardId === scope.id : at.topicId === scope.id);
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
    ? new Map((await treeTasks(q, deps.planTasks, ownerId, now, deps.chat)).tasks.map((task) => [task.taskId, task.name])) : new Map<string, string>();
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
