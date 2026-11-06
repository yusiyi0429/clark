import type { TBackgroundItem, TBackgroundResponse, TBackgroundState, TCard, THomeMission, THomeTask, TMissionRoundSummary, TMyMeetingCard, TMyMeetingConfirm,
  TSubSession, TSubSessionState, TWaitingItem, TWorkerQueueReason, TWorkHomeResponse } from "@warmap/contracts";
import { ACTIVE_CONVERSATION_WHERE } from "./conversations.js";
import { ownMissions, planTaskMissions, type MissionRow } from "./homePlan.js";
import { latestRuns, type RunRow } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { readPlanTasks, type PlanTask, type PlanTaskSource } from "./planTasks.js";
import { listProposals, roleRef, rolesById } from "./roles.js";
import type { MissionRoundPerson } from "./missionRounds.js";
import { CardError, cardTaskViews } from "./taskCards.js";
import { ACTIVE, workerResources } from "./workers.js";

/**
 * 新首页（契约 workHome.ts，设计《新首页_伙伴总管线与Task管线》第 2、4、7 节）：左栏的树（Mission → 本人负责的 Task → 子会话）、「等你」、右栏的后台任务。
 * 子会话的状态和 worker 列表（workers.ts）同一套判断：设备 10 分钟内上报过算在线，本机的会话还在但电脑不在线算等本机上线，本机报 queued 算等空位。
 */

const SHANGHAI_DAY = (column: string, param: string) =>
  `(${column} AT TIME ZONE 'Asia/Shanghai')::date=(${param}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`;
/** 树上同一格里的先后：等你、没过、进行中、已排队、已完成。 */
const STATE_ORDER: TSubSessionState[] = ["waiting", "failed", "running", "queued", "done"];
const latest = (...times: (string | Date | null | undefined)[]) =>
  new Date(Math.max(...times.filter((time): time is string | Date => Boolean(time)).map((time) => new Date(time).getTime()))).toISOString();

/** 本人这个月（没有时回退到最近一个月，同本月页）的 Mission，和其中本人负责的 Task（本体没登记负责人的算本人的）。树和「自动」发给谁共用。 */
export async function ownPlanTasks(q: Query, planTasks: PlanTaskSource, personId: string, now: Date): Promise<{ missions: MissionRow[]; tasks: PlanTask[] }> {
  const missions = (await ownMissions(q, personId, companyPeriod(now))).rows;
  const tasks = missions.length ? await readPlanTasks(planTasks, planTaskMissions(missions)) : [];
  return { missions, tasks: tasks.filter((task) => !task.responsibleId || task.responsibleId === personId) };
}

type Sub = TSubSession & { planTaskId: string | null; runUpdatedAt: string | null };
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

/** GET /api/me/work-home */
export async function readWorkHome(deps: WorkHomeDeps, person: MissionRoundPerson): Promise<TWorkHomeResponse> {
  const { q, now } = deps;
  const ownerId = person.personId;
  const { missions, tasks } = await ownPlanTasks(q, deps.planTasks, ownerId, now);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const online = new Set((await workerResources(q, ownerId, now)).devices.filter((device) => device.online).map((device) => device.id));
  const starts = (await q("SELECT card_id::text,topic_id::text FROM session_starts WHERE owner_id=$1 AND closed_at IS NULL", [ownerId])).rows as
    { card_id: string | null; topic_id: string | null }[];
  const autoStart = new Set(starts.map((row) => (row.card_id ?? row.topic_id)!));
  /** 还没开过的：登记了要开工、本人又没有在线的电脑，是等本机上线；别的是等开工。 */
  const notStarted = (id: string): TWorkerQueueReason => autoStart.has(id) && !online.size ? "device_offline" : "not_dispatched";
  const priorWaits = new Set(((await q("SELECT id::text FROM local_runs WHERE owner_id=$1 AND state='queued' AND waiting_for IS NOT NULL", [ownerId])).rows as
    { id: string }[]).map((row) => row.id));
  /** 本机的会话还在、那台电脑不在线：等本机上线；本机报 queued：等空位（在等前面的卡时是等前面的卡）。都不是为 null。 */
  const queuedBy = (run: { id: string; deviceId: string; state: string }): TWorkerQueueReason | null =>
    ACTIVE.has(run.state) && !online.has(run.deviceId) ? "device_offline" : run.state === "queued" ? priorWaits.has(run.id) ? "prior_cards" : "slot" : null;

  // 卡：带岗位或交给 Claude Code 的、没退回的；完成的只要这个月（公司时区）完成的。
  const cardRows = (await q(`SELECT id::text FROM tasks WHERE owner_id=$1 AND status<>'returned' AND (role_id IS NOT NULL OR executor='claude_code')
      AND (status<>'done' OR date_trunc('month',(acceptance->>'at')::timestamptz AT TIME ZONE 'Asia/Shanghai')=date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Shanghai'))
    ORDER BY created_at,id`, [ownerId, now])).rows as { id: string }[];
  const cards = await cardTaskViews(q, cardRows.map((row) => row.id), deps.names);
  const subs: Sub[] = [];
  for (const view of cards) {
    const { stage, wait, run, role } = view.card;
    const base = { id: view.id, kind: "card" as const, title: view.title, role, sessionId: run?.id ?? null, deviceId: run?.deviceId ?? null,
      autoStart: autoStart.has(view.id), updatedAt: latest(view.updatedAt, run?.updatedAt), planTaskId: view.planTaskId, runUpdatedAt: run?.updatedAt ?? null };
    let state: TSubSessionState = "running", waiting: TSubSession["waiting"] = null, queueReason: TWorkerQueueReason | null = null;
    if (stage === "done") state = "done";
    else if (stage === "review") state = "running";
    else if (stage === "todo") {
      // 还没开工；本机收下了在等空位、等前面的卡时照本机报的。
      state = "queued";
      queueReason = run ? queuedBy(run) ?? notStarted(view.id) : notStarted(view.id);
    } else if (run && (queueReason = queuedBy(run))) state = "queued";
    else if (wait === "blocked") [state, waiting] = ["waiting", "verdict"];
    else if (wait === "review_failed") state = "failed";
    else if (wait === "approval") [state, waiting] = ["waiting", "approval"];
    else if (wait === "reply") [state, waiting] = ["waiting", "question"];
    else if (wait === "paused") state = "waiting";
    subs.push({ ...base, state, waiting, queueReason });
  }

  // 专题：没归档的都列；最近一次本机执行定状态。
  const topics = (await q("SELECT id::text,title,role_id::text,plan_task_id,updated_at FROM research_topics WHERE owner_id=$1 AND status='active' ORDER BY created_at,id",
    [ownerId])).rows as { id: string; title: string; role_id: string | null; plan_task_id: string | null; updated_at: Date }[];
  const topicRuns = await latestRuns(q, "topic_id", topics.map((topic) => topic.id), "topic");
  const topicRoles = await rolesById(q, topics.map((topic) => topic.role_id));
  const TOPIC_STATES: Record<RunRow["state"], [TSubSessionState, TSubSession["waiting"]]> = { queued: ["queued", null], starting: ["running", null],
    running: ["running", null], waiting_permission: ["waiting", "approval"], idle: ["waiting", "question"], exited: ["done", null], failed: ["waiting", null] };
  for (const topic of topics) {
    const run = topicRuns.get(topic.id);
    const role = topic.role_id ? topicRoles.get(topic.role_id) : undefined;
    const base = { id: topic.id, kind: "topic" as const, title: topic.title, role: role ? roleRef(role) : null, sessionId: run?.id ?? null, deviceId: run?.device_id ?? null,
      autoStart: autoStart.has(topic.id), updatedAt: latest(topic.updated_at, run?.updated_at), planTaskId: topic.plan_task_id, runUpdatedAt: run?.updated_at.toISOString() ?? null };
    if (!run) { subs.push({ ...base, state: "queued", waiting: null, queueReason: notStarted(topic.id) }); continue; }
    const queueReason = queuedBy({ id: run.id, deviceId: run.device_id, state: run.state });
    const [state, waiting] = queueReason ? ["queued" as const, null] : TOPIC_STATES[run.state];
    subs.push({ ...base, state, waiting, queueReason });
  }

  const order = (a: Sub, b: Sub) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.updatedAt.localeCompare(a.updatedAt);
  const view = ({ planTaskId: _task, runUpdatedAt: _at, ...sub }: Sub): TSubSession => sub;
  const onTree = (sub: Sub) => sub.planTaskId !== null && taskById.has(sub.planTaskId);

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

  const homeTask = (task: PlanTask): THomeTask => {
    const mine = subs.filter((sub) => sub.planTaskId === task.taskId).sort(order);
    const count = (...states: TSubSessionState[]) => mine.filter((sub) => states.includes(sub.state)).length;
    return { taskId: task.taskId, missionId: task.missionId, name: task.name,
      subtitle: task.doneDefinition?.trim() || task.criteria[0]?.trim() || null,
      summary: { running: count("running"), waiting: count("waiting", "failed"), queued: count("queued"), done: count("done") },
      pipeline: { conversationId: pipelines.get(task.taskId) ?? null, scope: `plan-task:${task.taskId}` },
      planning: planning.has(task.taskId), subSessions: mine.map(view) };
  };
  const homeMissions: THomeMission[] = missions.map((mission) => ({ missionId: mission.id, title: mission.title,
    tasks: tasks.filter((task) => task.missionId === mission.id).map(homeTask) }));

  // 等你。
  const taskName = (id: string | null) => id ? taskById.get(id)?.name ?? null : null;
  const waiting: TWaitingItem[] = [];
  for (const sub of subs) {
    const treeTask = onTree(sub) ? sub.planTaskId : null;
    const at = { taskId: treeTask, open: { kind: sub.kind, id: sub.id } };
    if (sub.waiting === "approval" || sub.waiting === "question")
      waiting.push({ id: `${sub.waiting}:${sub.kind}:${sub.id}`, kind: sub.waiting, title: sub.waiting === "approval" ? "等你批准" : "等你回复",
        source: [sub.title, taskName(treeTask)].filter(Boolean).join(" · "), at: sub.runUpdatedAt, ...at, sessionId: sub.sessionId, deviceId: sub.deviceId });
  }
  for (const view of cards) if (view.card.wait === "blocked") {
    const treeTask = view.planTaskId && taskById.has(view.planTaskId) ? view.planTaskId : null;
    waiting.push({ id: `verdict:card:${view.id}`, kind: "verdict", title: "验收两次没过", source: [view.title, taskName(treeTask)].filter(Boolean).join(" · "),
      at: view.card.handback?.createdAt ?? null, open: { kind: "card", id: view.id }, taskId: treeTask, sessionId: null, deviceId: null });
  }
  // 规划员、验收员在等批准、等回复。
  const helpers = (await q(`SELECT r.id::text,r.kind,r.state,r.device_id::text,r.plan_task_id,r.task_id::text,r.title,r.updated_at,t.title AS card_title,t.plan_task_id AS card_task
    FROM local_runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.owner_id=$1 AND r.kind IN ('plan','verify') AND r.state IN ('waiting_permission','idle')`, [ownerId])).rows as
    { id: string; kind: "plan" | "verify"; state: string; device_id: string; plan_task_id: string | null; task_id: string | null; title: string | null; updated_at: Date;
      card_title: string | null; card_task: string | null }[];
  for (const run of helpers) {
    const kind = run.state === "waiting_permission" ? "approval" as const : "question" as const;
    const plan = run.kind === "plan";
    const taskId = plan ? run.plan_task_id : run.card_task;
    waiting.push({ id: `${kind}:${run.kind}:${run.id}`, kind, title: kind === "approval" ? "等你批准" : "等你回复",
      source: plan ? `拆卡 · ${taskName(run.plan_task_id) ?? run.title ?? run.plan_task_id}` : `验收 · ${run.card_title ?? ""}`, at: run.updated_at.toISOString(),
      open: plan ? { kind: "task", id: run.plan_task_id! } : { kind: "card", id: run.task_id! }, taskId: taskId && taskById.has(taskId) ? taskId : null,
      sessionId: run.id, deviceId: run.device_id });
  }
  // 会议记录：一场会一行。
  const pending = await deps.meetings(ownerId);
  const meetings = new Map<string, { title: string; confirms: number; failed: boolean; endedAt: string | null }>();
  for (const confirm of pending.confirms) {
    const entry = meetings.get(confirm.meetingId) ?? { title: confirm.title, confirms: 0, failed: false, endedAt: null };
    meetings.set(confirm.meetingId, { ...entry, confirms: entry.confirms + 1 });
  }
  for (const card of pending.meetings) {
    const entry = meetings.get(card.meetingId) ?? { title: card.title, confirms: 0, failed: false, endedAt: null };
    meetings.set(card.meetingId, { ...entry, failed: card.status === "failed" || entry.failed, endedAt: card.endedAt });
  }
  for (const [meetingId, entry] of meetings) waiting.push({ id: `meeting:${meetingId}`, kind: "meeting", title: entry.title,
    source: [entry.confirms ? `${entry.confirms} 条待你确认` : null, entry.failed ? "会议记录没生成" : null].filter(Boolean).join(" · "),
    at: entry.endedAt, open: { kind: "meeting", id: meetingId }, taskId: null, sessionId: null, deviceId: null });
  // Mission Card：本人确认我的任务（轮次在本人确认阶段、我那张还没确认），拍板人那一侧的待办。
  for (const card of await deps.missionRounds(person)) {
    const round = card.payload as TMissionRoundSummary;
    const source = `${round.battlefieldName} · ${Number(round.period.slice(5))} 月 Mission Card`;
    const item = { kind: "mission_card" as const, source, at: round.openedAt, taskId: null, sessionId: null, deviceId: null };
    const mine = round.cards.find((entry) => entry.mine);
    if (round.phase === "open" && mine && !mine.ownerConfirmedAt)
      waiting.push({ ...item, id: `mission_card:${mine.cardId}`, title: "确认我的任务", open: { kind: "mission_card", id: mine.cardId } });
    if (round.approver && round.todo)
      waiting.push({ ...item, id: `mission_round:${round.roundId}`, title: round.todo, open: { kind: "mission_card", id: round.roundId, round: true } });
  }
  // 岗位修改建议。
  const FIELD_TEXT = { dutiesMd: "职责", practiceMd: "做法", acceptanceMd: "验收口径" } as const;
  for (const proposal of await listProposals(q, ownerId, "open")) {
    const card = cards.find((view) => view.id === proposal.card.id);
    const taskId = card?.planTaskId && taskById.has(card.planTaskId) ? card.planTaskId : null;
    waiting.push({ id: `role:${proposal.id}`, kind: "role", title: `${proposal.role.name}：建议改${FIELD_TEXT[proposal.field]}`, source: proposal.card.title,
      at: proposal.createdAt, open: { kind: "role", id: proposal.id }, taskId, sessionId: null, deviceId: null });
  }
  waiting.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return { missions: homeMissions, other: { subSessions: subs.filter((sub) => !onTree(sub)).sort(order).map(view) }, waiting };
}

/** scope：main 全部；task:<id> 这件 Task 的规划员和它下面各卡、专题会话里的；card:<id>、topic:<id> 这张卡（含它的验收员）、这个专题会话里的。 */
type Scope = { kind: "main" } | { kind: "task" | "card" | "topic"; id: string };
const parseScope = (scope: string): Scope => scope === "main" ? { kind: "main" }
  : { kind: scope.slice(0, scope.indexOf(":")) as "task" | "card" | "topic", id: scope.slice(scope.indexOf(":") + 1) };

/** GET /api/me/background?scope=…：卡、专题不是本人的 404。 */
export async function readBackground(deps: { q: Query; now: Date; planTasks: PlanTaskSource }, ownerId: string, rawScope: string): Promise<TBackgroundResponse> {
  const { q, now } = deps;
  const scope = parseScope(rawScope);
  if (scope.kind === "card" || scope.kind === "topic") {
    const table = scope.kind === "card" ? "tasks" : "research_topics";
    if (!(await q(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_id=$2`, [scope.id, ownerId])).rows.length)
      throw new CardError(404, "NOT_FOUND", scope.kind === "card" ? "找不到这张卡" : "找不到这个专题");
  }
  /** 一项挂在哪：Task（规划员拆的、卡或专题挂的）、卡、专题。 */
  const inScope = (at: { taskId: string | null; cardId: string | null; topicId: string | null }) => scope.kind === "main"
    || (scope.kind === "task" ? at.taskId === scope.id : scope.kind === "card" ? at.cardId === scope.id : at.topicId === scope.id);
  const items: TBackgroundItem[] = [];

  // 规划员、验收员：还在的，和今天结束的。
  const runs = (await q(`SELECT r.id::text,r.kind,r.state,r.title,r.device_id::text,r.task_id::text,r.plan_task_id,r.started_at,r.ended_at,t.title AS card_title,t.plan_task_id AS card_task,
      CASE WHEN r.kind='plan' THEN EXISTS (SELECT 1 FROM card_plans p WHERE p.run_id=r.id) ELSE EXISTS (SELECT 1 FROM card_handbacks h WHERE h.verify_run_id=r.id) END AS delivered
    FROM local_runs r LEFT JOIN tasks t ON t.id=r.task_id
    WHERE r.owner_id=$1 AND r.kind IN ('plan','verify') AND (r.state=ANY($2::text[]) OR ${SHANGHAI_DAY("r.ended_at", "$3")})`, [ownerId, [...ACTIVE], now])).rows as
    { id: string; kind: "plan" | "verify"; state: string; title: string | null; device_id: string; task_id: string | null; plan_task_id: string | null; started_at: Date;
      ended_at: Date | null; card_title: string | null; card_task: string | null; delivered: boolean }[];
  const planTaskIds = runs.some((run) => run.kind === "plan")
    ? new Map((await ownPlanTasks(q, deps.planTasks, ownerId, now)).tasks.map((task) => [task.taskId, task.name])) : new Map<string, string>();
  for (const run of runs) {
    const plan = run.kind === "plan";
    const at = plan ? { taskId: run.plan_task_id, cardId: null, topicId: null } : { taskId: run.card_task, cardId: run.task_id, topicId: null };
    if (!inScope(at)) continue;
    // 会话退出了：交了派活单（规划员）、交了结论（验收员）算完成，没交算被停了。
    const state: TBackgroundState = run.state === "queued" ? "queued" : ACTIVE.has(run.state) ? "running" : run.state === "failed" ? "failed" : run.delivered ? "done" : "stopped";
    const title = plan ? `拆卡：${planTaskIds.get(run.plan_task_id!) ?? run.title ?? run.plan_task_id}` : run.title ?? `验收：${run.card_title ?? ""}`;
    items.push({ id: `${run.kind}:${run.id}`, title, kind: run.kind, state, startedAt: run.started_at.toISOString(), finishedAt: ACTIVE.has(run.state) ? null : run.ended_at?.toISOString() ?? null,
      stoppable: ACTIVE.has(run.state), sessionId: run.id, itemId: null, deviceId: run.device_id, ...at });
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
      sessionId: row.run_id, itemId: row.item_id, deviceId: row.device_id, ...at });
  }

  // 没结束的按开始时间在前，结束的按结束时间新的在前。
  const open = (item: TBackgroundItem) => item.state === "queued" || item.state === "running";
  items.sort((a, b) => Number(open(b)) - Number(open(a))
    || (open(a) ? (a.startedAt ?? "").localeCompare(b.startedAt ?? "") : (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")));
  return { items, resources: await workerResources(q, ownerId, now) };
}
