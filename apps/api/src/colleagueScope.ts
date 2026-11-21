import type { TCardCriterionVerdict, TTaskCheckCriterion } from "@warmap/contracts";
import { effectiveOutcome, type HandbackRow, type StoredAcceptance } from "./cardProjection.js";
import type { Query } from "./meetingStore.js";
import { colleagueAccess } from "./colleagueAccess.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { locatePlanTask } from "./planTaskAccess.js";
import type { PlanTaskSource } from "./planTasks.js";
import { CARD_PROJECT } from "./projects.js";
import { maskSecrets } from "./secretPatterns.js";
import { checkTask, readAgreement } from "./taskAgreements.js";
import { treeTasks } from "./workHome.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 同事可读范围（R1、R10、R11，补充条款 A2、A4、A5）：读同事的伙伴（方案一）和代答（方案二）都只从这里取材料。
 * 按资料主人读出原始行（OwnerRows），用纯函数 scopeEntries 筛出同事可读的条目；读全文时 itemId 只和筛出来的条目整串比对，出去之前遮一遍密钥。
 * 长期记忆、对话原文、本机文件这些表这里根本不读。
 * 另有按人名或工种搜人（R4a）：没有「列出全部」这种用法。
 */

export type ScopeKind = "note" | "file" | "skill" | "task" | "deliverable" | "project" | "session" | "output";
/** under：上一级条目的 itemId（deliverable → task，session → project，output → session），顶层为 null。author：项目转交过来以前别人记的会话，原作者的名字（A4，有才带）。 */
export type ScopeEntry = { itemId: string; kind: ScopeKind; title: string; updatedAt: string | null; under: string | null; author?: string };
export type SessionLine = "没开工" | "在跑" | "停着" | "已完成";
/**
 * 按人读出来、还没筛的行。只有这几样；长期记忆、对话原文、本机文件不在里面。
 * deliverables.hidden：这件 Task 挂在收起的项目上（A2），交付条目的正文不出。sessions：被读的人现在负责的项目里的会话，不管当初记在谁名下（A4），
 * author 是原作者的名字（不是被读的人、名字查得到时才有）。projects.updatedAt：项目自己的更新时间。
 * deliverables.hasText、outputs.hasText：读得出字（链接、抽出了文字的文件、有文字或链接的证据），图片和没抽出文字的为 false。
 */
export type OwnerRows = {
  note: { updatedAt: string } | null;
  files: { id: string; fileName: string; createdAt: string }[];
  roles: { id: string; name: string; shared: boolean; archived: boolean; updatedAt: string }[];
  tasks: { taskId: string; name: string; carried: boolean }[];
  deliverables: { itemId: string; taskId: string; name: string; versionNumber: number; hidden: boolean; hasText: boolean }[];
  projects: { id: string; name: string; scratch: boolean; archived: boolean; hidden: boolean; updatedAt: string }[];
  sessions: { kind: "card" | "topic"; id: string; title: string; projectId: string | null; trashed: boolean; archived: boolean; line: SessionLine; updatedAt: string;
    author: string | null }[];
  outputs: { id: string; sessionKind: "card" | "topic"; sessionId: string; title: string; createdAt: string; hasText: boolean }[];
};

/**
 * 范围判定，纯函数。itemId：note、file:<id>、skill:<id>、task:<taskId>、deliverable:<条目 id>、project:<id>、session:<kind>:<id>、output:<id>。
 * 技能要同事可用、没归档；Task 不是往月带过来的；交付条目要它的 Task 在范围里、没收起；项目没归档、不是「随手」、没收起；
 * 会话在留下的项目里、没删、没归档；产出要它的会话在范围里。读不出字的交付条目和产出不进来（读了也没有正文）。
 * 顺序：说明、文件、技能、Task（各自跟着它的交付条目）、项目（最近动静新的在前：项目自己的更新时间和它留下的会话的更新时间取最晚；
 * 跟着它的会话，新的在前；会话跟着它的产出）。目录封顶时从末尾截，截掉的是最老的项目。
 */
export function scopeEntries(rows: OwnerRows): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  if (rows.note) entries.push({ itemId: "note", kind: "note", title: "说明", updatedAt: rows.note.updatedAt, under: null });
  for (const file of rows.files) entries.push({ itemId: `file:${file.id}`, kind: "file", title: file.fileName, updatedAt: file.createdAt, under: null });
  for (const role of rows.roles.filter((row) => row.shared && !row.archived))
    entries.push({ itemId: `skill:${role.id}`, kind: "skill", title: role.name, updatedAt: role.updatedAt, under: null });
  for (const task of rows.tasks.filter((row) => !row.carried)) {
    const taskItem = `task:${task.taskId}`;
    entries.push({ itemId: taskItem, kind: "task", title: task.name, updatedAt: null, under: null });
    for (const item of rows.deliverables.filter((row) => row.taskId === task.taskId && !row.hidden && row.hasText))
      entries.push({ itemId: `deliverable:${item.itemId}`, kind: "deliverable", title: item.name, updatedAt: null, under: taskItem });
  }
  const projects = rows.projects.filter((row) => !row.scratch && !row.archived && !row.hidden).map((project) => {
    const sessions = rows.sessions.filter((row) => row.projectId === project.id && !row.trashed && !row.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const latest = sessions[0] && sessions[0].updatedAt > project.updatedAt ? sessions[0].updatedAt : project.updatedAt;
    return { project, sessions, latest };
  }).sort((a, b) => b.latest.localeCompare(a.latest) || a.project.id.localeCompare(b.project.id));
  for (const { project, sessions } of projects) {
    const projectItem = `project:${project.id}`;
    entries.push({ itemId: projectItem, kind: "project", title: project.name, updatedAt: null, under: null });
    for (const session of sessions) {
      const sessionItem = `session:${session.kind}:${session.id}`;
      entries.push({ itemId: sessionItem, kind: "session", title: session.title, updatedAt: session.updatedAt, under: projectItem,
        ...(session.author ? { author: session.author } : {}) });
      for (const output of rows.outputs.filter((row) => row.sessionKind === session.kind && row.sessionId === session.id && row.hasText))
        entries.push({ itemId: `output:${output.id}`, kind: "output", title: output.title, updatedAt: output.createdAt, under: sessionItem });
    }
  }
  return entries;
}

export type ScopeSource = { owner: { personId: string; name: string }; rows(): Promise<OwnerRows>; body(entry: ScopeEntry, rows: OwnerRows): Promise<string | null> };
export type ScopeText = { person: { personId: string; name: string }; itemId: string; kind: ScopeKind; title: string; updatedAt: string | null;
  text: string; truncated: boolean; nextOffset: number | null };
export type ScopeReader = {
  owner: { personId: string; name: string };
  /** 最多 CATALOG_MAX 条，多出来的条数在 more。 */
  catalog(): Promise<{ person: { personId: string; name: string }; entries: ScopeEntry[]; more: number }>;
  /** 不在范围里、没有正文都回 null。limit 缺省 READ_CHARS，最多也是 READ_CHARS。 */
  read(itemId: string, offset?: number, limit?: number): Promise<ScopeText | null>;
};
export const CATALOG_MAX = 200;
export const READ_CHARS = 24_000;

/** 出去的条目：标题和原作者也遮一遍密钥（卡和专题的标题常是本人的原话，产出标题、文件名来自本机或上传）。 */
const masked = (entry: ScopeEntry): ScopeEntry => ({ ...entry, title: maskSecrets(entry.title), ...(entry.author ? { author: maskSecrets(entry.author) } : {}) });

/** 读：先读行、筛出范围，按 itemId 整串找；找到才拼正文，正文先遮密钥再按 offset、limit 切。目录和读出来的标题也遮。 */
export function scopeReader(source: ScopeSource): ScopeReader {
  const person = source.owner;
  return {
    owner: person,
    async catalog() {
      const entries = scopeEntries(await source.rows());
      return { person, entries: entries.slice(0, CATALOG_MAX).map(masked), more: Math.max(0, entries.length - CATALOG_MAX) };
    },
    async read(itemId, offset = 0, limit = READ_CHARS) {
      const rows = await source.rows();
      const entry = scopeEntries(rows).find((item) => item.itemId === itemId);
      if (!entry) return null;
      const body = await source.body(entry, rows);
      if (body === null) return null;
      const text = maskSecrets(body);
      const start = Math.max(0, Math.floor(offset) || 0);
      const end = start + Math.min(READ_CHARS, Math.max(1, Math.floor(limit) || READ_CHARS));
      const rest = end < text.length;
      return { person, itemId: entry.itemId, kind: entry.kind, title: maskSecrets(entry.title), updatedAt: entry.updatedAt, text: text.slice(start, end), truncated: rest,
        nextOffset: rest ? end : null };
    },
  };
}

/** names 是人员目录的全部名字（约定里的认可人、会话的原作者用）。 */
export type ScopeDeps = { q: Query; planTasks: PlanTaskSource; names: Map<string, string>; now: Date };

/** 专题在哪个项目：同 projects.ts 的写法，Task 挂着的项目优先，其次是专题自己记的。 */
const TOPIC_PROJECT = (alias: string) =>
  `COALESCE((SELECT g.project_id FROM project_goals g WHERE g.task_id=${alias}.plan_task_id),${alias}.project_id)`;
const RUNNING = ["queued", "starting", "running", "waiting_permission"];
const iso = (time: Date) => new Date(time).toISOString();
const later = (a: Date, b: Date | null) => b && b > a ? b : a;
/** 卡已完成或最近一次执行是 done → 已完成；没执行过 → 没开工；最近一次在排、在开、在跑、在等批准 → 在跑；其余 → 停着。 */
const lineOf = (done: boolean, run: string | null): SessionLine =>
  done || run === "done" ? "已完成" : !run ? "没开工" : RUNNING.includes(run) ? "在跑" : "停着";
const STATUS_WORDS: Record<TTaskCheckCriterion["status"], string> = { evidenced: "有证据", needs_acceptor: "有证据", gap: "差", reviewing: "评审中",
  no_deliverable: "还没交付物" };
const WHY_WORDS: Record<string, string> = { turn_done: "做完一轮", interrupted: "被打断", held: "额度用完停着", error: "出错停住", killed: "被停掉", runner_restart: "本机程序重启" };
const VERDICT_WORDS: Record<TCardCriterionVerdict, string> = { met: "达到", partial: "部分达到", unmet: "没达到", needs_person: "要本人补" };
const OUTCOME_WORDS = { pass: "过了", fail: "没过", needs_person: "要本人补" } as const;
/** 公司时区（上海）的日期和时刻。 */
const stamp = (time: Date) => new Date(new Date(time).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
/** itemId 去掉第一段（kind）以后的部分；session 再去掉一段 kind。 */
const idOf = (entry: ScopeEntry) => entry.itemId.slice(entry.itemId.indexOf(":") + 1);

/**
 * 从库里按资料主人读：全部只读（不调 readWorkHome，它会顺手理项目）。Task 以资料主人为看的人读本体，读不到那一条为 null。
 */
export function dbScopeSource(deps: ScopeDeps, ownerId: string): ScopeSource {
  const { q, names } = deps;
  const owner = { personId: ownerId, name: names.get(ownerId) ?? ownerId };

  async function rows(): Promise<OwnerRows> {
    const note = (await q("SELECT updated_at FROM colleague_notes WHERE owner_id=$1", [ownerId])).rows[0] as { updated_at: Date } | undefined;
    const files = (await q("SELECT id::text,file_name,created_at FROM colleague_files WHERE owner_id=$1 ORDER BY created_at,id", [ownerId])).rows as
      { id: string; file_name: string; created_at: Date }[];
    const roles = (await q(`SELECT id::text,name,shared_with_colleagues AS shared,archived_at IS NOT NULL AS archived,updated_at FROM roles WHERE owner_id=$1
      ORDER BY created_at,id`, [ownerId])).rows as { id: string; name: string; shared: boolean; archived: boolean; updated_at: Date }[];
    const projects = (await q(`SELECT id::text,name,scratch,archived_at IS NOT NULL AS archived,hidden_from_colleagues AS hidden,updated_at FROM projects
      WHERE owner_id=$1 ORDER BY created_at,id`, [ownerId])).rows as (Omit<OwnerRows["projects"][number], "updatedAt"> & { updated_at: Date })[];
    const projectIds = projects.map((project) => project.id);
    // 会话按项目归集（A4）：被读的人现在负责的项目里的卡和专题，不管记在谁名下。
    const sessions = projectIds.length ? (await q(`SELECT * FROM (
        SELECT 'card' AS kind,t.id::text,t.title,${CARD_PROJECT("t")}::text AS project_id,t.trashed_at IS NOT NULL AS trashed,t.archived_at IS NOT NULL AS archived,
          t.status='done' AS done,t.owner_id,t.updated_at,
          (SELECT r.state FROM local_runs r WHERE r.task_id=t.id ORDER BY r.started_at DESC,r.id DESC LIMIT 1) AS run_state,
          (SELECT max(r.updated_at) FROM local_runs r WHERE r.task_id=t.id) AS run_at
        FROM tasks t WHERE t.role_id IS NOT NULL OR t.executor='claude_code'
        UNION ALL
        SELECT 'topic',r.id::text,r.title,${TOPIC_PROJECT("r")}::text,r.trashed_at IS NOT NULL,r.status='archived',false,r.owner_id,r.updated_at,
          (SELECT l.state FROM local_runs l WHERE l.topic_id=r.id ORDER BY l.started_at DESC,l.id DESC LIMIT 1),
          (SELECT max(l.updated_at) FROM local_runs l WHERE l.topic_id=r.id)
        FROM research_topics r) s WHERE s.project_id=ANY($1::text[]) ORDER BY s.updated_at,s.id`, [projectIds])).rows as
      { kind: "card" | "topic"; id: string; title: string; project_id: string; trashed: boolean; archived: boolean; done: boolean; owner_id: string; updated_at: Date;
        run_state: string | null; run_at: Date | null }[] : [];
    const cardIds = sessions.filter((row) => row.kind === "card").map((row) => row.id);
    const topicIds = sessions.filter((row) => row.kind === "topic").map((row) => row.id);
    const outputs = sessions.length ? (await q(`SELECT id::text,CASE WHEN task_id IS NOT NULL THEN 'card' ELSE 'topic' END AS session_kind,
        COALESCE(task_id,topic_id)::text AS session_id,title,created_at,
        CASE WHEN kind='artifact' THEN btrim(COALESCE(extracted_text,''))<>'' ELSE COALESCE(text,'')<>'' OR COALESCE(url,'')<>'' END AS has_text
        FROM local_outputs WHERE task_id=ANY($1::uuid[]) OR topic_id=ANY($2::uuid[])
        ORDER BY created_at,id`, [cardIds, topicIds])).rows as { id: string; session_kind: "card" | "topic"; session_id: string; title: string; created_at: Date;
        has_text: boolean }[] : [];
    const tree = await treeTasks(q, deps.planTasks, ownerId, deps.now);
    const carried = new Set(tree.missions.filter((mission) => mission.carried).map((mission) => mission.id));
    const tasks = tree.tasks.map((task) => ({ taskId: task.taskId, name: task.name, carried: carried.has(task.missionId) }));
    // 每件 Task 最新一版的条目。条目正文不出（A2）的三种：Task 现在挂在收起的项目上；这件 Task 的任何一版记的项目收起了（取下 Task 时版本还记着原来的项目，新版本不记项目、又会沿用上一版的条目）；
    // 这件 Task 进过版本的准备中各样（卡的交回、专题的一版）出自收起项目里的会话（沿用的条目是复制的，所以看全部进过版本的，不只最新一版）。
    const deliverables = tasks.length ? (await q(`SELECT i.id::text AS item_id,v.task_id,i.name,v.number,v.hidden,
        i.kind='link' OR btrim(COALESCE(i.extracted_text,''))<>'' AS has_text FROM (
        SELECT DISTINCT ON (v.task_id) v.id,v.task_id,v.number,EXISTS (SELECT 1 FROM project_goals g JOIN projects p ON p.id=g.project_id
            WHERE g.task_id=v.task_id AND p.hidden_from_colleagues)
          OR EXISTS (SELECT 1 FROM deliverable_versions o JOIN projects p ON p.id=o.project_id WHERE o.task_id=v.task_id AND p.hidden_from_colleagues)
          OR EXISTS (SELECT 1 FROM deliverable_pending_items d LEFT JOIN card_handbacks h ON h.id=d.handback_id LEFT JOIN tasks t ON t.id=h.task_id
              LEFT JOIN topic_versions tv ON tv.id=d.topic_version_id LEFT JOIN research_topics r ON r.id=tv.topic_id
              JOIN projects p ON p.id=COALESCE(${CARD_PROJECT("t")},${TOPIC_PROJECT("r")}) AND p.hidden_from_colleagues
            WHERE d.plan_task_id=v.task_id AND d.version_id IS NOT NULL) AS hidden
        FROM deliverable_versions v WHERE v.task_id=ANY($1::text[]) ORDER BY v.task_id,v.number DESC) v
      JOIN deliverable_items i ON i.version_id=v.id ORDER BY v.task_id,i.position`, [tasks.map((task) => task.taskId)])).rows as
      { item_id: string; task_id: string; name: string; number: number; hidden: boolean; has_text: boolean }[] : [];
    return {
      note: note ? { updatedAt: iso(note.updated_at) } : null,
      files: files.map((file) => ({ id: file.id, fileName: file.file_name, createdAt: iso(file.created_at) })),
      roles: roles.map((role) => ({ id: role.id, name: role.name, shared: role.shared, archived: role.archived, updatedAt: iso(role.updated_at) })),
      tasks,
      deliverables: deliverables.map((row) => ({ itemId: row.item_id, taskId: row.task_id, name: row.name, versionNumber: row.number, hidden: row.hidden,
        hasText: row.has_text })),
      projects: projects.map(({ updated_at, ...project }) => ({ ...project, updatedAt: iso(updated_at) })),
      sessions: sessions.map((row) => ({ kind: row.kind, id: row.id, title: row.title, projectId: row.project_id, trashed: row.trashed, archived: row.archived,
        line: lineOf(row.done, row.run_state), updatedAt: iso(later(row.updated_at, row.run_at)),
        author: row.owner_id !== ownerId ? names.get(row.owner_id) ?? null : null })),
      outputs: outputs.map((row) => ({ id: row.id, sessionKind: row.session_kind, sessionId: row.session_id, title: row.title, createdAt: iso(row.created_at),
        hasText: row.has_text })),
    };
  }

  async function taskBody(taskId: string, rows: OwnerRows): Promise<string | null> {
    try {
      const access = await locatePlanTask(q, deps.planTasks, { personId: ownerId, isCeo: false }, deps.now, taskId);
      const agreement = await readAgreement(q, access, names);
      const check = await checkTask(q, access, agreement, deps.now);
      const lines = [`Task：${access.task.name}`, "约定："];
      if (!agreement.criteria.length) lines.push("没有可对照的标准");
      for (const item of agreement.criteria)
        lines.push(`第 ${item.index} 条：${item.text}；用什么证明：${item.proof ?? "没写"}；谁来认：${item.acceptor?.name ?? "没写"}`);
      if (agreement.exclusions.length) lines.push(`不包括：${agreement.exclusions.join("；")}`);
      lines.push(`对表：${check.conclusion}`);
      for (const item of check.criteria) {
        const status = item.status === "gap" ? `差：${item.gap ?? ""}` : item.status === "needs_acceptor" ? `有证据，要${item.acceptor?.name ?? ""}确认` : STATUS_WORDS[item.status];
        lines.push(`第 ${item.index} 条：${status}`);
      }
      if (check.version) {
        const statement = (await q("SELECT statement FROM deliverable_versions WHERE id=$1", [check.version.id])).rows[0] as { statement: string | null } | undefined;
        lines.push(`最新一版：第 ${check.version.number} 版；交付时间：${check.version.deliveredAt ? stamp(new Date(check.version.deliveredAt)) : "还没交付"}；`
          + `说明：${statement?.statement ?? "没写"}`);
        const items = scopeEntries(rows).filter((entry) => entry.under === `task:${taskId}`);
        for (const item of items) lines.push(`条目：${item.title}（${item.itemId}）`);
      }
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  async function projectBody(entry: ScopeEntry, rows: OwnerRows): Promise<string> {
    const sessions = scopeEntries(rows).filter((item) => item.under === entry.itemId);
    const byItem = new Map(rows.sessions.map((row) => [`session:${row.kind}:${row.id}`, row]));
    const reported = sessions.length ? new Map(((await q(`SELECT kind||':'||subject_id AS key,max(created_at) AS at FROM sub_session_reports
      WHERE subject_id=ANY($1::uuid[]) GROUP BY kind,subject_id`, [sessions.map((item) => byItem.get(item.itemId)!.id)])).rows as { key: string; at: Date }[])
      .map((row) => [`session:${row.key}`, row.at])) : new Map<string, Date>();
    return [`项目：${entry.title}`, ...sessions.map((item) => {
      const at = reported.get(item.itemId);
      return `${item.title} · ${byItem.get(item.itemId)!.line} · ${at ? `最近一次报告 ${shanghaiDate(new Date(at))}` : "还没有报告"}（${item.itemId}）`;
    })].join("\n");
  }

  async function sessionBody(entry: ScopeEntry, rows: OwnerRows): Promise<string> {
    const [kind, id] = idOf(entry).split(":") as ["card" | "topic", string];
    const row = rows.sessions.find((item) => item.kind === kind && item.id === id)!;
    const lines = [`会话：${entry.title} · ${row.line}`];
    if (entry.author) lines.push(`原作者：${entry.author}`);
    const reports = (await q("SELECT created_at,why,summary,blocker,outputs FROM sub_session_reports WHERE kind=$1 AND subject_id=$2 ORDER BY created_at,id", [kind, id]))
      .rows as { created_at: Date; why: string; summary: string | null; blocker: string | null; outputs: { title: string; fileName: string | null }[] }[];
    if (reports.length) lines.push("停下的报告：");
    for (const report of reports) lines.push([`- ${stamp(report.created_at)}`, WHY_WORDS[report.why] ?? report.why, report.summary,
      report.blocker ? `卡在：${report.blocker}` : null, report.outputs.length ? `交了：${report.outputs.map((item) => item.fileName ?? item.title).join("、")}` : null]
      .filter(Boolean).join(" · "));
    if (kind === "card") {
      const handbacks = (await q(`SELECT attempt,status,outcome,overruled_at,gap_closed_at,result FROM card_handbacks WHERE task_id=$1 ORDER BY attempt`, [id])).rows as
        (Pick<HandbackRow, "attempt" | "status" | "outcome" | "overruled_at" | "gap_closed_at"> & { result: StoredAcceptance | null })[];
      if (handbacks.length) lines.push("交回：");
      for (const handback of handbacks) {
        const outcome = handback.status === "done" ? effectiveOutcome(handback) : null;
        const state = outcome ? OUTCOME_WORDS[outcome] : handback.status === "failed" ? "验收没做完" : "还在验收";
        lines.push(`- 第 ${handback.attempt} 次 · ${state}${handback.result?.headline ? ` · ${handback.result.headline}` : ""}`);
        if (handback.status === "done")
          for (const item of [...handback.result?.criteria ?? []].sort((a, b) => a.index - b.index))
            lines.push(`  第 ${item.index} 条：${VERDICT_WORDS[item.verdict]} · ${item.reason}`);
      }
    }
    const outputs = scopeEntries(rows).filter((item) => item.under === entry.itemId);
    if (outputs.length) lines.push("产出：", ...outputs.map((item) => `- ${item.title}（${item.itemId}）`));
    return lines.join("\n");
  }

  async function body(entry: ScopeEntry, rows: OwnerRows): Promise<string | null> {
    const id = idOf(entry);
    switch (entry.kind) {
      case "note":
        return ((await q("SELECT body FROM colleague_notes WHERE owner_id=$1", [ownerId])).rows[0] as { body: string } | undefined)?.body ?? null;
      case "file":
        return ((await q("SELECT extracted_text FROM colleague_files WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0] as { extracted_text: string } | undefined)
          ?.extracted_text ?? null;
      case "skill": {
        const role = (await q("SELECT name,duties_md,practice_md,acceptance_md FROM roles WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0] as
          { name: string; duties_md: string; practice_md: string; acceptance_md: string } | undefined;
        return role ? `${role.name}\n\n职责\n${role.duties_md}\n\n做法\n${role.practice_md}\n\n验收口径\n${role.acceptance_md}` : null;
      }
      case "task":
        return taskBody(id, rows);
      case "deliverable": {
        const item = (await q(`SELECT i.kind,i.name,i.url,i.extracted_text FROM deliverable_items i JOIN deliverable_versions v ON v.id=i.version_id
          WHERE i.id=$1 AND v.task_id=$2`, [id, entry.under!.slice("task:".length)])).rows[0] as
          { kind: "file" | "image" | "link"; name: string; url: string | null; extracted_text: string | null } | undefined;
        if (!item) return null;
        return item.kind === "link" ? `${item.name}\n${item.url}` : item.extracted_text;
      }
      case "project":
        return projectBody(entry, rows);
      case "session":
        return sessionBody(entry, rows);
      case "output": {
        const output = (await q("SELECT kind,extracted_text,text,url FROM local_outputs WHERE id=$1", [id])).rows[0] as
          { kind: "artifact" | "evidence"; extracted_text: string | null; text: string | null; url: string | null } | undefined;
        if (!output) return null;
        return output.kind === "artifact" ? output.extracted_text : [output.text, output.url].filter(Boolean).join("\n") || null;
      }
    }
  }

  return { owner, rows, body };
}

// 搜人（R4a、A1、A5）：没有「列出全部」这种用法。

/** 一个人能被搜到的几样：名字，加「负责战场：增长」「负责能力域：研发」「公开技能：部署验收」这样的标签。 */
export type ColleagueIndexEntry = { personId: string; name: string; labels: string[] };
/** matched：对上的是「名字」还是哪几个标签（就是命中原因）。 */
export type ColleagueHit = { personId: string; name: string; matched: string[] };
export const COLLEAGUE_HITS = 5;

/**
 * 从库里读出可搜的人：人员目录里搜的人能读的那些（colleagueAccess 判 read，A1：都要是 DRI 或 CEO、不含自己），
 * 标签取他负责的战场名、能力域名、他标了同事可用且没归档的技能名。不用 Mission 标题和项目名（A5）。
 */
export async function colleagueIndex(q: Query, directory: PeopleDirectory, viewerId: string): Promise<ColleagueIndexEntry[]> {
  const people: [string, string][] = [];
  for (const person of directory.searchPeople(undefined))
    if ((await colleagueAccess(q, directory, viewerId, person.personId, "read")).allowed) people.push([person.personId, person.displayName]);
  if (!people.length) return [];
  const rows = (await q(`SELECT owner_id,label FROM (
      SELECT owner_id,'负责战场：'||name AS label,1 AS rank,sort_order,name FROM battlefield_config WHERE owner_id=ANY($1::text[])
      UNION ALL SELECT owner_id,'负责能力域：'||name,2,sort_order,name FROM capability_config WHERE owner_id=ANY($1::text[])
      UNION ALL SELECT owner_id,'公开技能：'||name,3,0,name FROM roles WHERE shared_with_colleagues AND archived_at IS NULL AND owner_id=ANY($1::text[])) l
    ORDER BY rank,sort_order,name`, [people.map(([personId]) => personId)])).rows as { owner_id: string; label: string }[];
  return people.map(([personId, name]) => ({ personId, name, labels: [...new Set(rows.filter((row) => row.owner_id === personId).map((row) => row.label))] }));
}

/** 纯函数。query 去掉首尾空白后不足 2 个字回空；名字或标签里包含 query（不分大小写）算对上；最多回 COLLEAGUE_HITS 个，多出来的个数在 more。 */
export function matchColleagues(index: ColleagueIndexEntry[], query: string): { people: ColleagueHit[]; more: number } {
  const needle = query.trim().toLowerCase();
  if ([...needle].length < 2) return { people: [], more: 0 };
  const hits = index.flatMap((entry): ColleagueHit[] => {
    const matched = [...entry.name.toLowerCase().includes(needle) ? ["名字"] : [], ...entry.labels.filter((label) => label.toLowerCase().includes(needle))];
    return matched.length ? [{ personId: entry.personId, name: entry.name, matched }] : [];
  });
  return { people: hits.slice(0, COLLEAGUE_HITS), more: Math.max(0, hits.length - COLLEAGUE_HITS) };
}
