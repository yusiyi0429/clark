import type { TDecisionHistoryChange, TDecisionHistoryEntry, TDecisionHistoryPending, TIssueDecisionHistory } from "@warmap/contracts";
import { knowledgeName, materialTitle } from "@/lib/displayText";

/**
 * 依据（sourceRef）→ 给 CEO 看的名字和点下去打开什么（feedback 14 / H07）。
 *
 * 预审条目、历史决定、执行变化里的来源都是这一套 ref；这里只做解析和定位，不发请求：
 * - `material:<id>@v<n>[#p<k>]` 群材料当时那一版（可带段落）；`material:<id>` 旧会前材料；
 * - `discussion:<messageId>` 群讨论发言；`decision:<id>` 已确认的历史决定；`fact:` 执行事实；`feedback:` 阶段反馈；
 * - `signal:<id>` 外部信号；`outcome:<meetingId>#<itemId>` 会后条目；`transcript:<meetingId>[#<turnId>]` 逐字稿（可带发言段）；`meeting:` / `issue:` / `research:` / `memory:`（企业知识章节）；
 * - `chat:<会话>#<序号>` 本人以前说过的原话；`pmem:<id>` 本人的一条个人记忆（只有本人可见）。
 * 名字里不出现内部编号；认不出的来源写「其他来源」，不把原始 ref 摆给 CEO。
 */

export type ParsedSource =
  | { kind: "material"; ref: string; id: string; version: number; paragraph: number | null }
  | { kind: "legacy-material"; ref: string; id: string }
  | { kind: "discussion"; ref: string; messageId: number }
  | { kind: "decision"; ref: string; id: string }
  | { kind: "fact"; ref: string; id: string }
  | { kind: "feedback"; ref: string; id: string }
  | { kind: "signal"; ref: string; id: string }
  | { kind: "outcome"; ref: string; meetingId: string; itemId: string | null }
  | { kind: "meeting"; ref: string; id: string }
  | { kind: "transcript"; ref: string; meetingId: string; turnId: string | null }
  | { kind: "issue"; ref: string; id: string }
  | { kind: "research"; ref: string; issueId: string }
  | { kind: "memory"; ref: string; file: string; section: number | null }
  | { kind: "chat"; ref: string; conversationId: string; sequence: number }
  | { kind: "pmem"; ref: string; id: string }
  | { kind: "unknown"; ref: string };

const MATERIAL_VERSION = /^material:([^@#\s]+)@v(\d+)(?:#p(\d+))?$/;

export function parseSourceRef(ref: string): ParsedSource {
  const material = MATERIAL_VERSION.exec(ref);
  if (material) return { kind: "material", ref, id: material[1], version: Number(material[2]), paragraph: material[3] ? Number(material[3]) : null };
  const colon = ref.indexOf(":");
  if (colon <= 0) return { kind: "unknown", ref };
  const kind = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  if (!rest) return { kind: "unknown", ref };
  switch (kind) {
    case "material": return /[@#\s]/.test(rest) ? { kind: "unknown", ref } : { kind: "legacy-material", ref, id: rest };
    case "discussion": return /^\d+$/.test(rest) ? { kind: "discussion", ref, messageId: Number(rest) } : { kind: "unknown", ref };
    case "decision": return { kind: "decision", ref, id: rest };
    case "fact": return { kind: "fact", ref, id: rest };
    case "feedback": return { kind: "feedback", ref, id: rest };
    case "signal": return { kind: "signal", ref, id: rest };
    case "outcome": {
      const hash = rest.indexOf("#");
      return hash === -1 ? { kind: "outcome", ref, meetingId: rest, itemId: null }
        : { kind: "outcome", ref, meetingId: rest.slice(0, hash), itemId: rest.slice(hash + 1) || null };
    }
    case "meeting": return { kind: "meeting", ref, id: rest };
    case "transcript": {
      const hash = rest.indexOf("#");
      return hash === -1 ? { kind: "transcript", ref, meetingId: rest, turnId: null }
        : { kind: "transcript", ref, meetingId: rest.slice(0, hash), turnId: rest.slice(hash + 1) || null };
    }
    case "issue": return { kind: "issue", ref, id: rest };
    case "research": return { kind: "research", ref, issueId: rest };
    case "memory": {
      const match = /^(.*?)(?:#s(\d+))?(?:#p\d+)?$/.exec(rest);
      return { kind: "memory", ref, file: match?.[1] || rest, section: match?.[2] ? Number(match[2]) : null };
    }
    case "chat": {
      const match = /^([^#\s]+)#(\d+)$/.exec(rest);
      return match ? { kind: "chat", ref, conversationId: match[1], sequence: Number(match[2]) } : { kind: "unknown", ref };
    }
    case "pmem": return /^[^\s#:]+$/.test(rest) ? { kind: "pmem", ref, id: rest } : { kind: "unknown", ref };
    default: return { kind: "unknown", ref };
  }
}

/** 历史分层里一条 ref 落在哪个议题、哪一层（decision/outcome 在决定层，feedback/fact/discussion/material/signal 在变化层）。 */
export type HistoryHit =
  | { issueId: string; layer: "effective" | "inactive"; entry: TDecisionHistoryEntry }
  | { issueId: string; layer: "change"; change: TDecisionHistoryChange }
  | { issueId: string; layer: "pending"; pending: TDecisionHistoryPending };

export type HistoryIndex = Map<string, HistoryHit[]>;

export function buildHistoryIndex(histories: TIssueDecisionHistory[]): HistoryIndex {
  const index: HistoryIndex = new Map();
  const add = (ref: string, hit: HistoryHit) => index.set(ref, [...(index.get(ref) ?? []), hit]);
  for (const history of histories) {
    for (const entry of history.effective) add(entry.ref, { issueId: history.issueId, layer: "effective", entry });
    for (const entry of history.inactive) add(entry.ref, { issueId: history.issueId, layer: "inactive", entry });
    for (const change of history.changes) add(change.ref, { issueId: history.issueId, layer: "change", change });
    for (const pending of history.pending) add(pending.ref, { issueId: history.issueId, layer: "pending", pending });
  }
  return index;
}

/** 同一条 ref 可能同时在两个议题的历史里：优先当前议题。 */
export function historyHit(index: HistoryIndex, ref: string, issueId?: string | null): HistoryHit | null {
  const hits = index.get(ref);
  if (!hits?.length) return null;
  return hits.find((hit) => hit.issueId === issueId) ?? hits[0];
}

/** 页面里锚点的 id：议题块、历史条目、会后条目都按这个规则生成，定位时用同一个函数找。 */
export const issueAnchorId = (issueId: string) => `issue-${slug(issueId)}`;
export const historyAnchorId = (issueId: string, ref: string) => `history-${slug(issueId)}-${slug(ref)}`;
export const outcomeAnchorId = (itemId: string) => `outcome-${slug(itemId)}`;
export const sectionAnchorId = (issueId: string, section: string) => `issue-${slug(issueId)}-${section}`;
/** 逐字稿里一段发言（components/meeting/TranscriptReader 的行 id）。 */
export function transcriptTurnAnchorId(turnId: string): string {
  return `turn-${turnId}`;
}
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export type SourceMaterial = { objectType: "meeting" | "issue"; objectId: string; fileName: string; format?: string; version?: number; state?: string };
/** 会前上传的旧材料（meetings.materials）：没有版本和段落，按会议材料预览打开。 */
export type LegacyMaterial = { id: string; fileName: string; mimeType: string; sizeBytes: number; pageCount?: number; providedBy?: string | null; uploadedAt: string };

/** 解析时用到的页面事实：都来自已载入的 Card、预审快照和历史分层，不另发请求。 */
export type SourceContext = {
  meetingId: string | null;
  issueIds: string[];
  issueTitle: (issueId: string) => string | undefined;
  /** 预审快照里的群材料：id → 属于哪个对象、文件名、用的版本。 */
  materials: Map<string, SourceMaterial>;
  /** 材料现在已到第几版（报告之后的变化）；不知道就没有。 */
  currentVersions: Map<string, number>;
  legacyMaterials: Map<string, LegacyMaterial>;
  history: HistoryIndex;
  meetings: Map<string, string>;
};

export function emptySourceContext(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    meetingId: null, issueIds: [], issueTitle: () => undefined, materials: new Map(), currentVersions: new Map(),
    legacyMaterials: new Map(), history: new Map(), meetings: new Map(), ...overrides,
  };
}

const VIA_SHORT: Record<TDecisionHistoryEntry["confirmedVia"], string> = {
  "issue.decide": "决定", "issue.decide_override": "决定", "meeting.confirm_item": "会后确认", imported: "历史纪要",
};

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" });
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 依据的名字：材料写文件名、第几版、第几段；发言写谁、哪天；决定写日子和一小段原文。 */
export function sourceLabel(ref: string, context: SourceContext, issueId?: string | null): string {
  const parsed = parseSourceRef(ref);
  switch (parsed.kind) {
    case "material": {
      const material = context.materials.get(parsed.id);
      const hit = historyHit(context.history, ref, issueId);
      const name = material?.fileName ?? (hit?.layer === "change" ? /《(.+?)》/.exec(hit.change.text)?.[1] : undefined);
      const current = context.currentVersions.get(parsed.id);
      return [name ? `《${materialTitle(name)}》` : "群材料", `第 ${parsed.version} 版`, parsed.paragraph ? `第 ${parsed.paragraph} 段` : null,
        current && current > parsed.version ? "已有新版" : null].filter(Boolean).join(" · ");
    }
    case "legacy-material": {
      const material = context.legacyMaterials.get(parsed.id);
      return material ? `《${materialTitle(material.fileName)}》` : "会前材料";
    }
    case "discussion": {
      const hit = historyHit(context.history, ref, issueId);
      if (hit?.layer === "change") return ["群讨论", hit.change.author?.displayName, shortDate(hit.change.at)].filter(Boolean).join(" · ");
      return "群讨论发言";
    }
    case "decision": {
      const hit = historyHit(context.history, ref, issueId);
      if (hit && (hit.layer === "effective" || hit.layer === "inactive")) {
        const state = hit.layer === "inactive" ? (hit.entry.status === "superseded" ? "已被替代的决定" : "已撤回的决定") : `${shortDate(hit.entry.decidedAt)} ${VIA_SHORT[hit.entry.confirmedVia]}`;
        return `${state.trim()}「${clip(hit.entry.text, 14)}」`;
      }
      return "历史决定";
    }
    case "fact": {
      const hit = historyHit(context.history, ref, issueId);
      return hit?.layer === "change" ? `执行事实 · ${shortDate(hit.change.at)}` : "执行事实";
    }
    case "feedback": {
      const hit = historyHit(context.history, ref, issueId);
      return hit?.layer === "change" ? `阶段反馈 · ${shortDate(hit.change.at)}` : "阶段反馈";
    }
    case "signal": {
      const hit = historyHit(context.history, ref, issueId);
      return hit?.layer === "change" ? `外部信号 · ${clip(hit.change.sourceRef, 16)}` : "外部信号";
    }
    case "outcome": {
      if (parsed.meetingId === context.meetingId) return parsed.itemId ? "这场会的会后条目" : "这场会的会后结论";
      const title = context.meetings.get(parsed.meetingId);
      return title ? `会议「${clip(title, 16)}」的结论` : "关联会议的结论";
    }
    case "meeting": {
      if (parsed.id === context.meetingId) return "当前会议";
      const title = context.meetings.get(parsed.id);
      return title ? `会议「${clip(title, 16)}」` : "关联会议";
    }
    case "transcript": {
      if (parsed.meetingId === context.meetingId) return "这场会的会议记录";
      const title = context.meetings.get(parsed.meetingId);
      return title ? `会议记录「${clip(title, 14)}」` : "关联会议记录";
    }
    case "issue": {
      const title = context.issueTitle(parsed.id);
      return title ? `议题「${clip(title, 16)}」` : "关联议题";
    }
    case "research": {
      const title = context.issueTitle(parsed.issueId);
      return title ? `议题预研「${clip(title, 12)}」` : "议题预研";
    }
    case "memory": {
      // 内部文件名（kd-*）换成中文名，不把 ID 摆给 CEO。
      return `《${knowledgeName(parsed.file)}》${parsed.section ? `第 ${parsed.section} 节` : ""}`;
    }
    case "chat": return "原话";
    case "pmem": return "个人记忆";
    default: return "其他来源";
  }
}

/**
 * 点下去去哪：
 * - anchor：同一页里的议题块 / 历史条目 / 会后条目，滚过去并闪一下，可以一键回到刚才的位置；
 * - material / legacy-material / discussion / detail：在侧边的「依据」抽屉里打开，关上回到原处；
 * - route：另一个页面（外部信号、别的会议、别的议题）；
 * - record：切到本场的会议记录（带 turnId 时定位到那一段发言）；none：当前会议本身，不是可打开的东西。
 */
export type SourceTarget =
  | { type: "anchor"; anchorId: string; fallback?: SourceTarget }
  | { type: "material"; ref: string; materialId: string; version: number; paragraph: number | null; material: SourceMaterial | null }
  | { type: "legacy-material"; materialId: string; material: LegacyMaterial }
  | { type: "discussion"; ref: string; messageId: number; change: TDecisionHistoryChange | null }
  | { type: "detail"; ref: string; hit: HistoryHit | null; parsed: ParsedSource }
  | { type: "route"; href: string }
  | { type: "record"; turnId?: string }
  | { type: "none" };

export function sourceTarget(ref: string, context: SourceContext, issueId?: string | null): SourceTarget {
  const parsed = parseSourceRef(ref);
  const hit = historyHit(context.history, ref, issueId);
  const historyAnchor = hit ? { type: "anchor" as const, anchorId: historyAnchorId(hit.issueId, ref) } : null;
  switch (parsed.kind) {
    case "material":
      return { type: "material", ref, materialId: parsed.id, version: parsed.version, paragraph: parsed.paragraph, material: context.materials.get(parsed.id) ?? null };
    case "legacy-material": {
      const material = context.legacyMaterials.get(parsed.id);
      return material ? { type: "legacy-material", materialId: parsed.id, material } : { type: "none" };
    }
    case "discussion":
      return { type: "discussion", ref, messageId: parsed.messageId, change: hit?.layer === "change" ? hit.change : null };
    case "decision":
      return historyAnchor ? { ...historyAnchor, fallback: { type: "detail", ref, hit, parsed } } : { type: "detail", ref, hit, parsed };
    case "fact":
    case "feedback":
      return historyAnchor ? { ...historyAnchor, fallback: { type: "detail", ref, hit, parsed } } : { type: "detail", ref, hit, parsed };
    case "signal":
      return { type: "route", href: `/radar/signals/${encodeURIComponent(parsed.id)}` };
    case "outcome":
      if (parsed.meetingId === context.meetingId) return parsed.itemId ? { type: "anchor", anchorId: outcomeAnchorId(parsed.itemId), fallback: { type: "record" } } : { type: "record" };
      if (historyAnchor) return { ...historyAnchor, fallback: { type: "route", href: `/meetings/${encodeURIComponent(parsed.meetingId)}` } };
      return { type: "route", href: `/meetings/${encodeURIComponent(parsed.meetingId)}` };
    case "meeting":
      return parsed.id === context.meetingId ? { type: "none" } : { type: "route", href: `/meetings/${encodeURIComponent(parsed.id)}` };
    case "transcript": {
      const { meetingId, turnId } = parsed;
      if (meetingId === context.meetingId) return turnId ? { type: "anchor", anchorId: transcriptTurnAnchorId(turnId), fallback: { type: "record", turnId } } : { type: "record" };
      return { type: "route", href: `/meetings/${encodeURIComponent(meetingId)}?meetingAction=transcript${turnId ? `&turn=${encodeURIComponent(turnId)}` : ""}` };
    }
    case "issue":
      return context.issueIds.includes(parsed.id) ? { type: "anchor", anchorId: issueAnchorId(parsed.id), fallback: { type: "route", href: `/issues/${encodeURIComponent(parsed.id)}` } }
        : { type: "route", href: `/issues/${encodeURIComponent(parsed.id)}` };
    case "research":
      return context.issueIds.includes(parsed.issueId) ? { type: "anchor", anchorId: sectionAnchorId(parsed.issueId, "evidence"), fallback: { type: "route", href: `/issues/${encodeURIComponent(parsed.issueId)}` } }
        : { type: "route", href: `/issues/${encodeURIComponent(parsed.issueId)}` };
    case "memory":
      return { type: "detail", ref, hit: null, parsed };
    default:
      return { type: "none" };
  }
}

/** 一条 ref 指向哪个关联议题（用于把预审条目放进对应议题块）；指不出或指向多个时返回 null。 */
export function refIssueId(ref: string, context: SourceContext): string | null {
  const parsed = parseSourceRef(ref);
  const inMeeting = (id: string | undefined) => (id && context.issueIds.includes(id) ? id : null);
  switch (parsed.kind) {
    case "issue": return inMeeting(parsed.id);
    case "research": return inMeeting(parsed.issueId);
    case "material": {
      const material = context.materials.get(parsed.id);
      if (material?.objectType === "issue") return inMeeting(material.objectId);
      break;
    }
    default: break;
  }
  const hits = context.history.get(ref) ?? [];
  const issues = [...new Set(hits.map((hit) => hit.issueId))].filter((id) => context.issueIds.includes(id));
  return issues.length === 1 ? issues[0] : null;
}
