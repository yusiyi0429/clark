import { parseSourceRef, sourceTarget, type SourceContext, type SourceTarget } from "@/cards/meetingSources";

/**
 * 对话回答里的来源 → 左侧（深度讨论 v2，docs/superpowers/specs/2026-10-10-discussion-desk-design.md「10/12 深度讨论 v2」）。
 *
 * 对话在外壳里，材料在二级页里，两边不在同一棵 Provider 下：这里是一块模块级的登记处。
 * - 页面：议题页、会议页的依据导航（components/meeting/SourceViewer `useSourceNavigator`）挂载时登记自己——
 *   能在页内定位的（议题块、历史条目、研究依据小节）滚过去并短暂高亮，群材料、企业知识、群讨论在页面自己的依据面板打开。
 * - 依据面板（CitationPanel）：外壳里的一块，开在对话左边。没有页面登记（战场页、任务页、首页）、首页对话层，
 *   或者页内找不到这一段的议题研究，都由它打开。
 */

export type CitationSurface = "rail" | "sheet";

export type PageCitations = {
  context: SourceContext;
  /** 页面根：页内锚点在它里面找。 */
  root: () => HTMLElement | null;
  open: (ref: string, options: { trigger?: HTMLElement | null; flash?: "brief" }) => void;
};

export type CitationPanelOpener = (ref: string, options: { surface: CitationSurface; trigger?: HTMLElement | null }) => void;

const pages: PageCitations[] = [];
let panel: CitationPanelOpener | null = null;

/** 页面登记（后挂载的优先）；返回注销函数。 */
export function registerPageCitations(page: PageCitations): () => void {
  pages.push(page);
  return () => {
    const index = pages.lastIndexOf(page);
    if (index >= 0) pages.splice(index, 1);
  };
}

export function registerCitationPanel(opener: CitationPanelOpener): () => void {
  panel = opener;
  return () => {
    if (panel === opener) panel = null;
  };
}

/** 这条 ref 认不认得（认不出的不画成链接）。 */
export function knownCitation(ref: string): boolean {
  return parseSourceRef(ref).kind !== "unknown";
}

export type CitationRoute = "page" | "panel" | "none";

/** 页内锚点（含回退链）里第一个在页面里真实存在的；都不在就是 null。 */
function anchorPresent(target: SourceTarget, root: HTMLElement | null): boolean {
  if (target.type !== "anchor") return false;
  if (root?.querySelector(`#${CSS.escape(target.anchorId)}`)) return true;
  return target.fallback ? anchorPresent(target.fallback, root) : false;
}

/** 终点是跳到另一页的：议题、议题研究改在依据面板里看，不离开当前对话。 */
function endsInRoute(target: SourceTarget): boolean {
  if (target.type === "route") return true;
  return target.type === "anchor" && target.fallback ? endsInRoute(target.fallback) : false;
}

/**
 * 去哪打开：
 * - 首页对话层（sheet）一律依据面板；
 * - 右列（rail）有页面登记时交给页面，除非是页内没有的议题 / 议题研究（页面会跳到议题页），那就依据面板；
 * - 没有页面登记就依据面板。
 */
export function citationRoute(ref: string, surface: CitationSurface, page: PageCitations | null = visiblePage()): CitationRoute {
  const parsed = parseSourceRef(ref);
  if (parsed.kind === "unknown") return "none";
  if (surface === "sheet" || !page) return "panel";
  if (parsed.kind === "issue" || parsed.kind === "research") {
    const target = sourceTarget(ref, page.context);
    if (anchorPresent(target, page.root())) return "page";
    if (endsInRoute(target)) return "panel";
  }
  return "page";
}

/** 看得见的页面：根还在文档里、不在 inert / aria-hidden 底下（二级页打开时首页那一层是 inert 的）。 */
function visiblePage(): PageCitations | null {
  for (let index = pages.length - 1; index >= 0; index--) {
    const root = pages[index].root();
    const hidden = root && typeof root.closest === "function" && (root.isConnected === false || root.closest('[inert],[aria-hidden="true"]'));
    if (root && !hidden) return pages[index];
  }
  return null;
}

export function openCitation(ref: string, options: { surface: CitationSurface; trigger?: HTMLElement | null }): CitationRoute {
  const page = visiblePage();
  const route = citationRoute(ref, options.surface, page);
  if (route === "page" && page) page.open(ref, { trigger: options.trigger, flash: "brief" });
  else if (route === "panel" && panel) panel(ref, options);
  else return "none";
  return route;
}

/** 测试用：清空登记。 */
export function resetCitationBridge(): void {
  pages.length = 0;
  panel = null;
  pending = null;
}

/** 平时（没放大）点「打开原文」：先放大，放大后依据面板接着打开这一条。2 秒内没放大成就作废，不在之后意外弹出。 */
const PENDING_MS = 2_000;
let pending: { ref: string; options: { surface: CitationSurface; trigger?: HTMLElement | null }; at: number } | null = null;

export function queueCitation(ref: string, options: { surface: CitationSurface; trigger?: HTMLElement | null }, now = Date.now()): void {
  pending = { ref, options, at: now };
}

/** 依据面板变成可用时取走排着的那一条（过期的丢掉）。 */
export function takePendingCitation(now = Date.now()): { ref: string; options: { surface: CitationSurface; trigger?: HTMLElement | null } } | null {
  const next = pending;
  pending = null;
  return next && now - next.at <= PENDING_MS ? { ref: next.ref, options: next.options } : null;
}
