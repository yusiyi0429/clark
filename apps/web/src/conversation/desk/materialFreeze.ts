/**
 * 深度讨论展开 / 收起时左侧材料的排版（spec「10/12 深度讨论 v2」末节「展开 / 收起时左侧材料不在静止后重排」）。
 * 用户实测：旧做法（过渡中冻结、结束时一次性落到新宽）在右侧动效停住之后左侧才突然换版，像电脑卡了。现在：
 *   左侧面板照常跟着让位的主区一帧一帧变宽 / 变窄，阅读列（页面里标了 data-material-column 的那几块）宽度固定：
 *   A 档（够宽）：展开前后阅读列都是 600 正文，宽度根本不变，只随居中位置平移，什么都不锁。
 *   B 档（不够宽）：动画开始的第一帧就把阅读列定在过渡结束后的宽度（一次重排），过渡中只平移；
 *        同时左侧做一下很轻的淡入（0.85 → 1，180ms）把这一次重排盖住；结束时解锁，此时的自然宽度正好就是锁住的宽度，不再有任何变化。
 * 结束后的宽度不靠估算：开始那一刻把面板临时设成结束后的宽，同步量一遍每一块阅读列（含容器查询、栅格、滚动条），量完立即还原，
 * 中间不会绘制。读者正在读的那一段由 readingAnchor 在开始时就放回原位。减少动效时不锁，瞬时切换。
 */

/** 页面里的阅读列：宽度在过渡中要固定的那几块。 */
export const MATERIAL_COLUMN_SELECTOR = "[data-material-column]";

type ElementLike = { matches(selector: string): boolean };

/**
 * 要固定宽度的那几块：页面标了 data-material-column 的阅读列；没标的页（雷达、Mission……）退回滚动层的直接子块
 * （DetailFrame 吸顶的页头除外）——这些页的内容靠左排，锁成结束后的宽同样只在开始那一帧重排一次，不用平移。
 */
export function materialColumns<T extends ElementLike>(panel: { querySelectorAll(selector: string): ArrayLike<T> | Iterable<T> } | null, scroller: { children: ArrayLike<T> | Iterable<T> } | null): T[] {
  const marked = panel ? Array.from(panel.querySelectorAll(MATERIAL_COLUMN_SELECTOR) as Iterable<T>) : [];
  if (marked.length || !scroller) return marked;
  return Array.from(scroller.children as Iterable<T>).filter((child) => !child.matches(".ts-detail-header"));
}

/** 重排那一下的淡入：很轻、很短（≤200ms），只为把开始那一帧的折行变化盖过去。 */
export const SHIFT_FADE = { from: 0.85, ms: 180 } as const;

/** 宽度差小于半个像素算没变（亚像素取整不会改变折行）。 */
const SAME = 0.5;

/** 外壳主区（.mainArea）过渡结束后的宽：此刻的宽 + 此刻（动画中的）右边距 − 新的右边距（= 新的对话列宽）。 */
export function settledMaterialWidth(currentWidth: number, currentMargin: number, nextMargin: number): number {
  return Math.max(0, currentWidth + currentMargin - nextMargin);
}

/** 每一块阅读列锁在哪个宽（null = 宽度不变，不锁）；有任何一块要变就是这次有重排（要配淡入）。 */
export function planColumnLocks(current: readonly number[], settled: readonly number[]): { locks: (number | null)[]; reflow: boolean } {
  const locks = settled.map((width, index) => (Math.abs(width - (current[index] ?? width)) >= SAME ? width : null));
  return { locks, reflow: locks.some((width) => width !== null) };
}

type StyleTarget = {
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): unknown;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
};
type ColumnTarget = { style: StyleTarget; dataset: DOMStringMap; getBoundingClientRect(): { width: number } };
type PanelTarget = Pick<ColumnTarget, "style" | "dataset">;
type FadeTarget = { animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => unknown };

/** 锁住时要盖掉的几项（行内 !important，压过页面自己的 max-width / flex）。 */
const LOCKED = ["width", "min-width", "max-width", "box-sizing", "flex-shrink"] as const;

type Saved = { element: ColumnTarget; values: [string, string, string][] };

function lockColumn(element: ColumnTarget, width: number): Saved {
  const values = LOCKED.map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)] as [string, string, string]);
  const px = `${Number(width.toFixed(3))}px`;
  element.style.setProperty("box-sizing", "border-box", "important");
  element.style.setProperty("width", px, "important");
  element.style.setProperty("min-width", px, "important");
  element.style.setProperty("max-width", px, "important");
  element.style.setProperty("flex-shrink", "0", "important");
  element.dataset.deskColumnLock = "true";
  return { element, values };
}

function unlockColumn({ element, values }: Saved) {
  for (const [name, value, priority] of values) {
    if (value) element.style.setProperty(name, value, priority);
    else element.style.removeProperty(name);
  }
  delete element.dataset.deskColumnLock;
}

const widthOf = (element: ColumnTarget) => element.getBoundingClientRect().width;

/** 临时把面板设成结束后的宽，量每一块阅读列在那时的宽，立即还原（同步，不绘制）。 */
export function measureSettledColumns(panel: PanelTarget, columns: readonly ColumnTarget[], settledPanelWidth: number): number[] {
  const saved = ["right", "width"].map((name) => [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const);
  panel.style.setProperty("right", "auto", "important");
  panel.style.setProperty("width", `${Number(settledPanelWidth.toFixed(3))}px`, "important");
  const widths = columns.map(widthOf);
  for (const [name, value, priority] of saved) {
    if (value) panel.style.setProperty(name, value, priority);
    else panel.style.removeProperty(name);
  }
  return widths;
}

/**
 * 开始一次展开 / 收起。columns：materialColumns 找到的那几块；settledPanelWidth：过渡结束后面板的宽。durationMs 后解锁。
 * onReflow 在开始那一帧真正重排之后同步调用（放回阅读位置）；减少动效时不锁，也同步调用一次。
 * scroller：左侧在滚的那一层，锁住期间不出横向滚动条（收起时阅读列先比面板宽，多出的部分藏在对话列下面）。
 * 返回提前结束的函数（再次切换或卸载时调用：立刻解锁，不再回调）。
 */
export function shiftMaterialColumns(
  panel: PanelTarget,
  columns: readonly ColumnTarget[],
  settledPanelWidth: number,
  durationMs: number,
  { reducedMotion = false, onReflow, scroller, fadeTarget }: {
    reducedMotion?: boolean;
    onReflow?: () => void;
    scroller?: { style: StyleTarget } | null;
    fadeTarget?: FadeTarget | null;
  } = {},
): () => void {
  if (reducedMotion || durationMs <= 0) {
    onReflow?.();
    return () => {};
  }
  if (!columns.length) return () => {};
  const current = columns.map(widthOf);
  const plan = planColumnLocks(current, measureSettledColumns(panel, columns, settledPanelWidth));
  if (!plan.reflow) return () => {};
  const saved = columns.flatMap((element, index) => (plan.locks[index] === null ? [] : [lockColumn(element, plan.locks[index]!)]));
  const overflow = scroller ? [scroller.style.getPropertyValue("overflow-x"), scroller.style.getPropertyPriority("overflow-x")] as const : null;
  scroller?.style.setProperty("overflow-x", "hidden", "important");
  panel.dataset.deskColumnShift = "true";
  onReflow?.();
  fadeTarget?.animate?.([{ opacity: SHIFT_FADE.from }, { opacity: 1 }], { duration: SHIFT_FADE.ms, easing: "cubic-bezier(.22,1,.36,1)" });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    saved.forEach(unlockColumn);
    if (scroller && overflow) {
      if (overflow[0]) scroller.style.setProperty("overflow-x", overflow[0], overflow[1]);
      else scroller.style.removeProperty("overflow-x");
    }
    delete panel.dataset.deskColumnShift;
  };
  const timer = setTimeout(finish, durationMs);
  return () => {
    clearTimeout(timer);
    finish();
  };
}
