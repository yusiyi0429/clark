/**
 * 行为配置。**这里不再有演示内容。**
 *
 * 房懂懂案那套种子（议题、提请卡、每日摘要、时间线、调研文档、会前准备、Closure 草案、
 * 会议、预研）整体退场：屏幕上的内容来自 `seed-tokenking.ts`（从本体仓库的 .trig 生成）
 * 与 `seed-agent-domain.ts`（04 域手写），接线见 `store.ts` 头部。跟它一起走的还有
 * `seed-beike` / `seed-launch` / `seed-ontology` / `seed-docs` 四个文件 —— 要回看旧演示包，
 * git 历史里有。
 *
 * 留下的三样都是**行为**，不是内容：写回时给的影响建议、后台深研的预估时长、以及
 * `TODAY` 的转口。
 */

import type { ResearchDoc } from "./types";

/** The digest day the product considers "today". */
// TODAY 与两个写回常量的唯一定义在 ./shared —— 它们要同时被客户端用到，
// 而 seed.ts 是 server-only。这里 re-export，调用点（seed.TODAY）不用改。
export { TODAY, evidenceActionLabel, evidenceActionsOnStrategy } from "./shared";
import { evidenceActionLabel as _evLabel, evidenceActionsOnStrategy as _evN } from "./shared";

// ---------------------------------------------------------------------------
// 写回模板
//
// `impactHints` 是**固定两条**，对每一次定题／定 Mission 都一样。诚实的版本应该按这条
// 议题所在的域算出来（谁的 Outcome 被动了、谁该知道），那还没做。所以这两条只写在任何
// 一次定题之后都成立的事，不假装是针对这条议题的发现 —— 一旦开始编具体结论，屏幕上就会
// 出现一句「您的 Agent 看着这件事说的」，而它其实谁都没看。
// ---------------------------------------------------------------------------

export const writeBackTemplate = {
  evidenceLabel: _evLabel,
  evidenceActions: _evN,
  impactHints: [
    {
      targetLabel: "D-03 Method",
      text: "这条定题拆出来的 Mission 要挂到某个 Outcome 下面，否则它进不了 DRI 的承诺范围。",
      suggestTo: "业务负责人",
    },
    {
      targetLabel: "D-04 Agents",
      text: "这次动过的判断口径要同步给扫描，否则下一轮出卡还按旧口径挑信号。",
      suggestTo: "产品负责人",
    },
  ],
};

// ---------------------------------------------------------------------------
// 还在跑的自动深研
//
// 议题进池之后，后台 Agent 自动做「本体关联对象 + online deep research」，报告就绪
// 才谈得上进议题研究。**进度按真实时钟算**（见 `store.ts` 的 `issueJobs`），所以这里
// 给的是「模块加载那一刻它已经跑了多久」，而不是一个写死的百分比。
//
// 一条在跑的深研必须有一份**跑完会交出来的报告**（`pendingResearchDocs`）。没有交付物
// 的进度条会走到 100% 然后什么也不发生 —— 那比不给进度条更糟，一号位会盯着它等。
//
// **两个都是空的**：这一版没有任何预置报告，深研全由 A3 真跑（`ensureDeepResearch`）。
// 保留这两个口子是因为 `store.ts` 的 `settleResearch` 还在三处被调用，见那里的注释。
// 要往里放东西，必须成对放 —— 只写 `runningResearch` 就是上面那个走到 100% 的进度条。
// ---------------------------------------------------------------------------

export const runningResearch: Record<
  string,
  { etaSeconds: number; elapsedAtLoad: number }
> = {};

/** 上面那些任务跑完时装上去的报告。跑完之前它不在 `researchDocs` 里。 */
export const pendingResearchDocs: Record<string, ResearchDoc> = {};
