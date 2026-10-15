/**
 * 首页全局摘要按问题筛选战场（10/13 第二轮减负）。
 *
 * 改前每一轮都把三个战场的全部信息（长期目标、本月目标、战役、复盘进展、各战场的待决议题）整包放进上下文。
 * 现在先定本轮涉及哪些战场，只展开这些战场的完整信息，其余战场在 otherBattlefields 里各写一行（名称、状态、待决议题数）：
 * - 当前页面所在的战场（战场页发来的消息开头带「正在讨论战场…战场id=…」）、引用卡片与当前对象所在的战场一定展开；
 * - 问题里点名的战场（名称、编号）展开；分诊模型给的战场展开；
 * - 问到集团整体、几个战场之间的比较，或分诊说涉及全部，退回全量；
 * - 分诊没有结果（失败、超时、规则直接定档没叫分诊）且上面都没有命中时，判断不出，退回全量；
 * - 分诊明确说不针对任何战场：检索问答、快答只给一行摘要；深度档仍退回全量（重要的战略问题宁可多带）。
 * 漏带的信息由模型用 get_warmap_overview（battlefieldId）补读，系统提示里写明了这一点。
 * 筛选不改写任何字段内容，只删减与合并：月度计划里各战场的本月目标与 battlefields[].monthOutcome 逐字相同，只保留一份。
 */

export type BattlefieldBrief = { id: string; code?: string; name: string };
/** 本轮展开的战场：all 是全量；数组是只展开这些战场（可以为空：不针对任何战场）。 */
export type BattlefieldFocus = "all" | string[];
/** 分诊给的战场：all、战场 id（或名称、编号）数组，没有结果时 undefined。 */
export type TriageBattlefields = "all" | string[] | undefined;

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : []);

/** 全局摘要里的战场清单（id、编号、名称）。 */
export function battlefieldBriefs(context: Record<string, unknown> | null | undefined): BattlefieldBrief[] {
  return rows(context?.battlefields).flatMap((item) => (typeof item.id === "string" && typeof item.name === "string"
    ? [{ id: item.id, name: item.name, ...(typeof item.code === "string" ? { code: item.code } : {}) }] : []));
}

/** 战场 id、编号或名称（不分大小写）对应到战场 id；对不上返回 undefined。 */
export function resolveBattlefieldId(value: string, briefs: BattlefieldBrief[]): string | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  return briefs.find((item) => item.id.toLowerCase() === text || item.code?.toLowerCase() === text || item.name.toLowerCase() === text)?.id;
}

/** 战场页发来的消息开头的页面上下文：「【页面】正在讨论战场「名称」（编号，战场id=xxx）」。 */
const PAGE_BATTLEFIELD = /^(?:【页面】)?正在讨论战场「[^」\n]+」（[^\n]*战场id=([^）\s，,]+)）/u;
export function pageBattlefield(message: string): string | undefined {
  return PAGE_BATTLEFIELD.exec(message)?.[1];
}

/** 去掉页面上下文与附件，只看一号位这一轮说的话。 */
function spokenText(message: string): string {
  return message.split(/\n\n\[附件 /)[0].replace(/^【页面】[^\n]*\n+/u, "").replace(PAGE_BATTLEFIELD, "").trim();
}

/** 问题里点名的战场：中文名直接包含；编号、拉丁字母的名称和 id 按词边界匹配（避免「tk」命中别的英文词）。 */
export function mentionedBattlefields(message: string, briefs: BattlefieldBrief[]): string[] {
  const text = spokenText(message);
  const hit = (word: string | undefined) => {
    if (!word || word.length < 2) return false;
    if (/[一-龥]/.test(word)) return text.includes(word);
    return new RegExp(`(^|[^A-Za-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text);
  };
  return briefs.filter((item) => hit(item.name) || hit(item.code) || hit(item.id)).map((item) => item.id);
}

/** 问到集团整体或几个战场之间的比较：全量。 */
const ALL_BATTLEFIELDS_ASK = /((三|几|两|3|2)\s*个|各个|所有|全部|每个|哪个|哪些|各)战场|战场(之间|间|对比|比较|排序|排名)|集团|整体|全局|全盘|全公司|公司层面/;
export function asksAllBattlefields(message: string): boolean {
  return ALL_BATTLEFIELDS_ASK.test(spokenText(message));
}

/**
 * 引用卡片、当前对象和消息里引用块里出现的战场：battlefieldId、battlefield_ids、relatedBattlefieldIds、objectRef.type=battlefield，
 * 以及引用了待决议题时该议题所在的战场。只认已知的战场 id。
 */
export function referencedBattlefields(values: unknown[], known: Set<string>, issueBattlefield?: (issueId: string) => string | undefined): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && known.has(value)) found.add(value); };
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) walk(item, depth + 1); return; }
    const row = value as Row;
    add(row.battlefieldId);
    for (const key of ["battlefield_ids", "battlefieldIds", "relatedBattlefieldIds"]) if (Array.isArray(row[key])) (row[key] as unknown[]).forEach(add);
    if ((row.type === "battlefield" || row.objectType === "battlefield") && typeof (row.id ?? row.objectId) === "string") add(row.id ?? row.objectId);
    if ((row.type === "issue" || row.objectType === "issue") && issueBattlefield && typeof (row.id ?? row.objectId) === "string") add(issueBattlefield(String(row.id ?? row.objectId)));
    for (const child of Object.values(row)) walk(child, depth + 1);
  };
  values.forEach((value) => walk(value, 0));
  return [...found];
}

/** 消息里的引用块（「[天枢引用上下文 v1]」后接 JSON）解析出来，读不出就是空数组。 */
export function messageQuotes(message: string): unknown[] {
  const index = message.indexOf("[天枢引用上下文 v1]\n");
  if (index < 0) return [];
  try {
    const value = JSON.parse(message.slice(index + "[天枢引用上下文 v1]\n".length)) as { quotes?: unknown };
    return Array.isArray(value.quotes) ? value.quotes : [];
  } catch {
    return [];
  }
}

/** 定本轮展开哪些战场，规则见文件头注释。 */
export function resolveFocus(input: {
  message: string; tier: "quick" | "grounded" | "deep"; triage: TriageBattlefields; briefs: BattlefieldBrief[];
  pinned?: string[];
}): BattlefieldFocus {
  if (!input.briefs.length) return "all";
  if (asksAllBattlefields(input.message) || input.triage === "all") return "all";
  const ids = new Set<string>([...(input.pinned ?? []), ...mentionedBattlefields(input.message, input.briefs)]);
  for (const value of input.triage ?? []) { const id = resolveBattlefieldId(value, input.briefs); if (id) ids.add(id); }
  if (ids.size >= input.briefs.length) return "all";
  if (ids.size) return input.briefs.map((item) => item.id).filter((id) => ids.has(id));
  if (input.triage === undefined) return "all";
  return input.tier === "deep" ? "all" : [];
}

const LIGHT_LABELS: Record<string, string> = { red: "红灯", yellow: "黄灯", green: "绿灯" };

/** 一个战场的状态：状态灯，或战役的状态分布；都没有时写「未登记状态灯」。 */
function battlefieldStatus(battlefield: Row, missions: Row[]): string {
  const judgment = battlefield.judgment as Row | undefined;
  const light = (judgment?.light ?? battlefield.light) as string | undefined;
  if (light && LIGHT_LABELS[light]) {
    const text = typeof judgment?.text === "string" ? `，${judgment.text.slice(0, 30)}` : "";
    return `${LIGHT_LABELS[light]}${text}`;
  }
  if (missions.length) {
    const counts = new Map<string, number>();
    for (const mission of missions) { const label = String(mission.statusLabel ?? mission.status ?? "未知"); counts.set(label, (counts.get(label) ?? 0) + 1); }
    return `战役 ${missions.length} 个（${[...counts].map(([label, count]) => `${label} ${count}`).join("、")}）`;
  }
  return "未登记状态灯";
}

const issueBattlefieldOf = (issue: Row): string | undefined => {
  const location = issue.location as Row | undefined;
  return location?.level === "battlefield" && typeof location.battlefieldId === "string" ? location.battlefieldId : undefined;
};

/** 待决议题所在的战场（只认战场级议题）。 */
export function pendingIssueBattlefield(context: Record<string, unknown> | null | undefined, issueId: string): string | undefined {
  const issue = rows(context?.pendingIssues).find((item) => item.id === issueId);
  return issue ? issueBattlefieldOf(issue) : undefined;
}

/** 月度计划里各战场的本月目标与 battlefields[].monthOutcome 逐字相同：只留战场清单里没有的那几项。 */
function compactPlan(context: Record<string, unknown>): Record<string, unknown> {
  const plan = context.monthlyPlan as Row | null | undefined;
  if (!plan || !Array.isArray(plan.battlefields)) return context;
  const listed = new Map(rows(context.battlefields).map((item) => [item.id, item.monthOutcome]));
  const rest = rows(plan.battlefields).filter((item) => !listed.has(item.battlefieldId) || listed.get(item.battlefieldId) !== item.outcome);
  const { battlefields: _drop, ...others } = plan;
  return { ...context, monthlyPlan: { ...others, ...(rest.length ? { battlefields: rest } : {}), battlefieldOutcomes: "见 battlefields[].monthOutcome" } };
}

/** 按本轮展开的战场筛选全局摘要；all 时只去掉月度计划里重复的本月目标。 */
export function focusGlobalContext(context: Record<string, unknown>, focus: BattlefieldFocus): Record<string, unknown> {
  const compact = compactPlan(context);
  if (focus === "all") return compact;
  const keep = new Set(focus);
  const battlefields = rows(compact.battlefields);
  const missionsOf = (id: unknown) => rows(rows(compact.battlefieldMissions).find((item) => item.battlefieldId === id)?.missions);
  const issues = rows(compact.pendingIssues);
  const otherBattlefields = battlefields.filter((item) => !keep.has(String(item.id))).map((item) => {
    const pending = issues.filter((issue) => issueBattlefieldOf(issue) === item.id).length;
    return `${String(item.name)}（id=${String(item.id)}）：${battlefieldStatus(item, missionsOf(item.id))}；待决议题 ${pending} 项`;
  });
  const byBattlefield = (key: string) => (Array.isArray(compact[key]) ? { [key]: rows(compact[key]).filter((item) => keep.has(String(item.battlefieldId))) } : {});
  return {
    ...compact,
    focus: {
      expanded: battlefields.filter((item) => keep.has(String(item.id))).map((item) => String(item.name)),
      pendingIssueTotal: issues.length,
    },
    battlefields: battlefields.filter((item) => keep.has(String(item.id))),
    otherBattlefields,
    pendingIssues: issues.filter((issue) => { const id = issueBattlefieldOf(issue); return !id || keep.has(id); }),
    ...byBattlefield("battlefieldMissions"),
    ...byBattlefield("battlefieldProgress"),
  };
}
