/**
 * 页面目录：首页对话在每个二级页面都开着，本人在哪个页面问，转给 Chat 的这一轮就带上这页的名字和说明
 * （CHAT_PAGE_CONTEXT=1 才带，见 chatService）。说明写给 Agent 用来指导本人：这页做什么、主要怎么操作、结果去哪。
 * 按页面路径匹配；首页不带（首页的内容 Chat 自己读首页卡）。
 */
export type PageGuide = { path: string; title: string; guide: string };

const GUIDES: { patterns: RegExp[]; title: string; guide: string }[] = [];

export function pageGuide(path: string): PageGuide | null {
  const entry = GUIDES.find((item) => item.patterns.some((pattern) => pattern.test(path)));
  return entry ? { path, title: entry.title, guide: entry.guide } : null;
}
