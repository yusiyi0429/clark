/**
 * 深度讨论（讨论台首演版，docs/superpowers/specs/2026-10-10-discussion-desk-design.md「10/12 深度讨论 v2」与末节「展开 / 收起时左侧材料不在静止后重排」）：并排。
 * 二级页右列原地加宽，左侧材料变成较窄的阅读栏，不覆盖、不 inert。
 * 左侧阅读列固定 600（左右内边距各 28，阅读列整宽 656）。展开后对话列多宽，按可用宽度（视口 − 左侧窄条与外沿）分两档：
 *   A 档 够宽（可用 − 656 ≥ 640，约视口 ≥1394）：对话列 = clamp(可用 − 656, 640, 760)；左侧材料 ≥656，
 *        阅读列宽度不变、只随居中位置平移，文字不重新折行；对话列封顶 760 之后多出的宽度都给左侧当两侧留白。
 *   B 档 不够宽（1280 至 A 档以下）：对话列 = max(⌈视口 × 55%⌉, 640)，左侧材料最窄 460；阅读列要变窄，
 *        变窄在过渡开始的第一帧一次完成（desk/materialFreeze），之后不再变。
 *   <1280 不提供（不出 ⤢）。
 * 外壳的边距、左侧窄条与 app-shell.module.css 同值（--shell-edge / --strip-width）。
 */
export const DESK_MIN_VIEWPORT = 1280;
/** 左侧阅读列：正文 600，左右内边距各 28；左侧材料至少 656 时阅读列不变窄。 */
export const MATERIAL_MEASURE = 600;
export const MATERIAL_GUTTER = 28;
export const MATERIAL_COLUMN = MATERIAL_MEASURE + MATERIAL_GUTTER * 2;
/** 面板略窄于 656（滚动条占掉几像素）时内边距先让，最少 12，正文仍是 600。 */
export const MATERIAL_GUTTER_MIN = 12;
/** A 档：对话列下限与封顶。 */
export const DESK_COLUMN_MIN = 640;
export const DESK_COLUMN_MAX = 760;
/** B 档：对话列占视口的比例（下限），以及左侧材料最窄多少。 */
export const DESK_RATIO = 0.55;
export const DESK_MATERIAL_MIN = 460;
/** 展开 / 收起的宽度过渡（≤240ms；减少动效时瞬时）。 */
export const DESK_SHIFT_MS = 240;

/** 二级页打开时外壳的外沿与主区域左沿：外沿 = 间距；左侧通知栏折成 56 的窄条。 */
export function shellMetrics(viewport: number): { edge: number; mainStart: number } {
  const edge = viewport >= 1800 ? 16 : viewport <= 1250 ? 10 : 14;
  return { edge, mainStart: edge + 56 + edge };
}

/** 左侧材料面板宽 = 视口 − 主区左沿 − 右外沿 − 对话列。column = 0 即可用宽度。 */
export function materialWidth(viewport: number, column: number): number {
  const { edge, mainStart } = shellMetrics(viewport);
  return viewport - mainStart - edge - column;
}

export type DeskTier = "A" | "B";
export type DeskPlan = { tier: DeskTier; column: number; material: number };

/** 深度讨论展开后的宽度规则；<1280 不提供（null）。 */
export function deskPlan(viewport: number): DeskPlan | null {
  if (!(viewport >= DESK_MIN_VIEWPORT)) return null;
  const available = materialWidth(viewport, 0);
  const spare = available - MATERIAL_COLUMN;
  if (spare >= DESK_COLUMN_MIN) {
    const column = Math.min(spare, DESK_COLUMN_MAX);
    return { tier: "A", column, material: available - column };
  }
  const target = Math.max(Math.ceil((viewport * Math.round(DESK_RATIO * 100)) / 100), DESK_COLUMN_MIN);
  const column = Math.min(target, available - DESK_MATERIAL_MIN);
  return { tier: "B", column, material: available - column };
}

/** 左侧材料区宽 material 时阅读列正文多宽：≥624 都是 600，再窄才跟着收（内边距 12）。 */
export function readingMeasure(material: number): number {
  return Math.max(0, Math.min(MATERIAL_MEASURE, material - MATERIAL_GUTTER_MIN * 2));
}

/** 深度讨论时对话列多宽；<1280 不提供（null）。 */
export function deskColumnWidth(viewport: number): number | null {
  return deskPlan(viewport)?.column ?? null;
}

type StyleLike = { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };

/**
 * 展开时把对话列宽度写到宿主（.host）的 --conversation-open-width 上：右列、左侧让位（.mainArea 的 margin-right）、
 * 输入条、Co-Agent 胶囊都读它，同一条曲线一起走。收起清掉，回到样式表里的平时宽度。
 */
export function applyDeskWidth(style: StyleLike | null | undefined, width: number | null): void {
  if (!style) return;
  if (width === null) style.removeProperty("--conversation-open-width");
  else style.setProperty("--conversation-open-width", `${width}px`);
}

/* ── 演示后的右栏（DiscussionDesk 抽屉，首演版不渲染）────────────────────── */

/** 抽屉开着时的 Esc：先收抽屉，并 preventDefault 让外壳（WorkspaceFrame）这一次不再收讨论台。 */
export function drawerEscape(event: { key: string; defaultPrevented: boolean; isComposing?: boolean; preventDefault(): void }, open: boolean): boolean {
  if (!open || event.key !== "Escape" || event.defaultPrevented || event.isComposing) return false;
  event.preventDefault();
  return true;
}

/** 抽屉里能接焦点的东西（和右列浮层同一套）。 */
export const DRAWER_FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';

type FocusNode = { contains(other: unknown): boolean; querySelector(selector: string): unknown };

/** 抽屉打开：焦点落到它里面第一个可聚焦元素；没有就落在抽屉本身（tabIndex=-1）。 */
export function drawerEntryFocus<T extends FocusNode>(drawer: T): T {
  return (drawer.querySelector(DRAWER_FOCUSABLE) as T | null) ?? drawer;
}

/**
 * 抽屉收起（Esc、抽屉键、点了条目）：焦点还留在抽屉里、掉到 body 上或没有时，回到抽屉键；
 * 条目自己把焦点挪到别处（比如滚到并聚焦一张提案卡）就不抢。
 */
export function drawerShouldReturnFocus(active: unknown, drawer: FocusNode | null, body: unknown): boolean {
  if (!active || active === body) return true;
  return Boolean(drawer?.contains(active));
}
