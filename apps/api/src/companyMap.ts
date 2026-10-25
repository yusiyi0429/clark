import type { TReadScope, TReadScopeParams, TReferenceSnapshot } from "@warmap/contracts";
import { beijingLabel } from "./agentTime.js";
import type { Query } from "./meetingStore.js";
import { canReadMission } from "./missions.js";
import { companyPeriod } from "./monthlyPlans.js";
import { shiftMonth } from "./monthlyCycle.js";
import { canReadMonthlyReviewItem } from "./monthlyReviews.js";
import { createProgressAccess, type ProgressViewer } from "./progressAccess.js";
import { BATTLEFIELD_MEMBERS, weekPeriod, weeklyReviewText } from "./weeklyReviews.js";

/**
 * 三层取用（已定设计 5a、议题 2）：每个页面的 Agent 都用同一套工具沿公司地图读，页面只决定默认焦点（focus）。
 * - read_mission_cards：Mission 卡（目标、计划），全员可读（个人卡准备期间仍只有本人看得到，canReadMission）；
 * - read_progress：执行事项进展（含采集整理后归到执行事项的进展）、执行事项状态；
 * - read_reviews：月度复盘（个人、战场 / 能力域，附评论）与周复盘；
 * - read_object_tree：从公司、战场、Mission、Task 或某个人出发，向上、向下、向旁边走。
 * 进展与复盘按 canReadProgress 判（CEO 全部，其他人同一战场）；看不到的不返回，只在结果里记 filtered 条数，Agent 必须说明。
 * 跨对象读取（不只是本人、或不只一个月、或限定了战场）时发一个范围标签（onScope），界面可以点开调整；
 * 本人改过的范围（override）这一轮一律优先。
 */

export type MapPerson = { personId: string; displayName: string };
export type ReadFocus = {
  people: "all" | "me" | string[];
  battlefieldId?: string;
  /** 页面所在的对象（task:<id>、mission:<id>…），read_object_tree 不传起点时从这里走。 */
  object?: string;
  period: string;
};
type ScopeArgs = { people?: "all" | "me" | string[]; battlefieldId?: string; from?: string; to?: string };
type Resolved = { people: string[] | null; battlefieldId: string | null; capabilityId: string | null; from: string; to: string; unknownPeople: string[]; unknownBattlefield?: string; label: string };
export type CompanyMapDeps = {
  q: Query;
  viewer: ProgressViewer;
  people: MapPerson[];
  now: () => Date;
  focus: ReadFocus;
  override?: TReadScopeParams;
  onScope?: (scope: TReadScope) => void;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** 一次最多读这么多个月。 */
export const MAX_MONTHS = 12;
const MAX_MISSIONS = 80;
const MAX_PEOPLE_PROGRESS = 30;
const UPDATES_PER_PERSON = 12;
const MAX_REVIEWS = 60;

const clip = (text: unknown, max: number): string => {
  const value = typeof text === "string" ? text.trim() : "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
const list = (value: unknown, max: number, chars: number): string[] =>
  (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, max).map((item) => clip(item, chars));
const at = (value: Date | string | null | undefined) => (value ? beijingLabel(new Date(value)).replace("（北京时间）", "") : null);
const monthOf = (value: Date | string) => companyPeriod(new Date(value));
const monthsBetween = (from: string, to: string) => {
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
};
/** [from 月初, to 次月月初)，北京时间。 */
const window = (from: string, to: string) => ({ start: `${from}-01T00:00:00+08:00`, end: `${shiftMonth(to, 1)}-01T00:00:00+08:00` });

/** 「全员 · 7–10 月」「张三、李四 · 10 月」「体验构想 · 2025.11–2026.2」。 */
export function scopeLabel(input: { people: string[] | null; battlefieldName?: string | null; from: string; to: string; viewerId: string }, names: Map<string, string>): string {
  const who = input.people === null ? (input.battlefieldName ?? "全员")
    : input.people.length === 1 && input.people[0] === input.viewerId ? "我"
    : input.people.length <= 2 ? input.people.map((id) => names.get(id) ?? id).join("、")
    : `${input.people.slice(0, 2).map((id) => names.get(id) ?? id).join("、")}等 ${input.people.length} 人`;
  const scopeWho = input.people !== null && input.battlefieldName ? `${input.battlefieldName} · ${who}` : who;
  const [fy, fm] = input.from.split("-").map(Number), [ty, tm] = input.to.split("-").map(Number);
  const months = input.from === input.to ? `${fm} 月` : fy === ty ? `${fm}–${tm} 月` : `${fy}.${fm}–${ty}.${tm}`;
  return `${scopeWho} · ${months}`;
}

/**
 * 默认焦点：scope 是场景锚点聚焦的对象（页面对象，或首页上本人选中的卡；没有聚焦时是页面 scope）。
 * 首页 CEO 看全员，其他人看自己；对象按对象定人、战场和月份。路由按它给三层取用当默认参数，同时写进 anchor.range 给模型看。
 */
export function defaultFocus(scope: string, snapshot: TReferenceSnapshot | null, viewer: ProgressViewer, now: Date): ReadFocus {
  const period = companyPeriod(now);
  if (scope === "global") return { people: viewer.role === "ceo" ? "all" : "me", period };
  const object = snapshot ? `${snapshot.objectRef.type}:${snapshot.objectRef.id}` : scope;
  const payload = (snapshot?.payload ?? {}) as Record<string, any>;
  if (scope.startsWith("task:")) {
    const task = payload.task ?? {};
    return { people: task.owner?.personId ? [task.owner.personId] : "me", object, period: task.mission?.period ?? period };
  }
  if (scope.startsWith("mission:")) {
    return { people: typeof payload.ownerId === "string" ? [payload.ownerId] : "all", battlefieldId: payload.battlefieldIds?.[0], object, period: payload.period ?? period };
  }
  if (scope.startsWith("mission-card:")) {
    const round = payload.round ?? {};
    return { people: payload.card?.ownerId ? [payload.card.ownerId] : "me", battlefieldId: round.battlefieldId, object, period: round.period ?? period };
  }
  if (scope.startsWith("monthly-review-item:")) {
    const subject = payload.subject ?? {};
    return { people: "all", ...(subject.type === "battlefield" ? { battlefieldId: subject.id } : {}), object, period: payload.period ?? period };
  }
  if (scope.startsWith("personal-review:")) return { people: "me", object, period: payload.period ?? period };
  if (scope.startsWith("battlefield:")) return { people: viewer.role === "ceo" ? "all" : "me", battlefieldId: scope.slice("battlefield:".length), object, period };
  if (scope.startsWith("issue:")) {
    const location = payload.location ?? {};
    return { people: "all", ...(location.level === "battlefield" ? { battlefieldId: location.battlefieldId } : {}), object, period };
  }
  return { people: viewer.role === "ceo" ? "all" : "me", object, period };
}

/** 工具说明（CEO 与 DRI 共用，拼在各自系统提示后面）。 */
export const THREE_LAYER_RULES = `# 三层取用

页面只是默认焦点，不是边界。\`anchor.range\` 是本页的默认读取范围（谁、哪个战场、哪个月），由 anchor 聚焦的对象决定。问到当前对象以外的人、Mission、执行情况或复盘时，用同一套工具沿公司地图读，不凭印象说：
- \`read_mission_cards\`：Mission 卡（目标、计划），全员可读；
- \`read_progress\`：执行事项的状态与进展（含本机采集整理出的进展）；
- \`read_reviews\`：月度复盘（个人、战场与能力域，附评论）与周复盘；
- \`read_object_tree\`：从公司、战场、Mission、Task 或某个人出发，向上（所属）、向下（下属）、向旁边（同级）走。
people 填「all」（全员）、「me」或人名列表；from、to 是月份（YYYY-MM），不填按 anchor.range。要几个人、几个战场、几个月就一次读完（全员就填 all，不限战场就不填 battlefieldId），不按人、按战场或按月分多次读。battlefieldId 也可以写能力域（如「智能体」）；结果里有 unknownBattlefield 表示这个名字既不是战场也不是能力域、这次没按它筛，要说明。问「我的」时不用填 battlefieldId。
结果里 filtered 大于 0 表示有这么多条因权限没有读到（等于 0 时不用提权限）（进展与复盘：CEO 能看全部，其他人只能看同一战场的）：回答里必须写明有几条没读到、原因是权限，不能猜被过滤的内容；跨战场的可以请本人用「请同事帮忙」直接问对方，或找 CEO。unknownPeople 是没对上人员目录的名字，要说明。引用读到的内容时照抄结果里的 cite 作出处。
\`scopeOverride\`（有时才出现）是本人在界面上改过的读取范围：这一轮一律按它读，回答开头不复述范围。`;

export function createCompanyMap(deps: CompanyMapDeps) {
  const { q, viewer } = deps;
  const names = new Map(deps.people.map((person) => [person.personId, person.displayName]));
  const access = createProgressAccess(q, viewer);
  let battlefields: Promise<{ id: string; code: string; name: string; owner_id: string; six_month_outcome: string; participant_ids: string[] | null }[]> | undefined;
  const loadBattlefields = () => (battlefields ??= q("SELECT id, code, name, owner_id, six_month_outcome, participant_ids FROM battlefield_config ORDER BY sort_order, code, id")
    .then((result) => result.rows as Awaited<NonNullable<typeof battlefields>>));
  /** 能力域（智能体、增长……）：从本体载入的 Mission 只挂能力域、不挂战场，模型常把能力域名当战场名传进来。 */
  let capabilities: Promise<{ id: string; code: string; name: string }[]> | undefined;
  const loadCapabilities = () => (capabilities ??= q("SELECT id, code, name FROM capability_config ORDER BY sort_order, code, id")
    .then((result) => result.rows as Awaited<NonNullable<typeof capabilities>>));
  const nameOf = (id: string) => names.get(id) ?? id;
  let lastLabel: string | undefined;
  /** 这一轮跨对象读过的总范围：模型按战场、按人分几次读时，范围标签显示合起来的那一个（人取并集，战场不同就不限，月份取首尾）。 */
  let union: { people: string[] | null; battlefieldId: string | null; from: string; to: string } | undefined;

  /** 人名 / personId → personId；对不上的单独列出。 */
  const resolvePeople = (people: ScopeArgs["people"]): { ids: string[] | null; unknown: string[] } => {
    if (people === undefined || people === "all") return { ids: null, unknown: [] };
    if (people === "me") return { ids: [viewer.personId], unknown: [] };
    const ids: string[] = [], unknown: string[] = [];
    for (const raw of people) {
      const text = raw.trim();
      if (text === "全员" || text === "all") return { ids: null, unknown: [] };
      if (text === "me" || text === "我") { ids.push(viewer.personId); continue; }
      const hit = deps.people.find((person) => person.personId === text || person.displayName === text)
        ?? deps.people.find((person) => text.length >= 2 && (person.displayName.includes(text) || text.includes(person.displayName)));
      if (hit) ids.push(hit.personId); else unknown.push(text);
    }
    return { ids: ids.length || !unknown.length ? [...new Set(ids)] : [], unknown };
  };

  /** 默认焦点 → 模型给的 → 本人改过的范围，依次覆盖；跨对象时发范围标签。 */
  const resolve = async (args: ScopeArgs, defaults: { months?: number } = {}): Promise<Resolved> => {
    const defined = (value: ScopeArgs | TReadScopeParams | undefined) => Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined && item !== "")) as ScopeArgs;
    const focus = deps.focus;
    const focusTo = focus.period;
    const focusFrom = shiftMonth(focusTo, -((defaults.months ?? 1) - 1));
    const merged: ScopeArgs = { people: focus.people, ...(focus.battlefieldId ? { battlefieldId: focus.battlefieldId } : {}), from: focusFrom, to: focusTo, ...defined(args), ...defined(deps.override) };
    let from = merged.from && MONTH.test(merged.from) ? merged.from : focusFrom;
    let to = merged.to && MONTH.test(merged.to) ? merged.to : (merged.from && MONTH.test(merged.from) ? merged.from : focusTo);
    if (from > to) [from, to] = [to, from];
    if (monthsBetween(from, to) > MAX_MONTHS) from = shiftMonth(to, -(MAX_MONTHS - 1));
    const { ids, unknown } = resolvePeople(merged.people);
    const fields = await loadBattlefields();
    const matches = (item: { id: string; name: string; code: string }) => item.id === merged.battlefieldId || item.name === merged.battlefieldId || item.code === merged.battlefieldId;
    const field = merged.battlefieldId ? fields.find(matches) : undefined;
    // 不是战场再找能力域；两边都对不上就不筛（照常读，结果里写 unknownBattlefield），不按一个不存在的战场筛成空。
    const caps = await loadCapabilities();
    const cap = merged.battlefieldId && !field ? caps.find(matches) : undefined;
    const unit = field ?? cap;
    const label = scopeLabel({ people: ids, battlefieldName: unit?.name ?? null, from, to, viewerId: viewer.personId }, names);
    // 跨对象（不只是本人、或不只一个月、或限定了战场）才发范围标签；一个人也没对上时什么都没读，不发。
    const crossObject = (ids === null || ids.some((id) => id !== viewer.personId) || from !== to || Boolean(unit)) && (ids === null || ids.length > 0);
    if (crossObject && deps.onScope) {
      union = !union ? { people: ids, battlefieldId: unit?.id ?? null, from, to } : {
        people: union.people === null || ids === null ? null : [...new Set([...union.people, ...ids])],
        battlefieldId: union.battlefieldId === (unit?.id ?? null) ? union.battlefieldId : null,
        from: union.from < from ? union.from : from, to: union.to > to ? union.to : to,
      };
      const total = union;
      const totalField = total.battlefieldId ? [...fields, ...caps].find((item) => item.id === total.battlefieldId) : undefined;
      const totalLabel = scopeLabel({ people: total.people, battlefieldName: totalField?.name ?? null, from: total.from, to: total.to, viewerId: viewer.personId }, names);
      if (totalLabel !== lastLabel) {
        lastLabel = totalLabel;
        const params: TReadScopeParams = { people: total.people === null ? "all" : total.people.length === 1 && total.people[0] === viewer.personId ? "me" : total.people,
          ...(totalField ? { battlefieldId: totalField.id } : {}), from: total.from, to: total.to };
        deps.onScope({ label: totalLabel, params, choices: { people: deps.people.slice(0, 80).map((person) => ({ id: person.personId, name: person.displayName })) } });
      }
    }
    return { people: ids, battlefieldId: field?.id ?? null, capabilityId: cap?.id ?? null, from, to, unknownPeople: unknown,
      ...(merged.battlefieldId && !unit ? { unknownBattlefield: merged.battlefieldId } : {}), label };
  };
  const scopeOf = (scope: Resolved) => ({ scope: scope.label, ...(scope.unknownPeople.length ? { unknownPeople: scope.unknownPeople } : {}),
    ...(scope.unknownBattlefield ? { unknownBattlefield: scope.unknownBattlefield } : {}) });

  return {
    async readMissionCards(args: ScopeArgs) {
      const scope = await resolve(args);
      const rows = (await q(`SELECT m.id, m.code, m.period, m.title, m.owner_id, m.battlefield_ids, m.outcome, m.time_boundary, m.milestones,
          m.success_evidence, m.key_path, m.risk, m.dependencies, m.placeholder, m.personal_mission_card_id, mr.status AS round_status
        FROM missions m LEFT JOIN personal_mission_cards pc ON pc.id = m.personal_mission_card_id LEFT JOIN mission_rounds mr ON mr.id = pc.round_id
        WHERE m.period BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR m.owner_id = ANY($3)) AND ($4::text IS NULL OR m.battlefield_ids @> jsonb_build_array($4::text))
          AND ($5::text IS NULL OR m.capability_id = $5)
        ORDER BY m.period DESC, m.owner_id, m.code, m.id LIMIT 400`, [scope.from, scope.to, scope.people, scope.battlefieldId, scope.capabilityId])).rows as Record<string, any>[];
      const fields = new Map((await loadBattlefields()).map((field) => [field.id, field.name]));
      let filtered = 0;
      const visible: Record<string, any>[] = [];
      for (const row of rows) {
        if (await canReadMission(q, row as { personal_mission_card_id: string | null }, { personId: viewer.personId, role: viewer.role === "ceo" ? "ceo" : "member" })) visible.push(row);
        else filtered += 1;
      }
      const missions = visible.slice(0, MAX_MISSIONS).map((row) => ({
        cite: `mission:${row.id}`, code: row.code, period: row.period, title: row.title, owner: nameOf(row.owner_id),
        battlefields: (row.battlefield_ids as string[]).map((id) => fields.get(id) ?? id),
        status: row.placeholder ? "占位" : row.personal_mission_card_id && row.round_status !== "confirmed" ? "任务卡准备中" : "已确定",
        outcome: clip(row.outcome, 600), timeBoundary: clip(row.time_boundary, 200), milestones: list(row.milestones, 6, 160),
        successEvidence: list(row.success_evidence, 5, 160), keyPath: clip(row.key_path, 400), risk: clip(row.risk, 300), dependencies: clip(row.dependencies, 300),
      }));
      return { ...scopeOf(scope), missions, total: visible.length, ...(visible.length > missions.length ? { truncated: visible.length - missions.length } : {}), filtered };
    },

    async readProgress(args: ScopeArgs & { taskId?: string }) {
      const scope = await resolve(args);
      const range = window(scope.from, scope.to);
      const taskId = args.taskId && /^[0-9a-f-]{36}$/i.test(args.taskId) ? args.taskId : null;
      const params = [range.start, range.end, scope.people, scope.battlefieldId, taskId, scope.from, scope.to, scope.capabilityId];
      // 依次查（q 可能是同一个连接）。
      const tasks = await q(`SELECT t.id, t.title, t.status, t.owner_id, t.due_date::text AS due_date, t.updated_at, t.mission_id, m.title AS mission_title, m.period, m.battlefield_ids
            FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id
           WHERE (m.period BETWEEN $6 AND $7 OR (t.mission_id IS NULL AND t.updated_at >= $1::timestamptz AND t.created_at < $2::timestamptz))
             AND ($3::text[] IS NULL OR t.owner_id = ANY($3)) AND ($4::text IS NULL OR m.battlefield_ids @> jsonb_build_array($4::text))
             AND ($8::text IS NULL OR m.capability_id = $8)
             AND ($5::uuid IS NULL OR t.id = $5) ORDER BY t.owner_id, m.period, t.step_order NULLS LAST, t.created_at LIMIT 400`, params);
      const updates = await q(`SELECT p.id, p.task_id, p.author_id, p.source, p.body, p.links, p.created_at, t.title AS task_title, t.owner_id AS task_owner, m.battlefield_ids
            FROM task_progress p JOIN tasks t ON t.id = p.task_id LEFT JOIN missions m ON m.id = t.mission_id
           WHERE p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz AND ($3::text[] IS NULL OR p.author_id = ANY($3) OR t.owner_id = ANY($3))
             AND ($4::text IS NULL OR m.battlefield_ids @> jsonb_build_array($4::text)) AND ($5::uuid IS NULL OR t.id = $5)
             AND ($8::text IS NULL OR m.capability_id = $8)
             AND $6::text IS NOT NULL AND $7::text IS NOT NULL
           ORDER BY p.created_at DESC, p.id LIMIT 600`, params);
      let filtered = 0;
      type Group = { person: string; tasks: unknown[]; updates: unknown[]; moreUpdates: number };
      const groups = new Map<string, Group>();
      const group = (personId: string) => {
        let found = groups.get(personId);
        if (!found) { found = { person: nameOf(personId), tasks: [], updates: [], moreUpdates: 0 }; groups.set(personId, found); }
        return found;
      };
      const STATUS: Record<string, string> = { not_started: "未开始", in_progress: "进行中", done: "已完成", returned: "已退回" };
      for (const row of tasks.rows as Record<string, any>[]) {
        if (!await access({ personId: row.owner_id, period: row.period ?? monthOf(row.updated_at), battlefieldIds: row.battlefield_ids ?? undefined })) { filtered += 1; continue; }
        group(row.owner_id).tasks.push({ cite: `task:${row.id}`, title: row.title, status: STATUS[row.status] ?? row.status, due: row.due_date, mission: row.mission_title ?? null });
      }
      for (const row of updates.rows as Record<string, any>[]) {
        if (!await access({ personId: row.task_owner, period: monthOf(row.created_at), battlefieldIds: row.battlefield_ids ?? undefined })) { filtered += 1; continue; }
        const target = group(row.task_owner);
        if (target.updates.length >= UPDATES_PER_PERSON) { target.moreUpdates += 1; continue; }
        target.updates.push({ cite: `task:${row.task_id}`, at: at(row.created_at), task: row.task_title, ...(row.author_id !== row.task_owner ? { by: nameOf(row.author_id) } : {}),
          body: clip(row.body, 400), links: (Array.isArray(row.links) ? row.links : []).slice(0, 3) });
      }
      const people = [...groups.values()].slice(0, MAX_PEOPLE_PROGRESS).map(({ moreUpdates, ...rest }) => ({ ...rest, ...(moreUpdates ? { moreUpdates } : {}) }));
      return { ...scopeOf(scope), people, ...(groups.size > people.length ? { truncatedPeople: groups.size - people.length } : {}), filtered,
        coverage: `进展记录截至 ${at(deps.now())}` };
    },

    async readReviews(args: ScopeArgs & { kind?: "monthly" | "weekly" | "all" }) {
      const scope = await resolve(args, { months: 3 });
      const kind = args.kind ?? "all";
      let filtered = 0;
      const out: { monthly: unknown[]; units: unknown[]; weekly: unknown[] } = { monthly: [], units: [], weekly: [] };
      const fieldsText = (review: Record<string, any> | null, limits: Record<string, number>) => Object.fromEntries(Object.entries(limits)
        .flatMap(([field, max]) => { const text = clip(review?.[field]?.text, max); return text ? [[field, text]] : []; }));
      if (kind !== "weekly") {
        const personal = (await q(`SELECT id, period, person_id, status, self_review FROM personal_reviews
            WHERE period BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR person_id = ANY($3)) AND self_review IS NOT NULL ORDER BY period DESC, person_id LIMIT 200`,
        [scope.from, scope.to, scope.people])).rows as Record<string, any>[];
        for (const row of personal) {
          if (row.person_id !== viewer.personId && row.status !== "submitted") continue;
          if (!await access({ personId: row.person_id, period: row.period })) { filtered += 1; continue; }
          out.monthly.push({ cite: `personal-review:${row.id}`, period: row.period, person: nameOf(row.person_id), status: row.status,
            ...fieldsText(row.self_review, { overall: 600, judgments: 400, nextFocus: 300, escalations: 300 }) });
        }
        // 战场 / 能力域复盘：限定了人时只取这些人负责的。
        const units = (await q(`SELECT i.id, i.review_id, i.subject_type, i.subject_id, i.owner_id, i.status, i.target, i.self_review, r.period,
              COALESCE(b.name, cap.name, i.subject_id) AS subject_name,
              (SELECT jsonb_agg(jsonb_build_object('author', c.author_id, 'body', c.body) ORDER BY c.created_at) FROM monthly_review_comments c WHERE c.item_id = i.id) AS comments
            FROM monthly_review_items i JOIN monthly_reviews r ON r.id = i.review_id
            LEFT JOIN battlefield_config b ON i.subject_type = 'battlefield' AND b.id = i.subject_id
            LEFT JOIN capability_config cap ON i.subject_type = 'capability' AND cap.id = i.subject_id
           WHERE r.period BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR i.owner_id = ANY($3)) AND ($4::text IS NULL OR (i.subject_type = 'battlefield' AND i.subject_id = $4))
             AND ($5::text IS NULL OR (i.subject_type = 'capability' AND i.subject_id = $5))
             AND i.self_review IS NOT NULL ORDER BY r.period DESC, i.subject_type, i.subject_id LIMIT 100`, [scope.from, scope.to, scope.people, scope.battlefieldId, scope.capabilityId])).rows as Record<string, any>[];
        for (const row of units) {
          if (row.owner_id !== viewer.personId && viewer.role !== "ceo" && !["submitted", "confirmed"].includes(row.status)) continue;
          const readable = row.subject_type === "battlefield"
            ? await access({ personId: row.owner_id, period: row.period, battlefieldIds: [row.subject_id] })
            : await canReadMonthlyReviewItem(q, viewer, row as { review_id: string; subject_type: "battlefield" | "capability"; subject_id: string; owner_id: string });
          if (!readable) { filtered += 1; continue; }
          out.units.push({ cite: `monthly-review-item:${row.id}`, period: row.period, unit: `${row.subject_type === "battlefield" ? "战场" : "能力域"} · ${row.subject_name}`,
            owner: nameOf(row.owner_id), status: row.status, target: clip(row.target, 300),
            ...fieldsText(row.self_review, { overall: 600, judgments: 400, nextFocus: 300, escalations: 300 }),
            ...(Array.isArray(row.comments) && row.comments.length ? { comments: row.comments.slice(-5).map((item: { author: string; body: string }) => ({ by: nameOf(item.author), body: clip(item.body, 300) })) } : {}) });
        }
      }
      if (kind !== "monthly") {
        const weekly = (await q(`SELECT id, person_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, status, body FROM weekly_reviews
            WHERE week_start >= ($1::date - 6) AND week_start < $2::date AND ($3::text[] IS NULL OR person_id = ANY($3)) AND body IS NOT NULL
            ORDER BY week_start DESC, person_id LIMIT 300`, [`${scope.from}-01`, `${shiftMonth(scope.to, 1)}-01`, scope.people])).rows as Record<string, any>[];
        for (const row of weekly) {
          const period = weekPeriod(row.week_start);
          if (period < scope.from || period > scope.to) continue;
          if (row.person_id !== viewer.personId && row.status !== "submitted") continue;
          if (!await access({ personId: row.person_id, period })) { filtered += 1; continue; }
          out.weekly.push({ cite: `weekly-review:${row.id}`, week: row.week_start, person: nameOf(row.person_id), status: row.status, text: clip(weeklyReviewText(row.body), 900) });
        }
      }
      const total = out.monthly.length + out.units.length + out.weekly.length;
      const cap = (items: unknown[], share: number) => items.slice(0, Math.max(10, Math.floor(MAX_REVIEWS * share)));
      const monthly = cap(out.monthly, 0.4), units = cap(out.units, 0.3), weekly = cap(out.weekly, 0.4);
      const shown = monthly.length + units.length + weekly.length;
      return { ...scopeOf(scope), monthly, units, weekly, ...(total > shown ? { truncated: total - shown } : {}), filtered };
    },

    async readObjectTree(args: { from?: string; direction: "up" | "down" | "side"; period?: string }) {
      const period = args.period && MONTH.test(args.period) ? args.period : deps.focus.period;
      const start = (args.from?.trim() || deps.focus.object || "company").replace(/^issue:.*/, "company");
      const fields = await loadBattlefields();
      const fieldName = (id: string) => fields.find((field) => field.id === id)?.name ?? id;
      const plan = (await q("SELECT status, company_outcome, battlefields FROM monthly_plans WHERE period = $1", [period])).rows[0] as
        { status: string; company_outcome: string; battlefields: { battlefieldId: string; outcome?: string }[] } | undefined;
      const monthTarget = (id: string) => (plan?.status === "confirmed" ? clip(plan.battlefields.find((item) => item.battlefieldId === id)?.outcome, 300) || null : null);
      const battlefieldNode = (field: (typeof fields)[number]) => ({ ref: `battlefield:${field.id}`, title: field.name, owner: nameOf(field.owner_id),
        longTermOutcome: clip(field.six_month_outcome, 300), monthTarget: monthTarget(field.id) });
      let filtered = 0;
      const missionsWhere = async (where: string, params: unknown[]) => {
        const rows = (await q(`SELECT m.id, m.title, m.code, m.owner_id, m.period, m.battlefield_ids, m.personal_mission_card_id FROM missions m WHERE ${where} ORDER BY m.code, m.id LIMIT 60`, params)).rows as Record<string, any>[];
        const visible = [];
        for (const row of rows) {
          if (await canReadMission(q, row as { personal_mission_card_id: string | null }, { personId: viewer.personId, role: viewer.role === "ceo" ? "ceo" : "member" })) visible.push(row);
          else filtered += 1;
        }
        return visible.map((row) => ({ ref: `mission:${row.id}`, cite: `mission:${row.id}`, title: row.title, code: row.code, owner: nameOf(row.owner_id), period: row.period }));
      };
      const tasksWhere = async (where: string, params: unknown[]) => {
        const rows = (await q(`SELECT t.id, t.title, t.status, t.owner_id, t.due_date::text AS due_date, t.updated_at, m.period, m.battlefield_ids
          FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id WHERE ${where} ORDER BY t.step_order NULLS LAST, t.created_at LIMIT 60`, params)).rows as Record<string, any>[];
        const visible = [];
        for (const row of rows) {
          if (await access({ personId: row.owner_id, period: row.period ?? monthOf(row.updated_at), battlefieldIds: row.battlefield_ids ?? undefined })) visible.push(row);
          else filtered += 1;
        }
        return visible.map((row) => ({ ref: `task:${row.id}`, cite: `task:${row.id}`, title: row.title, status: row.status, owner: nameOf(row.owner_id), due: row.due_date }));
      };
      const [type, ...rest] = start.split(":");
      const id = rest.join(":");
      const done = (node: { ref: string; title: string }, items: unknown[]) => ({ node, direction: args.direction, period, items, filtered });
      if (type === "company" || !id) {
        const strategy = (await q("SELECT ltco FROM company_strategy_config WHERE id = 'default'")).rows[0] as { ltco?: string } | undefined;
        const node = { ref: "company", title: "公司", longTermOutcome: clip(strategy?.ltco, 600), monthOutcome: plan?.status === "confirmed" ? clip(plan.company_outcome, 400) : null };
        return done(node, args.direction === "down" ? fields.map(battlefieldNode) : []);
      }
      if (type === "battlefield") {
        const field = fields.find((item) => item.id === id || item.name === id || item.code === id);
        if (!field) {
          const caps = await loadCapabilities();
          const cap = caps.find((item) => item.id === id || item.name === id || item.code === id);
          if (!cap) return { error: "NOT_FOUND", message: "没有这个战场或能力域" };
          const capNode = (item: (typeof caps)[number]) => ({ ref: `battlefield:${item.id}`, title: item.name, kind: "能力域" });
          if (args.direction === "up") return done(capNode(cap), [{ ref: "company", title: "公司" }]);
          if (args.direction === "side") return done(capNode(cap), caps.filter((item) => item.id !== cap.id).map(capNode));
          return done(capNode(cap), await missionsWhere("m.period = $1 AND m.capability_id = $2", [period, cap.id]));
        }
        if (args.direction === "up") return done(battlefieldNode(field), [{ ref: "company", title: "公司" }]);
        if (args.direction === "side") return done(battlefieldNode(field), fields.filter((item) => item.id !== field.id).map(battlefieldNode));
        return done(battlefieldNode(field), await missionsWhere("m.period = $1 AND m.battlefield_ids @> jsonb_build_array($2::text)", [period, field.id]));
      }
      if (type === "mission") {
        const mission = (await q("SELECT id, title, owner_id, period, battlefield_ids, personal_mission_card_id FROM missions WHERE id = $1", [id])).rows[0] as Record<string, any> | undefined;
        if (!mission || !await canReadMission(q, mission as { personal_mission_card_id: string | null }, { personId: viewer.personId, role: viewer.role === "ceo" ? "ceo" : "member" })) return { error: "NOT_FOUND", message: "没有这个 Mission 或看不到" };
        const node = { ref: `mission:${mission.id}`, title: mission.title, owner: nameOf(mission.owner_id), period: mission.period, battlefields: (mission.battlefield_ids as string[]).map(fieldName) };
        if (args.direction === "up") return done(node, fields.filter((field) => (mission.battlefield_ids as string[]).includes(field.id)).map(battlefieldNode));
        if (args.direction === "side") return done(node, (await missionsWhere("m.period = $1 AND m.battlefield_ids ?| $2::text[] AND m.id <> $3", [mission.period, mission.battlefield_ids, mission.id])));
        return done(node, await tasksWhere("t.mission_id = $1", [mission.id]));
      }
      if (type === "task") {
        const task = (await q(`SELECT t.id, t.title, t.owner_id, t.mission_id, t.updated_at, m.period, m.battlefield_ids FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id WHERE t.id::text = $1`, [id])).rows[0] as Record<string, any> | undefined;
        if (!task || !await access({ personId: task.owner_id, period: task.period ?? monthOf(task.updated_at), battlefieldIds: task.battlefield_ids ?? undefined })) return { error: "NOT_FOUND", message: "没有这件执行事项或看不到" };
        const node = { ref: `task:${task.id}`, title: task.title, owner: nameOf(task.owner_id) };
        if (args.direction === "up") return done(node, task.mission_id ? await missionsWhere("m.id = $1", [task.mission_id]) : []);
        if (args.direction === "side") return done(node, task.mission_id ? await tasksWhere("t.mission_id = $1 AND t.id <> $2", [task.mission_id, task.id]) : []);
        const progress = (await q("SELECT body, created_at, author_id FROM task_progress WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5", [task.id])).rows as Record<string, any>[];
        return done(node, progress.map((row) => ({ at: at(row.created_at), by: nameOf(row.author_id), body: clip(row.body, 300), cite: `task:${task.id}` })));
      }
      if (type === "person") {
        const person = deps.people.find((item) => item.personId === id || item.displayName === id);
        if (!person) return { error: "NOT_FOUND", message: "人员目录里没有这个人" };
        const node = { ref: `person:${person.personId}`, title: person.displayName };
        const members = (await q(`SELECT DISTINCT battlefield_id FROM (${BATTLEFIELD_MEMBERS}) x(person_id, battlefield_id) WHERE person_id = $1`, [person.personId, period])).rows
          .map((row) => row.battlefield_id as string);
        if (args.direction === "up") return done(node, fields.filter((field) => members.includes(field.id)).map(battlefieldNode));
        if (args.direction === "down") return done(node, await missionsWhere("m.period = $1 AND m.owner_id = $2", [period, person.personId]));
        const peers = (await q(`SELECT DISTINCT person_id FROM (${BATTLEFIELD_MEMBERS}) x(person_id, battlefield_id) WHERE battlefield_id = ANY($1::text[])`, [members, period])).rows
          .map((row) => row.person_id as string).filter((personId) => personId !== person.personId);
        return done(node, peers.map((personId) => ({ ref: `person:${personId}`, title: nameOf(personId) })));
      }
      return { error: "BAD_START", message: "起点写 company、battlefield:<id>、mission:<id>、task:<id> 或 person:<姓名>" };
    },
  };
}
export type CompanyMap = ReturnType<typeof createCompanyMap>;
