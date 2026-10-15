import { dateValue, endValue, roadmapReferenceYear, type DateParts, type RoadmapBlock, type RoadmapItem, type RoadmapStatus } from "./parse";

/**
 * 多泳道路线图的版式（纯函数；组件在 Roadmap.tsx）。几条主线共用一条时间轴，每条主线一个泳道：
 * - 时间轴从最早一项所在月的 1 日，到最晚一项（含「现在」）所在月的月底；刻度在月初，按宽度抽稀成每 1 / 2 / 3 / 6 / 12 个月一个；
 * - 一段画成细条（含结束那一天；只到月的结束算到月底），单点画成圆点；名称写在条上方、从起点开始，靠右放不下就往左挪，不截断；
 * - 同一泳道里位置（连同名称）重叠的项，按开始时间依次放进第一行放得下的位置，最多 ROADMAP_MAX_ROWS 行；
 * - 先在正文栏宽度里排（fit）；每月不到 ROADMAP_MONTH_MIN、或某条泳道要超过 ROADMAP_MAX_ROWS 行才放得下时，
 *   才按 1.25 倍逐步加宽（scroll，横向滚动、渐隐与提示）；量不到宽度时按 ROADMAP_DEFAULT_WIDTH 横向滚动排。
 */

/** 每个月至少这么宽（px）才在正文栏里直接排。 */
export const ROADMAP_MONTH_MIN = 26;
/** 刻度之间至少这么宽（px），放得下「2027年1月」。 */
export const ROADMAP_TICK_MIN = 60;
/** 一条泳道最多分几行。 */
export const ROADMAP_MAX_ROWS = 3;
/** 量不到宽度时（服务端渲染、首帧之前）按这个宽度横向滚动排。 */
export const ROADMAP_DEFAULT_WIDTH = 560;
/** 版式里的尺寸（px），与 rich-blocks.module.css 的 .rm* 一致。 */
export const ROADMAP_ROW_HEIGHT = 30;
const ITEM_GAP = 10, POINT_SIZE = 10, NOW_LABEL_WIDTH = 30, WIDEN_STEPS = 6;

const DAY_MS = 86_400_000;

/** 估文字宽度（px，宁宽勿窄）：汉字与全角 = 字号，拉丁字母与数字约 0.62 个字号，空格 0.28 个字号。手持字号 13 时多出的宽度由行间距吸收。 */
export function textWidth(text: string, size = 13): number {
  let width = 0;
  for (const char of text) {
    if (/[⺀-鿿豈-﫿＀-￯　-〿]/.test(char)) width += size;
    else if (char === " ") width += size * 0.28;
    else width += size * 0.62;
  }
  return Math.ceil(width);
}

/** 名称相对条的位置（都在条上方）：inside 名称不比条长，right 从起点往右伸出条外，left 贴右边时往左挪了。 */
export type RoadmapLabelSide = "inside" | "right" | "left";
export type RoadmapPlaced = {
  item: RoadmapItem;
  row: number;
  /** 条（或圆点）的位置与宽度，px，相对整条时间轴。 */
  left: number;
  width: number;
  point: boolean;
  labelSide: RoadmapLabelSide;
  labelLeft: number;
  labelWidth: number;
};
export type RoadmapLaneLayout = { label: string; rows: number; items: RoadmapPlaced[] };
export type RoadmapTick = { left: number; label: string; hidden: boolean };
export type RoadmapLayout = {
  mode: "fit" | "scroll";
  /** 时间轴总宽（px）：fit 时等于给定宽度。 */
  width: number;
  ticks: RoadmapTick[];
  now?: { left: number; labelLeft: number };
  lanes: RoadmapLaneLayout[];
  /** 出现过的状态（图例只列这些）。 */
  statuses: RoadmapStatus[];
};

type Domain = { start: number; end: number; months: { year: number; month: number; value: number }[] };

const monthStart = (year: number, month: number) => Date.UTC(year, month - 1, 1);

/** 时间轴的起止：最早一项所在月的 1 日，到最晚一项（含现在）所在月的次月 1 日。 */
export function roadmapDomain(block: RoadmapBlock): Domain {
  let min = Infinity, max = -Infinity;
  const see = (low: number, high: number) => { min = Math.min(min, low); max = Math.max(max, high); };
  for (const lane of block.lanes) for (const item of lane.items) see(dateValue(item.start), item.end ? endValue(item.end) : dateValue(item.start) + DAY_MS);
  if (block.now) see(dateValue(block.now), dateValue(block.now) + DAY_MS);
  const first = new Date(min), last = new Date(max - 1);
  const start = monthStart(first.getUTCFullYear(), first.getUTCMonth() + 1);
  const end = monthStart(last.getUTCFullYear(), last.getUTCMonth() + 2);
  const months: Domain["months"] = [];
  for (let value = start; value < end;) {
    const date = new Date(value);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;
    months.push({ year, month, value });
    value = monthStart(year, month + 1);
  }
  return { start, end, months };
}

type Extent = { low: number; high: number };

function placeItem(item: RoadmapItem, scale: (value: number) => number, width: number): Omit<RoadmapPlaced, "row"> & { extent: Extent } {
  const label = textWidth(item.label); // 按 13 估：手持字号是 13
  // 名称一律写在条（圆点）上方，从条的起点开始；靠右放不下就往左挪到贴齐右边，不截断。
  const place = (anchor: number) => Math.max(0, Math.min(anchor, width - label));
  if (!item.end) {
    const center = scale(dateValue(item.start) + DAY_MS / 2);
    const left = center - POINT_SIZE / 2;
    const labelLeft = place(left);
    return { item, left, width: POINT_SIZE, point: true, labelSide: labelLeft < left ? "left" : "right", labelLeft, labelWidth: label,
      extent: { low: Math.min(left, labelLeft), high: Math.max(left + POINT_SIZE, labelLeft + label) } };
  }
  const left = scale(dateValue(item.start));
  const barWidth = Math.max(6, scale(endValue(item.end)) - left);
  const labelLeft = place(left);
  const side: RoadmapLabelSide = label <= barWidth ? "inside" : labelLeft < left ? "left" : "right";
  return { item, left, width: barWidth, point: false, labelSide: side, labelLeft, labelWidth: label,
    extent: { low: Math.min(left, labelLeft), high: Math.max(left + barWidth, labelLeft + label) } };
}

/** 一条泳道按开始时间依次放进第一行放得下的位置（不限行数；行数由外面判断够不够）。 */
function packLane(items: RoadmapItem[], scale: (value: number) => number, width: number): { rows: number; items: RoadmapPlaced[] } {
  const rowEnds: number[] = [];
  const placed = items.map((item) => {
    const { extent, ...rest } = placeItem(item, scale, width);
    let row = rowEnds.findIndex((end) => end + ITEM_GAP <= extent.low);
    if (row < 0) { row = rowEnds.length; rowEnds.push(extent.high); } else rowEnds[row] = extent.high;
    return { ...rest, row };
  });
  return { rows: Math.max(1, rowEnds.length), items: placed };
}

const TICK_STEPS = [1, 2, 3, 6, 12];

/** 刻度：月初；年份变了（或与参照年不同）的那一个写「2027年1月」，其余写「11月」。 */
function roadmapTicks(domain: Domain, scale: (value: number) => number, width: number, referenceYear: number, now?: RoadmapLayout["now"]): RoadmapTick[] {
  const perMonth = width / Math.max(1, domain.months.length);
  const step = TICK_STEPS.find((candidate) => candidate * perMonth >= ROADMAP_TICK_MIN) ?? 12;
  let previousYear = referenceYear;
  const ticks: RoadmapTick[] = [];
  for (const month of domain.months) {
    if ((month.month - 1) % step !== 0) continue;
    const label = month.year !== previousYear ? `${month.year}年${month.month}月` : `${month.month}月`;
    previousYear = month.year;
    const left = scale(month.value);
    const labelRight = left + 4 + textWidth(label, 12);
    const overlapsNow = now ? left + 4 < now.labelLeft + NOW_LABEL_WIDTH + 4 && labelRight > now.labelLeft - 4 : false;
    ticks.push({ left, label, hidden: overlapsNow || labelRight > width });
  }
  return ticks;
}

function layoutAt(block: RoadmapBlock, domain: Domain, width: number) {
  const scale = (value: number) => ((value - domain.start) / (domain.end - domain.start)) * width;
  const lanes = block.lanes.map((lane) => ({ label: lane.label, ...packLane(lane.items, scale, width) }));
  return { scale, lanes, maxRows: Math.max(...lanes.map((lane) => lane.rows)) };
}

/**
 * 路线图在给定宽度（时间轴的内容宽度，px）里怎么排。量不到宽度（0 或没给）时按 ROADMAP_DEFAULT_WIDTH 横向滚动排。
 */
export function roadmapLayout(block: RoadmapBlock, available?: number): RoadmapLayout {
  const domain = roadmapDomain(block);
  const months = domain.months.length;
  const measured = Boolean(available && available > 0);
  const base = measured ? available! : ROADMAP_DEFAULT_WIDTH;
  let width = Math.max(base, measured ? 0 : months * ROADMAP_MONTH_MIN);
  let attempt = layoutAt(block, domain, width);
  const fits = (candidate: number, rows: number) => candidate / months >= ROADMAP_MONTH_MIN && rows <= ROADMAP_MAX_ROWS;
  for (let step = 0; step < WIDEN_STEPS && !fits(width, attempt.maxRows); step++) {
    width = Math.ceil(Math.max(width * 1.25, months * ROADMAP_MONTH_MIN));
    attempt = layoutAt(block, domain, width);
  }
  const mode = measured && width <= base ? "fit" : "scroll";
  const statuses = (["confirmed", "planned", "inferred"] as RoadmapStatus[]).filter((status) => block.lanes.some((lane) => lane.items.some((item) => item.status === status)));
  let now: RoadmapLayout["now"];
  if (block.now) {
    const left = attempt.scale(dateValue(block.now) + DAY_MS / 2);
    now = { left, labelLeft: Math.min(Math.max(0, left - NOW_LABEL_WIDTH / 2), Math.max(0, width - NOW_LABEL_WIDTH)) };
  }
  const ticks = roadmapTicks(domain, attempt.scale, width, roadmapReferenceYear(block), now);
  return { mode, width, ticks, ...(now ? { now } : {}), lanes: attempt.lanes, statuses };
}

/** 一项的日期写法（无障碍名称、悬停提示）：单点「10月20日」，一段「10月10日–11月30日」。 */
export function roadmapItemDates(item: RoadmapItem, referenceYear: number, format: (date: DateParts, year?: number) => string): string {
  return item.end ? `${format(item.start, referenceYear)}–${format(item.end, referenceYear)}` : format(item.start, referenceYear);
}

export const ROADMAP_STATUS_TEXT: Record<RoadmapStatus, string> = { confirmed: "已确认", planned: "计划", inferred: "推断" };
