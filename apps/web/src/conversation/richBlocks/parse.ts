/** 完成度色阶：≥80% good、≥50% steady、其余 low，没有进度 none。 */
export type CompletionBand = "good" | "steady" | "low" | "none";
function completionBand({ ratio }: { ratio: number }): CompletionBand {
  if (ratio <= 0) return "none";
  if (ratio >= 0.8) return "good";
  if (ratio >= 0.5) return "steady";
  return "low";
}
import { parseVisual, partialVisualTitle, svgFit, type VisualBlock } from "./visualSandbox";

/**
 * 对话里的富内容块（第一批，docs/superpowers/specs/2026-10-10-discussion-desk-design.md「对话里的富内容块」）：
 * 模型不写界面代码，只在回答里输出声明式代码块，前端用自有组件渲染（与 ```options 同一模式）。
 *
 * ```metric-compare
 * {"title":"三条收入线 · 本季度","unit":"万元/季度","items":[{"label":"咨询服务收入","current":180,"target":300}]}
 * ```
 *
 * ```timeline
 * {"title":"到长期目标","now":"2026-10-13","items":[{"date":"2026-10-15","label":"目标确认会","kind":"milestone"}]}
 * ```
 *
 * ```roadmap（多泳道路线图，几条主线共用一条时间轴；版式在 roadmapLayout.ts）
 * {"title":"到春节前","now":"2026-10-14","lanes":[{"label":"灯塔客户","items":[{"label":"部署","start":"2026-10","end":"2026-11-30","status":"planned"}]}]}
 * ```
 *
 * ```visual（模型自己写的 SVG / 只带内联样式的 HTML，清洗后进沙箱 iframe；见 visualSandbox.ts）
 * <svg viewBox="0 0 480 240" aria-label="集团与子公司">…</svg>
 * ```
 *
 * 公式不走代码块：$$…$$ / $…$ 由 remark-math + rehype-katex 渲染。
 * 这里只放纯函数：解析与校验（不合法一律 null，界面退回原文）、完成度与色阶、日期中文写法、缩略卡判定与摘要。
 */

export const RICH_LANGUAGES = ["metric-compare", "timeline", "roadmap", "visual"] as const;
export type RichLanguage = (typeof RICH_LANGUAGES)[number];

export const isRichLanguage = (value: string | null | undefined): value is RichLanguage =>
  (RICH_LANGUAGES as readonly string[]).includes(value ?? "");

/*
 * 显示规范（所有图形、图表类富内容块都按这一条，之后新增的也一样；全文见
 * docs/superpowers/specs/2026-10-10-discussion-desk-design.md「富内容块的显示规范」）：
 * 1. 宽度 = 正文栏宽度（width:100%，不设固定上限），收起态、展开态、首页对话层、手机 sheet 都一样，与正文左右对齐；
 * 2. 内容在宽度里自适应：先压缩间距，再换行（最多 TIMELINE_MAX_ROWS 行）；实在放不下才横向滚动，
 *    滚动时两侧有渐隐、下方一行「左右滑动查看全部 N 个…」；
 * 3. 收起态（右列约 420）大块显示缩略卡（isLargeBlock），点开去放大 / 底部 sheet；
 * 4. 字号只用 16（数值）/ 13（名称、正文）/ 12（标签、提示）与标题 14 / 600，颜色沿用首页战况面的色阶，不加新颜色；
 * 5. JSON 整块到齐才解析（parseRichBlock 用 JSON.parse）：流式中没收全画骨架，不逐个节点画出来。
 *    visual 不是 JSON：所在的那一块还在流式中就一直画骨架，整块到齐（后面有了下一块，或流式结束）才渲染；
 * 6. roadmap：时间轴按栏宽压缩（刻度按 1 / 2 / 3 / 6 / 12 个月抽稀），同一泳道里重叠的项分到 2–3 行；
 *    每月不到 ROADMAP_MONTH_MIN、或某条泳道要超过 3 行才放得下时，才加宽成横向滚动（渐隐 + 提示）。
 *    状态不加新颜色：已确认蓝色实线、计划灰色实线、推断灰色虚线；「现在」一条蓝色竖线；
 * 7. visual：外框同一套；SVG 按栏宽缩放（最多缩到 0.8、放大到 1.25 倍），再窄在框里横向滚动；HTML 按栏宽自适应。
 */
/** 时间线超过这么多节点默认算大块（收起态显示缩略卡）。 */
export const TIMELINE_INLINE_MAX = 3;
/** 一个时间线节点舒展时的宽度：排得下日期与两行名称。横向滚动时每个节点按这个宽度排。 */
export const TIMELINE_NODE_MIN = 112;
/** 压缩后一个节点最少这么宽（名称每行约 6 个字，两行截断）。 */
export const TIMELINE_NODE_COMPACT = 88;
/** 时间线最多换成几行；再多就改成一行横向滚动。 */
export const TIMELINE_MAX_ROWS = 3;
/** 块高超过对话区这个比例算大块。 */
export const LARGE_HEIGHT_RATIO = 0.6;

const TEXT_MAX = 40;
const NOTE_MAX = 60;

export type MetricItem = { label: string; current: number; target: number; unit?: string; note?: string };
export type MetricCompareBlock = { kind: "metric-compare"; title?: string; unit?: string; items: MetricItem[] };

export type TimelineKind = "milestone" | "deadline" | "now";
export type DateParts = { year: number; month: number; day?: number };
export type TimelineItem = { date: DateParts; label: string; kind: TimelineKind };
export type TimelineBlock = { kind: "timeline"; title?: string; now?: DateParts; items: TimelineItem[] };

export type RoadmapStatus = "confirmed" | "planned" | "inferred";
/** 一项：只有 start 是单点（日期），有 end 是一段（含 end 那一天；只到月的 end 算到月底）。 */
export type RoadmapItem = { label: string; status: RoadmapStatus; start: DateParts; end?: DateParts };
export type RoadmapLane = { label: string; items: RoadmapItem[] };
export type RoadmapBlock = { kind: "roadmap"; title?: string; now?: DateParts; lanes: RoadmapLane[] };

export type { VisualBlock } from "./visualSandbox";
export type RichBlock = MetricCompareBlock | TimelineBlock | RoadmapBlock | VisualBlock;

/** 路线图：泳道 1–6 条，每条 1–8 项，合计不超过 32 项。 */
export const ROADMAP_LANES_MAX = 6;
export const ROADMAP_ITEMS_MAX = 8;
export const ROADMAP_TOTAL_MAX = 32;
/** 收起态：泳道超过 2 条或项数超过 6 算大块（显示缩略卡）。 */
export const ROADMAP_INLINE_LANES = 2;
export const ROADMAP_INLINE_ITEMS = 6;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 可选短文字：不给 / 空串当没有；给了但不是字符串、太长，整块不合法（返回 false）。 */
function optionalText(value: unknown, max: number): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return undefined;
  return [...text].length > max ? false : text;
}

function requiredText(value: unknown, max: number): string | false {
  const text = optionalText(value, max);
  return text ? text : false;
}

/** 数值：数字，或只写了数字的字符串（「180」「1,200」「12.5」）。 */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** 日期：YYYY-MM-DD、YYYY/MM/DD、YYYY-MM（只到月）。不合法为 null。 */
export function readDate(value: unknown): DateParts | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day !== undefined) {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  }
  return day === undefined ? { year, month } : { year, month, day };
}

/** 日期在时间轴上的位置（UTC 毫秒；只到月的取当月 1 日）。 */
export const dateValue = (date: DateParts) => Date.UTC(date.year, date.month - 1, date.day ?? 1);

const DAY_MS = 86_400_000;
export const daysBetween = (from: DateParts, to: DateParts) => Math.round((dateValue(to) - dateValue(from)) / DAY_MS);

/** 中文日期：与参照年份同年写「10月15日」，跨年写「2027年2月6日」；只到月写「2027年2月」。 */
export function formatDate(date: DateParts, referenceYear?: number): string {
  const sameYear = referenceYear !== undefined && date.year === referenceYear;
  const month = `${date.month}月`;
  if (date.day === undefined) return `${date.year}年${month}`;
  return `${sameYear ? "" : `${date.year}年`}${month}${date.day}日`;
}

function readMetricCompare(value: Record<string, unknown>): MetricCompareBlock | null {
  const title = optionalText(value.title, TEXT_MAX);
  const unit = optionalText(value.unit, 16);
  if (title === false || unit === false || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) return null;
  const items: MetricItem[] = [];
  for (const raw of value.items) {
    if (!isObject(raw)) return null;
    const label = requiredText(raw.label, TEXT_MAX);
    const current = readNumber(raw.current);
    const target = readNumber(raw.target);
    const itemUnit = optionalText(raw.unit, 16);
    const note = optionalText(raw.note, NOTE_MAX);
    if (label === false || current === null || target === null || target <= 0 || current < 0 || itemUnit === false || note === false) return null;
    items.push({ label, current, target, ...(itemUnit ? { unit: itemUnit } : {}), ...(note ? { note } : {}) });
  }
  return { kind: "metric-compare", ...(title ? { title } : {}), ...(unit ? { unit } : {}), items };
}

const KINDS: TimelineKind[] = ["milestone", "deadline", "now"];

function readTimeline(value: Record<string, unknown>): TimelineBlock | null {
  const title = optionalText(value.title, TEXT_MAX);
  if (title === false || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > 12) return null;
  let now: DateParts | undefined;
  if (value.now !== undefined && value.now !== null && value.now !== "") {
    const parsed = readDate(value.now);
    if (!parsed) return null;
    now = parsed;
  }
  const items: TimelineItem[] = [];
  for (const raw of value.items) {
    if (!isObject(raw)) return null;
    const date = readDate(raw.date);
    const label = requiredText(raw.label, TEXT_MAX);
    const kind = raw.kind === undefined || raw.kind === null || raw.kind === "" ? "milestone" : raw.kind;
    if (!date || label === false || !KINDS.includes(kind as TimelineKind)) return null;
    items.push({ date, label, kind: kind as TimelineKind });
  }
  // 节点按时间排（模型偶尔写乱）；同一天保持原顺序。
  const sorted = items.map((item, index) => ({ item, index })).sort((a, b) => dateValue(a.item.date) - dateValue(b.item.date) || a.index - b.index).map(({ item }) => item);
  now ??= sorted.find((item) => item.kind === "now")?.date;
  return { kind: "timeline", ...(title ? { title } : {}), ...(now ? { now } : {}), items: sorted };
}

const STATUSES: RoadmapStatus[] = ["confirmed", "planned", "inferred"];

/** 只到月的结束日期算到月底；其余原样。时间轴上一段的右端 = 结束那一天的次日 0 点。 */
export const endValue = (date: DateParts) => (date.day === undefined ? Date.UTC(date.year, date.month, 1) : dateValue(date) + DAY_MS);

function readRoadmap(value: Record<string, unknown>): RoadmapBlock | null {
  const title = optionalText(value.title, TEXT_MAX);
  if (title === false || !Array.isArray(value.lanes) || value.lanes.length < 1 || value.lanes.length > ROADMAP_LANES_MAX) return null;
  let now: DateParts | undefined;
  if (value.now !== undefined && value.now !== null && value.now !== "") {
    const parsed = readDate(value.now);
    if (!parsed) return null;
    now = parsed;
  }
  const lanes: RoadmapLane[] = [];
  let total = 0;
  for (const rawLane of value.lanes) {
    if (!isObject(rawLane) || !Array.isArray(rawLane.items) || rawLane.items.length < 1 || rawLane.items.length > ROADMAP_ITEMS_MAX) return null;
    const label = requiredText(rawLane.label, TEXT_MAX);
    if (label === false) return null;
    const items: RoadmapItem[] = [];
    for (const raw of rawLane.items) {
      if (!isObject(raw)) return null;
      const itemLabel = requiredText(raw.label, TEXT_MAX);
      const status = raw.status === undefined || raw.status === null || raw.status === "" ? "planned" : raw.status;
      if (itemLabel === false || !STATUSES.includes(status as RoadmapStatus)) return null;
      const hasDate = raw.date !== undefined && raw.date !== null && raw.date !== "";
      const start = readDate(hasDate ? raw.date : raw.start);
      if (!start) return null;
      let end: DateParts | undefined;
      if (!hasDate && raw.end !== undefined && raw.end !== null && raw.end !== "") {
        const parsed = readDate(raw.end);
        if (!parsed || endValue(parsed) <= dateValue(start)) return null;
        end = parsed;
      }
      items.push({ label: itemLabel, status: status as RoadmapStatus, start, ...(end ? { end } : {}) });
    }
    total += items.length;
    // 泳道内按开始时间排（模型偶尔写乱）；同一天保持原顺序。
    const sorted = items.map((item, index) => ({ item, index })).sort((a, b) => dateValue(a.item.start) - dateValue(b.item.start) || a.index - b.index).map(({ item }) => item);
    lanes.push({ label, items: sorted });
  }
  if (total > ROADMAP_TOTAL_MAX) return null;
  return { kind: "roadmap", ...(title ? { title } : {}), ...(now ? { now } : {}), lanes };
}

/** 解析一个富内容块；JSON 读不出、字段不合法一律 null（界面退回原文，不报错）。visual 不是 JSON，交给 parseVisual。 */
export function parseRichBlock(language: string, source: string): RichBlock | null {
  if (!isRichLanguage(language)) return null;
  if (language === "visual") return parseVisual(source);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  return language === "metric-compare" ? readMetricCompare(value) : language === "roadmap" ? readRoadmap(value) : readTimeline(value);
}

/**
 * 块读得出 JSON、但字段不合规（模型没看到完整写法时常见：日期写成「2026Q4」、kind 写成 phase、current 写成「约 20」）：
 * 退回成普通列表——标题 + 每个节点一行「日期 · 名称（说明）」或「名称：当前 x / 目标 y」，不露出 JSON。
 * JSON 都读不出、或一条可读的节点都没有时为 null（界面退回原文代码块）。
 */
export function richFallbackList(source: string): { title?: string; lines: string[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  // 路线图：把各条泳道的项摊平，每项前面带上泳道名。
  const lanes = isObject(value) && Array.isArray(value.lanes) ? value.lanes : null;
  const raw = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items
    : lanes ? lanes.flatMap((lane) => (isObject(lane) && Array.isArray(lane.items)
      ? lane.items.map((item) => (isObject(item) && typeof lane.label === "string" && typeof item.label === "string" ? { ...item, label: `${lane.label.trim()} · ${item.label.trim()}`, date: item.date ?? item.start } : item))
      : [])) : null;
  if (!raw) return null;
  const text = (item: unknown) => (typeof item === "string" ? item.trim() : typeof item === "number" && Number.isFinite(item) ? String(item) : "");
  const lines = raw.slice(0, 20).flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!isObject(item)) return [];
    const name = text(item.label) || text(item.name) || text(item.title);
    if (!name) return [];
    const when = text(item.date) || text(item.time) || text(item.period);
    const current = text(item.current), target = text(item.target), note = text(item.note) || text(item.desc);
    const figures = current || target ? `：${[current && `当前 ${current}`, target && `目标 ${target}`].filter(Boolean).join(" / ")}` : "";
    return [`${when ? `${when} · ` : ""}${name}${figures}${note ? `（${note}）` : ""}`];
  });
  if (!lines.length) return null;
  const title = isObject(value) ? text(value.title) : "";
  return { ...(title ? { title } : {}), lines };
}

/** 流式中还没收全的块：从已到的 JSON 里先读出标题，骨架上写它；读不出为 null。 */
export function partialTitle(source: string): string | null {
  const match = /"title"\s*:\s*"((?:[^"\\\n]|\\.)*)"/.exec(source);
  if (!match) return null;
  try {
    const title = (JSON.parse(`"${match[1]}"`) as string).trim();
    return title ? [...title].slice(0, TEXT_MAX).join("") : null;
  } catch {
    return null;
  }
}

export const RICH_KIND_NAME: Record<RichLanguage, string> = { "metric-compare": "指标对比", timeline: "时间线", roadmap: "路线图", visual: "图示" };

/** 骨架上的标题：JSON 块读 "title"，图示读根元素的 aria-label；都读不出写种类名。 */
export function skeletonTitle(language: RichLanguage, source: string): string {
  return (language === "visual" ? partialVisualTitle(source) : partialTitle(source)) ?? RICH_KIND_NAME[language];
}

/* ── 指标对比 ── */

export type MetricReading = { ratio: number; percent: string; band: CompletionBand; gap: number };

/** 完成度 = 当前 ÷ 目标；未到 100 向下取整，>0 且 <1 写「<1%」，到达或超过四舍五入（与首页战况面同一口径）。色阶同首页。 */
export function metricReading(item: Pick<MetricItem, "current" | "target">): MetricReading {
  const ratio = item.current / item.target;
  const percentValue = ratio * 100;
  const percent = percentValue === 0 ? "0%" : percentValue < 1 ? "<1%" : percentValue < 100 ? `${Math.floor(percentValue)}%` : `${Math.round(percentValue)}%`;
  return { ratio, percent, band: completionBand({ ratio }), gap: Math.max(0, item.target - item.current) };
}

/** 数字：最多两位小数，去掉末尾的 0，千分位。 */
export function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/* ── 时间线 ── */

export type TimelineProgress = { passed: number; remaining: number; ratio: number; end: DateParts };

/** 「已过 / 剩余」：从第一个节点到最后一个节点，按 now 算；没有 now 不画（不拿本机日期编）。 */
export function timelineProgress(block: TimelineBlock): TimelineProgress | null {
  if (!block.now) return null;
  const start = block.items[0].date, end = block.items.at(-1)!.date;
  const total = daysBetween(start, end);
  if (total <= 0) return null;
  const passed = Math.min(total, Math.max(0, daysBetween(start, block.now)));
  return { passed, remaining: total - passed, ratio: passed / total, end };
}

/** 节点相对 now：过去 / 当前 / 将来。 */
export function timelinePhase(item: TimelineItem, now: DateParts | undefined): "past" | "now" | "future" {
  if (item.kind === "now") return "now";
  if (!now) return "future";
  const diff = dateValue(item.date) - dateValue(now);
  return diff < 0 ? "past" : diff === 0 ? "now" : "future";
}

/** 日期写法的参照年：now 的年份，没有就第一个节点的年份。 */
export const referenceYear = (block: TimelineBlock) => (block.now ?? block.items[0].date).year;

/* ── 缩略卡 ── */

/** 估一个块完整显示要多高（px），用来和对话区高度比。 */
export function estimateHeight(block: RichBlock): number {
  if (block.kind === "metric-compare") return 52 + block.items.reduce((sum, item) => sum + (item.note ? 82 : 62), 0);
  // 路线图：标题、刻度行、每条泳道一行名称加至少一行条、图例。
  if (block.kind === "roadmap") return 52 + 26 + block.lanes.length * (22 + 30) + 28;
  // 图示：SVG 按 viewBox 原尺寸估；HTML 量到之前不知道多高，不按高度判大块。
  if (block.kind === "visual") return block.viewBox ? 52 + block.viewBox.height : 0;
  return 52 + 34 + 96;
}

/** 估一个块至少要多宽（px）。路线图在任何宽度里都能压缩或横向滚动，不按宽度判大块。 */
export function estimateWidth(block: RichBlock): number {
  if (block.kind === "metric-compare" || block.kind === "roadmap") return 280;
  if (block.kind === "visual") return block.viewBox ? Math.ceil(svgFit(block.viewBox, 0).width) + 18 : 0;
  return block.items.length * TIMELINE_NODE_MIN;
}

export const roadmapItemCount = (block: RoadmapBlock) => block.lanes.reduce((sum, lane) => sum + lane.items.length, 0);

/**
 * 收起态是否只显示缩略卡：需要的宽度 > 内容区、高度 > 对话区约 60%，或时间线节点 > 3、路线图泳道 > 2 或项数 > 6。
 * 图示：SVG 缩到 0.8 倍仍比内容区宽（要横向滚动）或太高时显示缩略卡；HTML 一律直接显示（按宽度自适应）。
 * contentWidth / areaHeight 量不到（0 或没给）时只按节点数与条数判断。
 */
export function isLargeBlock(block: RichBlock, area: { contentWidth?: number; areaHeight?: number } = {}): boolean {
  if (block.kind === "timeline" && block.items.length > TIMELINE_INLINE_MAX) return true;
  if (block.kind === "roadmap" && (block.lanes.length > ROADMAP_INLINE_LANES || roadmapItemCount(block) > ROADMAP_INLINE_ITEMS)) return true;
  if (area.contentWidth && estimateWidth(block) > area.contentWidth) return true;
  if (area.areaHeight && estimateHeight(block) > area.areaHeight * LARGE_HEIGHT_RATIO) return true;
  return false;
}

/**
 * 时间线在给定宽度里怎么排（width 为节点轨道的内容宽度，px）：
 * - row：一行放得下（每个节点 ≥ TIMELINE_NODE_COMPACT），等分整行；
 * - wrap：一行放不下，按尽量均匀的列数换行（columns 列），行数不超过 TIMELINE_MAX_ROWS；
 * - scroll：换行也放不下，一行横向滚动，每个节点 TIMELINE_NODE_MIN。
 * 量不到宽度（0 或没给，服务端渲染、首帧之前）时按 scroll 排，与改前一致，不裁切。
 */
export type TimelineLayout = { mode: "row" } | { mode: "wrap"; columns: number } | { mode: "scroll" };

export function timelineLayout(count: number, width?: number): TimelineLayout {
  if (!width || width <= 0) return { mode: "scroll" };
  const perRow = Math.floor(width / TIMELINE_NODE_COMPACT);
  if (perRow < 2) return { mode: "scroll" };
  if (count <= perRow) return { mode: "row" };
  const rows = Math.ceil(count / perRow);
  if (rows > TIMELINE_MAX_ROWS) return { mode: "scroll" };
  return { mode: "wrap", columns: Math.ceil(count / rows) };
}

/** 缩略卡上的一行摘要。 */
export function richSummary(block: RichBlock): string {
  if (block.kind === "metric-compare") {
    const readings = block.items.map(metricReading);
    const lowest = readings.reduce((low, reading) => (reading.ratio < low.ratio ? reading : low), readings[0]);
    return block.items.length === 1 ? `完成度 ${lowest.percent}` : `${block.items.length} 项 · 最低完成度 ${lowest.percent}`;
  }
  if (block.kind === "roadmap") {
    const last = roadmapEnd(block);
    return `${block.lanes.length} 条主线 · ${roadmapItemCount(block)} 项 · 至 ${formatDate(last, roadmapReferenceYear(block))}`;
  }
  if (block.kind === "visual") return "放大后完整显示";
  const year = referenceYear(block);
  return `${block.items.length} 个节点 · 至 ${formatDate(block.items.at(-1)!.date, year)}`;
}

/** 路线图最晚的那一天（一段取结束，单点取日期）。 */
export function roadmapEnd(block: RoadmapBlock): DateParts {
  let last: DateParts = block.lanes[0].items[0].start;
  for (const lane of block.lanes) for (const item of lane.items) {
    const end = item.end ?? item.start;
    if (endValue(end) > endValue(last)) last = end;
  }
  return last;
}

/** 路线图日期写法的参照年：now 的年份，没有就最早一项的年份。 */
export function roadmapReferenceYear(block: RoadmapBlock): number {
  if (block.now) return block.now.year;
  return Math.min(...block.lanes.flatMap((lane) => lane.items.map((item) => item.start.year)));
}

/** 块的标题：给了用给的，没给按种类。 */
export const richTitle = (block: RichBlock) => block.title ?? RICH_KIND_NAME[block.kind];
