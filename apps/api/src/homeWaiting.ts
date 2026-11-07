import type { TCardTaskView, TMissionRoundSummary, TWaitingItem, TWorkerResources } from "@warmap/contracts";
import { HOLD_STATES } from "./cardProjection.js";
import { FEISHU_NOTIFY_KIND } from "./feishu/notify.js";
import type { Query } from "./meetingStore.js";
import type { MissionRoundPerson } from "./missionRounds.js";
import { monthReviewAnswered } from "./monthPage.js";
import { listProposals } from "./roles.js";
import { CARD_PROJECT } from "./projects.js";
import { openPlanTask, parseNotifyKey } from "./taskAgreements.js";
import { DeliverableError } from "./taskDeliverables.js";
import { awaitsQuota } from "./workers.js";
import { shanghaiDate, shanghaiLabel } from "./workdays.js";
import type { HomeSub, TreeTask, WorkHomeDeps } from "./workHome.js";
import type { RunAsk } from "./localDevices.js";

/**
 * 首页的「等你」（契约 WaitingItem，设计 9.6）：要本人拿主意、不拿就有事卡住的，才进来。
 * 子会话、规划员、验收员在等批准或回复，受阻的卡，没能自动合回的卡，计划等你开工，会议要确认的，Mission Card 要做的，请你认可，岗位修改建议，
 * 月份（复盘、之前月份还有没了结的），电脑不在线而有活在等本机，订阅额度用完有活停着。
 */

/** 本机报了订阅额度用完（hold.reason = usage_limit）的会话（别名 r 指 local_runs）：不论还算不算等额度恢复（workers.ts 的 awaitsQuota），都不是等你回复。等预算、等余额的不在这里。 */
export const HELD = `(COALESCE(r.hold->>'reason','')='usage_limit' AND r.state=ANY('{${HOLD_STATES.join(",")}}'::text[]))`;
/** 「请 X 看」多久以内的还算在等你认可。 */
const ACCEPTANCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
/** 卡住正在跑的活的几种，排在最前（设计 9.6）。 */
const BLOCKING = new Set<TWaitingItem["kind"]>(["approval", "question", "quota"]);

export type WaitingInput = {
  q: Query; person: MissionRoundPerson;
  deps: Pick<WorkHomeDeps, "meetings" | "missionRounds" | "planTasks" | "now" | "names">;
  /** 现在是哪个月（公司时区）。 */
  period: string;
  /** 树和「其他」里的子会话，卡的投影，树上的 Task（带月份）。 */
  subs: HomeSub[]; cards: TCardTaskView[]; taskById: Map<string, TreeTask>;
  /** 一件 Task 挂在哪个项目（没挂为 null）；本人项目的名字（含归档的）。 */
  taskProject: (taskId: string | null) => string | null; projectNames: Map<string, string>;
  /** 本人没吊销的电脑（在不在线照 workers.ts）；没关的拆卡登记几条（等本机开规划员）。 */
  devices: TWorkerResources["devices"]; openSplits: number;
};

/**
 * 复盘窗口（设计 10.4，和 M2 一样）：每月最后 2 天起，到下个月 7 号 23:59（公司时区）。
 * 在窗口里返回说的是哪个月（刚结束或快结束的那个月）和窗口关闭的时间；不在窗口里为 null。
 */
export function reviewWindow(now: Date): { period: string; closesAt: string } | null {
  const [year, month, day] = shanghaiDate(now).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // 月份从 0 数：本月是 month - 1，上个月是 month - 2。
  const index = day >= lastDay - 1 ? month - 1 : day <= 7 ? month - 2 : null;
  if (index === null) return null;
  const start = new Date(Date.UTC(year, index, 1));
  // 下个月 7 号 23:59:59（公司时区比 UTC 早 8 小时）。
  const closesAt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 7, 15, 59, 59));
  return { period: start.toISOString().slice(0, 7), closesAt: closesAt.toISOString() };
}

/** 管线里那个框是哪一次提问或批准（老版本本机程序没报时为 null）。 */
const askRequestId = (ask: RunAsk | null) => ask?.request.requestId ?? null;

/** 等你那一行的原话和就地答要的东西：在问的用第一个问题的原话，等批准的用那一步给人看的那一行；老版本本机程序没报时退回泛称。 */
function askFields(kind: "approval" | "question", ask: RunAsk | null): Pick<TWaitingItem, "title" | "question" | "permission"> {
  if (kind === "question") return ask?.kind === "question" ? { title: ask.request.questions[0].question, question: ask.request, permission: null }
    : { title: "等你回复", question: null, permission: null };
  return ask?.kind === "permission" && ask.request.title ? { title: ask.request.title, question: null, permission: ask.request }
    : { title: "等你批准", question: null, permission: ask?.kind === "permission" ? ask.request : null };
}

/**
 * 排序（设计 9.6）：先是卡住正在跑的活的（批准、回答、额度），再是有截止时间的，其余在后；
 * 每一组里截止早的在前（没有截止的在有截止的后面），再按 at 新的在前（没有 at 的最后）。
 */
function byUrgency(a: TWaitingItem, b: TWaitingItem): number {
  const group = (item: TWaitingItem) => BLOCKING.has(item.kind) ? 0 : item.dueAt ? 1 : 2;
  return group(a) - group(b)
    || (a.dueAt && b.dueAt ? a.dueAt.localeCompare(b.dueAt) : Number(!a.dueAt) - Number(!b.dueAt))
    || (b.at ?? "").localeCompare(a.at ?? "")
    || a.id.localeCompare(b.id);
}

/** 等你：一件一行，id 稳定。taskId 只填树上的 Task；projectId 是在哪个项目（项目行的「N 件等你」按它数），没写的按 taskId 挂的项目补。 */
export async function assembleWaiting(input: WaitingInput): Promise<TWaitingItem[]> {
  const { q, person, deps, subs, cards, taskById, taskProject, projectNames } = input;
  const ownerId = person.personId;
  const deviceNames = new Map(((await q("SELECT id::text,name FROM local_devices WHERE owner_id=$1", [ownerId])).rows as { id: string; name: string }[])
    .map((row) => [row.id, row.name]));
  const treeTask = (id: string | null) => id && taskById.has(id) ? id : null;
  const taskName = (id: string | null) => id ? taskById.get(id)?.name ?? null : null;
  const projectName = (id: string | null) => id ? projectNames.get(id) ?? null : null;
  const waiting: TWaitingItem[] = [];
  /** 没写的几样取默认：不属于 Task、没有本机会话、没有截止、不是别人请你、不是月份。设备名照 deviceId 取。 */
  const add = (item: Pick<TWaitingItem, "id" | "kind" | "title" | "source" | "at" | "open" | "answer"> & Partial<TWaitingItem>) => waiting.push({ taskId: null,
    sessionId: null, deviceId: null, dueAt: null, person: null, month: null, question: null, permission: null, ...item,
    projectId: item.projectId ?? taskProject(item.taskId ?? null), deviceName: item.deviceId ? deviceNames.get(item.deviceId) ?? null : null });

  for (const sub of subs) {
    const taskId = treeTask(sub.planTaskId);
    const source = [sub.title, taskName(taskId)].filter(Boolean).join(" · ");
    // 提问和批准由项目对话转达（14.3）：点进去落在项目对话里那个框上，来源只写项目名；不在项目里的照旧打开子会话。
    if (sub.waiting === "approval" || sub.waiting === "question")
      add({ id: `${sub.waiting}:${sub.kind}:${sub.id}`, kind: sub.waiting, ...askFields(sub.waiting, sub.ask), source: projectName(sub.projectId) ?? sub.title, at: sub.runUpdatedAt,
        open: sub.projectId && sub.sessionId ? { kind: "project", id: sub.projectId, focus: { sessionId: sub.sessionId, requestId: askRequestId(sub.ask) } }
          : { kind: sub.kind, id: sub.id },
        taskId, projectId: sub.projectId, sessionId: sub.sessionId, deviceId: sub.deviceId, answer: "inline_local" });
    // 验收过了、没能自动合回：在交回那次执行的那台电脑上合。
    if (sub.waiting === "merge" && sub.merge)
      add({ id: `merge:card:${sub.id}`, kind: "merge", title: "没能自动合回", source, at: sub.merge.at, open: { kind: "card", id: sub.id }, taskId, projectId: sub.projectId,
        sessionId: sub.mergeRun?.sessionId ?? null, deviceId: sub.mergeRun?.deviceId ?? null, answer: "inline_local" });
  }
  // 受阻只算连续两次验收没过（子会话 waiting = verdict）；执行连续两次异常退出是已暂停，不在这里。
  for (const view of cards) {
    const sub = subs.find((entry) => entry.id === view.id && entry.waiting === "verdict");
    if (!sub) continue;
    const taskId = treeTask(view.planTaskId);
    add({ id: `verdict:card:${view.id}`, kind: "verdict", title: "验收两次没过", source: [view.title, taskName(taskId)].filter(Boolean).join(" · "),
      at: view.card.handback?.createdAt ?? null, open: { kind: "card", id: view.id }, taskId, projectId: sub.projectId, answer: "open" });
  }
  // 规划员、验收员在等批准、等回复（停着等额度恢复的不算）。
  // 只算真在问（idle 带提问）和在等批准的；一轮做完停下的不算（9.6）。
  const helpers = (await q(`SELECT r.id::text,r.kind,r.state,r.device_id::text,r.plan_task_id,r.task_id::text,r.title,r.updated_at,r.ask,t.title AS card_title,
      t.plan_task_id AS card_task,CASE WHEN t.id IS NOT NULL THEN ${CARD_PROJECT("t")}::text END AS card_project
    FROM local_runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.owner_id=$1 AND r.kind IN ('plan','verify')
      AND (r.state='waiting_permission' OR r.state='idle' AND r.ask->>'kind'='question') AND NOT ${HELD}`,
  [ownerId])).rows as { id: string; kind: "plan" | "verify"; state: string; device_id: string; plan_task_id: string | null; task_id: string | null; title: string | null;
    updated_at: Date; ask: RunAsk | null; card_title: string | null; card_task: string | null; card_project: string | null }[];
  for (const run of helpers) {
    const kind = run.state === "waiting_permission" ? "approval" as const : "question" as const;
    const plan = run.kind === "plan";
    // 规划员挂在 Task 上（在 Task 挂的项目里）；验收员挂在卡上（在卡所在的项目里）。都由项目对话转达（14.3），来源只写项目名。
    const taskId = treeTask(plan ? run.plan_task_id : run.card_task);
    const projectId = plan ? taskProject(run.plan_task_id) : run.card_project;
    add({ id: `${kind}:${run.kind}:${run.id}`, kind, ...askFields(kind, run.ask),
      source: projectName(projectId) ?? taskName(run.plan_task_id) ?? (plan ? run.title ?? run.plan_task_id : run.card_title), at: run.updated_at.toISOString(),
      open: projectId ? { kind: "project", id: projectId, focus: { sessionId: run.id, requestId: askRequestId(run.ask) } }
        : plan ? { kind: "task_detail", id: run.plan_task_id! } : { kind: "card", id: run.task_id! },
      taskId, projectId, sessionId: run.id, deviceId: run.device_id, answer: "inline_local" });
  }

  // 订阅额度用完：一台在线的电脑一条，停着几件（子会话按树上的状态，规划员、验收员按会话），截止是最早恢复的时间（到点本机自己接着做）。
  // 恢复时间过了的不算；电脑不在线的本机接不着做，算进下面「电脑不在线」那条。
  const online = new Set(input.devices.filter((device) => device.online).map((device) => device.id));
  const heldHelpers = (await q(`SELECT r.device_id::text,r.hold->>'until' AS until FROM local_runs r WHERE r.owner_id=$1 AND r.kind IN ('plan','verify') AND ${HELD}`,
    [ownerId])).rows as { device_id: string; until: string | null }[];
  const holds = new Map<string, (string | null)[]>();
  for (const [deviceId, until] of [...subs.filter((sub) => sub.queueReason === "quota" && sub.deviceId).map((sub) => [sub.deviceId!, sub.holdUntil] as const),
    ...heldHelpers.filter((row) => awaitsQuota(row.until, row.device_id, online, deps.now)).map((row) => [row.device_id, row.until] as const)])
    holds.set(deviceId, [...holds.get(deviceId) ?? [], until]);
  for (const [deviceId, untils] of holds) {
    const earliest = untils.filter((until): until is string => Boolean(until)).map((until) => new Date(until).toISOString()).sort()[0] ?? null;
    add({ id: `quota:${deviceId}`, kind: "quota", title: earliest ? `Claude 订阅额度用完 · ${shanghaiLabel(new Date(earliest)).slice(-5)} 恢复` : "Claude 订阅额度用完",
      source: `${untils.length} 件停着`, at: null, open: { kind: "connections", id: "this_computer" }, deviceId, dueAt: earliest, answer: "open" });
  }

  // 计划等你开工：树上的 Task 本人还开着的草稿（同看板 readBoard，哪次拆卡出的都算）；时间和 id 取这些草稿所属计划里最新的那次。就地「开工」= 接受草稿带 start。
  const tree = [...taskById.keys()];
  const plans = tree.length ? (await q(`SELECT DISTINCT ON (d.plan_task_id) p.id::text,d.plan_task_id,COALESCE(p.finished_at,p.created_at) AS at,
      count(*) OVER (PARTITION BY d.plan_task_id)::int AS drafts
    FROM card_drafts d JOIN card_plans p ON p.id=d.plan_id WHERE d.owner_id=$1 AND d.status='open' AND d.plan_task_id=ANY($2::text[])
    ORDER BY d.plan_task_id,COALESCE(p.finished_at,p.created_at) DESC,p.id`,
  [ownerId, tree])).rows as { id: string; plan_task_id: string; at: Date; drafts: number }[] : [];
  for (const plan of plans)
    add({ id: `plan_start:${plan.id}`, kind: "plan_start", title: `${taskName(plan.plan_task_id)}：计划等你开工`, source: `${plan.drafts} 件等你开工`,
      at: plan.at.toISOString(), open: taskProject(plan.plan_task_id) ? { kind: "project", id: taskProject(plan.plan_task_id)! } : { kind: "task_detail", id: plan.plan_task_id },
      taskId: plan.plan_task_id, answer: "inline" });

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
  for (const [meetingId, entry] of meetings) add({ id: `meeting:${meetingId}`, kind: "meeting", title: entry.title,
    source: [entry.confirms ? `${entry.confirms} 条待你确认` : null, entry.failed ? "会议记录没生成" : null].filter(Boolean).join(" · "),
    at: entry.endedAt, open: { kind: "meeting", id: meetingId }, answer: "open" });
  // Mission Card：本人确认我的任务（轮次在本人确认阶段、我那张还没确认），拍板人那一侧的待办。截止是本人确认关闭的时间。
  for (const card of await deps.missionRounds(person)) {
    const round = card.payload as TMissionRoundSummary;
    const item = { kind: "mission_card" as const, source: `${round.battlefieldName} · ${Number(round.period.slice(5))} 月 Mission Card`, at: round.openedAt,
      dueAt: round.closesAt, answer: "open" as const };
    const mine = round.cards.find((entry) => entry.mine);
    if (round.phase === "open" && mine && !mine.ownerConfirmedAt)
      add({ ...item, id: `mission_card:${mine.cardId}`, title: "确认我的任务", open: { kind: "mission_card", id: mine.cardId } });
    if (round.approver && round.todo)
      add({ ...item, id: `mission_round:${round.roundId}`, title: round.todo, open: { kind: "mission_card", id: round.roundId, round: true } });
  }

  // 请你认可（设计 9.10）：负责人 7 天内「请 X 看」请了本人（V1 的飞书通知队列，去重键带 Task、第几条、认可人），这件 Task 最新一版还没交付。
  // 同一件 Task 同一条只出一条，取最近一次请的时间。V1 里认可人没有「认可」动作，点开是只读的 Task 详情。
  const asks = new Map<string, { taskId: string; index: number; at: Date }>();
  for (const row of (await q("SELECT dedupe_key,created_at FROM jobs WHERE kind=$1 AND dedupe_key LIKE $2 AND created_at>$3",
    [FEISHU_NOTIFY_KIND, `%:task-check:%:${ownerId}:%`, new Date(deps.now.getTime() - ACCEPTANCE_DAYS * DAY_MS)])).rows as { dedupe_key: string; created_at: Date }[]) {
    const key = parseNotifyKey(row.dedupe_key);
    if (!key || key.personId !== ownerId) continue;
    const id = `${key.taskId}\n${key.index}`;
    if (!asks.has(id) || asks.get(id)!.at < row.created_at) asks.set(id, { taskId: key.taskId, index: key.index, at: row.created_at });
  }
  const askedTasks = [...new Set([...asks.values()].map((ask) => ask.taskId))];
  const delivered = new Set(askedTasks.length ? ((await q(`SELECT task_id FROM (SELECT DISTINCT ON (task_id) task_id,delivered_at FROM deliverable_versions
    WHERE task_id=ANY($1::text[]) ORDER BY task_id,number DESC) v WHERE delivered_at IS NOT NULL`, [askedTasks])).rows as { task_id: string }[]).map((row) => row.task_id) : []);
  const located = new Map<string, { name: string; ownerId: string; acceptors: Map<number, string | null> } | null>();
  for (const ask of asks.values()) {
    if (delivered.has(ask.taskId)) continue;
    if (!located.has(ask.taskId)) {
      // 和 Task 详情同一个口径（openPlanTask）：本人看不了这件 Task 就不列。下面还要求本人现在仍是那一条的认可人，
      // 认可人本来就看得了，所以这里不用分辨本人是不是 CEO。
      const opened = await openPlanTask(q, deps.planTasks, { personId: ownerId, isCeo: false }, deps.now, ask.taskId, deps.names).catch((cause: unknown) => {
        if (cause instanceof DeliverableError) return null;
        throw cause;
      });
      located.set(ask.taskId, opened && { name: opened.access.task.name, ownerId: opened.access.ownerId,
        acceptors: new Map(opened.agreement.criteria.map((item) => [item.index, item.acceptor?.personId ?? null])) });
    }
    const task = located.get(ask.taskId);
    // 负责人后来把这一条的认可人换了、或删了这一条：不再请本人认。
    if (!task || task.acceptors.get(ask.index) !== ownerId) continue;
    add({ id: `acceptance:${ask.taskId}:${ask.index}`, kind: "acceptance", title: `请你认可「${task.name}」第 ${ask.index} 条`, source: null, at: ask.at.toISOString(),
      open: { kind: "task_detail", id: ask.taskId }, taskId: treeTask(ask.taskId), answer: "open",
      person: { personId: task.ownerId, name: deps.names.get(task.ownerId) ?? task.ownerId } });
  }

  // 岗位修改建议：就地采纳或不要。
  const FIELD_TEXT = { dutiesMd: "职责", practiceMd: "做法", acceptanceMd: "验收口径" } as const;
  for (const proposal of await listProposals(q, ownerId, "open")) {
    const card = cards.find((view) => view.id === proposal.card.id);
    add({ id: `role:${proposal.id}`, kind: "role", title: `${proposal.role.name}：建议改${FIELD_TEXT[proposal.field]}`, source: proposal.card.title,
      at: proposal.createdAt, open: { kind: "role", id: proposal.id }, taskId: treeTask(card?.planTaskId ?? null), answer: "inline" });
  }

  // 月份（设计 10.4、10.7）：复盘窗口里「复盘 N 月」，截止是窗口关闭；之前月份还有没了结、在树上的 Task，每个月一条。
  // 新月份的草稿到了待敲定（finalize）要等 Co-Agent 的草稿，还没有数据，不出。
  const review = reviewWindow(deps.now);
  // 这个月本人每件没了结的 Task 都选了怎么办（月份页，monthPage.ts）就不出。
  if (review && !(await monthReviewAnswered(q, deps.planTasks, ownerId, review.period)))
    add({ id: `month:review:${review.period}`, kind: "month", title: `复盘 ${Number(review.period.slice(5))} 月`, source: null, at: null,
      open: { kind: "month", id: review.period }, dueAt: review.closesAt, answer: "open", month: { step: "review", period: review.period } });
  const earlier = new Map<string, number>();
  for (const task of taskById.values()) if (task.period !== input.period) earlier.set(task.period, (earlier.get(task.period) ?? 0) + 1);
  for (const [period, count] of [...earlier].sort(([a], [b]) => b.localeCompare(a)))
    add({ id: `month:continue:${period}`, kind: "month", title: `${Number(period.slice(5))} 月还有 ${count} 件没了结`, source: null, at: null,
      open: { kind: "month", id: period }, answer: "open", month: { step: "continue", period } });

  // 电脑（设计 9.9）：本人一台在线的电脑都没有，而有活在等本机（还没开的子会话，含登记了要开工的；会话还在或停着等额度、但电脑不在线的，
  // 规划员、验收员停着等额度的也算；没开的拆卡登记）。
  const waitingForDevice = subs.filter((sub) => sub.queueReason === "device_offline" || sub.queueReason === "not_dispatched").length + input.openSplits
    + heldHelpers.filter((row) => !online.has(row.device_id)).length;
  if (waitingForDevice && !input.devices.some((device) => device.online))
    add({ id: "device:this_computer", kind: "device", title: input.devices.length ? `电脑不在线 · ${waitingForDevice} 件在等` : "还没有配对的电脑",
      source: input.devices.length ? null : `${waitingForDevice} 件在等`, at: null, open: { kind: "connections", id: "this_computer" }, answer: "open" });

  // 项目转交（16.7）：别人把项目交给本人、发出了还没接手的；点开是只读预览，「接手」「不接」。
  const incoming = (await q(`SELECT t.id::text,t.project_id::text,t.from_id,t.decided_at,p.name FROM project_transfers t JOIN projects p ON p.id=t.project_id
    WHERE t.to_id=$1 AND t.status='sent'`, [ownerId])).rows as { id: string; project_id: string; from_id: string; decided_at: Date; name: string }[];
  for (const row of incoming) {
    const from = { personId: row.from_id, name: deps.names.get(row.from_id) ?? row.from_id };
    add({ id: `transfer:${row.id}`, kind: "transfer", title: `${from.name}把「${row.name}」交给你`, source: null, at: row.decided_at.toISOString(),
      open: { kind: "transfer", id: row.id }, projectId: row.project_id, person: from, answer: "open" });
  }

  return waiting.sort(byUrgency);
}
