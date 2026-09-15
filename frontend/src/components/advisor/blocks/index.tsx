"use client";

import { FileDown } from "lucide-react";
import { useRef, useState } from "react";

import type { FalsifyCardBlock, ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import { appendixStart } from "@/lib/agent/a4/blocks/reading";
import { cn } from "@/lib/utils";

import { BlockShell, BlocksProvider, ConfidenceBadge, InlineCites } from "./chrome";
import { printElement } from "./print";
import { BlockView } from "./renderers";
import { JudgmentOverview } from "./judgment-overview";

/**
 * 一份区块化报告在屏幕上的整体。
 *
 * ## 单栏
 *
 * 任务书 §3 定的。不是省事：这块面板的可用宽度在 24–40rem 之间浮动（判断板和知识关系
 * 共用同一栏），双栏在窄端的表现是每栏 12rem —— 那个宽度装不下一句口径脚注，也装不下
 * 一条 URL。单栏在任何宽度下都读得通，代价是长。
 *
 * ## 三样东西不在正文的流里
 *
 * - **章节导航**：从 `heading` 非空的块里数出来的，不另写一份目录 —— 所以不会出现
 *   「导航里有这一节、正文里没有」。
 * - **推翻条件常驻卡**：`falsify_card` 被提出来钉在底边（§3「常驻」）。正文里那一份因此
 *   不画，否则同一份条件一屏出现两遍，读起来像两组不同的条件。
 * - **筛选视图**：只看有核验证据支撑的那几节。这一枚开关回答的是他每次都会问的那一句
 *   「这里面哪些是真查到的」——而那个问题以前只能靠一枚枚点开证据芯片来答。
 *
 * ## 半份也渲染
 *
 * `streaming` 为真时下面接几条骨架：那时 JSONL 只到一半，正文可能先出来、证据表还没出来，
 * 于是满屏都是点不开的编号（`EvidenceChip` 的第三种状态）。这是**预期状态**，不是错误 ——
 * 任务书 §6④ 要的正是「截断的前缀可渲染，不白屏」。
 */
export function BlockReport({
  report,
  /** 这一条还在跑：下面接骨架，并且不把「证据表还没出来」当错误。 */
  streaming,
  className,
  onQuote,
}: {
  report: ReportBlocks;
  streaming?: boolean;
  className?: string;
  onQuote?: (text: string) => void;
}) {
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  /*
   * 「导出 PDF」印的就是这一块。ref 挂在报告体的最外层 —— 印的是他此刻屏幕上的这一份，
   * 不是另外拼一份「打印版」：两份迟早会分家，而分家的样子是他把一份和屏幕上不一样的
   * 东西发了出去。
   */
  const sheet = useRef<HTMLDivElement>(null);
  const split = appendixStart(report);

  const falsify = report.blocks.filter((b): b is FalsifyCardBlock => b.type === "falsify_card");
  const nav = report.blocks
    .map((b, i) => ({ heading: b.heading, i }))
    .filter((x) => x.i < split)
    .filter((x): x is { heading: string; i: number } => Boolean(x.heading));

  const verifiedCount = report.evidence.filter((e) => e.verified).length;

  /*
   * 这里只写材料截止那一天。
   *
   * 哪条链路跑的、跑了多久、什么时候跑的，摆在这一份的上面那一行（`ReportDoc`、
   * `SourceOnlyReport` 各自的页头）—— 每个落点都已经写了。在这里再写一遍的结果是同一栏里
   * 「跑了 214 秒」出现两次，而两次的算法万一走岔他会以为其中一个是别的东西的用时。
   *
   * 材料截止是这一行唯一说得出的新事实：报告有多新和它跑了多久是两件事，一份今早跑的报告
   * 完全可以只看到上个季度的材料。
   */
  /*
   * 「未确定」是 `materialCutoff` 明说的一档（2026-09-07，ISS-239），不是一个日期，所以
   * 中间加个冒号 —— 「材料截至 未确定」读起来像少了个词。这一档的意思是：这一轮台账里
   * 没有一条能算出报告期的公司材料，**不是**「还没算」。
   */
  const stamp = report.dataCutoff
    ? report.dataCutoff === "未确定"
      ? "材料截至：未确定"
      : `材料截至 ${report.dataCutoff}`
    : "";

  return (
    <BlocksProvider evidence={report.evidence} verifiedOnly={verifiedOnly}>
      <div ref={sheet} className={cn("mx-auto max-w-[42rem]", className)}>
        {/* 报告头。标题即判断，所以它排在最重的那一档，横幅块接在它后面说边界。 */}
        <header>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
            <h2 className="report text-xl min-w-0 font-medium text-ink">{report.title}</h2>
            <ConfidenceBadge confidence={report.confidence} className="shrink-0" />
          </div>
          {stamp && <p className="meta mt-1 text-ink-faint">{stamp}</p>}
        </header>

        {!streaming && <JudgmentOverview report={report} onQuote={onQuote} />}

        {/*
          证据一行数。**核验过的条数单独报**：一份「27 条证据」的报告和一份「27 条里 9 条
          核验过」的报告是两种东西，而它们的头部以前长得一样。

          证据包 id 也写在这里，写全不截断 —— 各条链路各自取证，所以每份报告的包 id 不同，
          而他核对「这两份到底看的是不是同一批材料」时靠的就是这一串。
        */}
        <div className="meta mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-hairline py-2 text-ink-faint">
          <span>
            证据 <span className="tabular-nums text-ink-muted">{report.evidence.length}</span> 条，核验过{" "}
            <span className="tabular-nums text-confirmed">{verifiedCount}</span> 条
          </span>
          {/*
            这两颗**只在屏幕上有意义**，所以打印时不印（`data-print-hide`）：
            「只看有核验支撑的」是一个开关，纸上按不动；「导出 PDF」印在 PDF 里是一句
            自指的废话。
          */}
          <button
            type="button"
            data-print-hide
            aria-pressed={verifiedOnly}
            onClick={() => setVerifiedOnly((v) => !v)}
            className={cn(
              "ml-auto shrink-0 rounded-[3px] transition-colors duration-fast",
              verifiedOnly
                ? "text-ink-muted underline decoration-hairline underline-offset-4"
                : "hover:text-ink-muted",
            )}
          >
            只看有核验支撑的
          </button>
          {/*
            导出 PDF —— 走浏览器自己的打印（整段理由在 `print.ts`）。**按钮上写的是
            「导出 PDF」而不是「打印」**：他要的是一份能发出去的文件，打印是实现这件事
            的手段，不是他的目的。按下去弹的是系统打印面板，那一步他自己选「另存为 PDF」。
          */}
          <button
            type="button"
            data-print-hide
            onClick={() => sheet.current && printElement(sheet.current, report.title)}
            title="用浏览器的「另存为 PDF」导出这一份"
            className="flex shrink-0 items-center gap-1 rounded-[3px] transition-colors duration-fast hover:text-ink-muted"
          >
            <FileDown className="size-3 shrink-0" aria-hidden />
            导出 PDF
          </button>
        </div>

        {nav.length > 1 && <details className="mt-3" data-print-hide><summary className="meta cursor-pointer text-ink-faint">论证目录 · {nav.length} 节</summary><SectionNav items={nav} /></details>}

        <div className="mt-6">
          {report.blocks.slice(0, split).map((b, i) => (
            <BlockView key={i} block={b} index={i} />
          ))}
        </div>

        {split < report.blocks.length && <details className="mt-7 rounded-lg border border-hairline px-4 py-3" data-report-appendix>
          <summary className="report cursor-pointer text-sm font-medium text-ink-muted">研究附录 · {report.blocks.length - split} 项论证与核验记录</summary>
          <div className="mt-5">{report.blocks.slice(split).map((b, i) => <BlockView key={split + i} block={b} index={split + i} />)}</div>
        </details>}

        {streaming && <Growing count={report.blocks.length} />}

        {report.bad?.length ? <BadLines bad={report.bad} /> : null}

        <EvidenceAppendix items={report.evidence} />

        {falsify.length > 0 && (
          <StandingFalsify
            cards={falsify}
            index={report.blocks.findIndex((b) => b.type === "falsify_card")}
          />
        )}
      </div>
    </BlocksProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* 章节导航                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 从块里数出来的目录。
 *
 * 用按钮 + `scrollIntoView`，不用 `#锚点` 链接：这块面板是个 SPA 里的滚动容器，
 * 改 URL 的 hash 会在他的地址栏里留下一串 `#blk-7`，而那个东西刷新之后指向另一份报告。
 */
function SectionNav({ items }: { items: { heading: string; i: number }[] }) {
  return (
    <nav aria-label="章节" className="meta mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-ink-faint">
      {items.map((x) => (
        <button
          key={x.i}
          type="button"
          onClick={() =>
            document.getElementById(`blk-${x.i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className="max-w-[14rem] truncate rounded-[3px] transition-colors duration-fast hover:text-ink-muted"
        >
          {x.heading}
        </button>
      ))}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* 还在长                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 还没交完的那几块。
 *
 * 三条骨架，不是一条转圈的 —— 骨架说的是「后面还有内容」，转圈说的是「等着」，而此刻
 * 上面已经有几块读得了。`count` 为 0 时多说一句：那时整屏只有骨架，他需要知道那不是坏了。
 */
function Growing({ count }: { count: number }) {
  return (
    <div className="mt-7">
      <div className="space-y-2.5" aria-hidden>
        <div className="skeleton h-4 w-2/5 rounded" />
        <div className="skeleton h-3 w-full rounded" />
        <div className="skeleton h-3 w-11/12 rounded" />
        <div className="skeleton h-3 w-3/4 rounded" />
      </div>
      <p className="meta mt-3 leading-relaxed text-ink-faint">
        {count === 0 ? "这一条刚开始交稿，还没有一块读得通的。" : "还在交后面几块。"}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 坏行记账                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 读不通的那几行。**留着**（`BadLine` 那条注释说的同一件事）：
 * 「交了 14 块坏了 2 行」和「只交了 12 块」不是一件事，而删掉记账之后它们长得一样。
 *
 * 默认折起来 —— 这是给我们看的账，不是给他看的内容。
 */
function BadLines({ bad }: { bad: NonNullable<ReportBlocks["bad"]> }) {
  return (
    <details className="mt-7 rounded-lg border border-dashed border-hairline-strong px-3.5 py-2.5">
      <summary className="meta cursor-pointer text-ink-faint">
        有 {bad.length} 行没读通 —— 那几块不在上面
      </summary>
      <ul className="mt-2 space-y-2">
        {bad.map((x, i) => (
          <li key={i} className="meta leading-relaxed">
            <span className="tabular-nums text-ink-muted">第 {x.line} 行</span>
            <span className="ml-2 text-counter">{x.why}</span>
            <pre className="scroll-slim scroll-x-only mt-1 rounded-[6px] bg-neutral-wash px-2 py-1.5 text-ink-faint">
              {x.text}
            </pre>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* 证据表附录（只在纸上）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 全份证据一条一行。**只在导出 PDF 时出现**（`.print-only`，globals.css）。
 *
 * 屏幕上不要这一段：那里每一枚 `[3]` 都点得开，点开就是这一条的全部（来源、口径、
 * 抓取时间、原文地址）。再在正文底下摊一份一模一样的表，等于把一件能按需展开的事
 * 变成永远占着二十屏的东西。
 *
 * 纸上必须有：印出来之后那些芯片点不动了。一份写着「据 [3] 显示」而全篇找不到 [3]
 * 是什么的 PDF，它的每一条引用都是死的 —— 而这份报告的全部分量就在那些引用上。
 * 这不是给 PDF 加内容，是把屏幕上已经有的东西换一种在纸上仍然成立的形式。
 */
function EvidenceAppendix({ items }: { items: ReportBlocks["evidence"] }) {
  if (items.length === 0) return null;
  return (
    <section className="print-only mt-8 border-t border-hairline pt-4">
      <h3 className="report text-md font-medium text-ink">证据表</h3>
      <p className="meta mt-1 text-ink-faint">
        正文里每一枚编号对应下面一条。核验过的那几条是本轮联网逐字定位过原句的。
      </p>
      <ol className="mt-3 space-y-2">
        {items.map((e) => (
          <li key={e.id} className="meta leading-relaxed">
            <span className="tabular-nums font-medium text-ink">
              [{e.id.replace(/^E/, "")}]
            </span>{" "}
            <span className="text-ink">{e.sourceName}</span>
            <span className="text-ink-faint">
              {" · "}
              {e.sourceType} · {e.grade} 级 · {e.verified ? "已核验原文" : "未核验"} ·{" "}
              {e.retrievedAt}
            </span>
            <span className="block text-ink-muted">{e.claim}</span>
            {e.url ? <span className="block break-all text-ink-faint">{e.url}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 推翻条件常驻卡                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 推翻条件那一张。**排在正文末尾，不再钉在底边。**
 *
 * 任务书 §3 写的是「常驻侧卡」，上一版把「常驻」落成了 `sticky bottom-0`。实际用起来
 * 那是错的：这块面板只有 24–42rem 宽，一条钉死的卡横在底边，正文永远从它底下穿过去 ——
 * 屏幕最底下那一行字被一张卡压着一半，读起来像渲染坏了。而「常驻」要的是「随时找得到」，
 * 不是「随时占着一条」：这份报告读到底就是它，中间想起来的话章节导航一行就跳回来。
 *
 * 撤掉 sticky 的同时那块贴底的挡片也没了 —— 它存在的全部理由是补 sticky 定位留下的
 * 那道缝（正文从钉住的卡底下穿过去的那 1.5rem）。定位没了，缝也没了。
 *
 * 默认仍然折起。折起那一行写条数：他读到这儿看到的是「推翻条件 3 条」，不是一句「详情」。
 */
function StandingFalsify({ cards, index }: { cards: FalsifyCardBlock[]; index: number }) {
  const conditions = cards.flatMap((c) => c.conditions);
  const indicators = cards.flatMap((c) => c.monitoringIndicators);

  return (
    <div className="mt-8">
      <details className="card overflow-hidden">
        <summary className="meta flex cursor-pointer items-baseline gap-2 px-3.5 py-2.5 text-ink-muted">
          <span className="font-medium text-counter">什么会推翻它</span>
          <span className="tabular-nums text-ink-faint">{conditions.length} 条</span>
          {indicators.length > 0 && (
            <span className="tabular-nums text-ink-faint">· 监控指标 {indicators.length} 项</span>
          )}
        </summary>
        {/* 套 `BlockShell` 是为了这几条里的 `[E1]` 点得开 —— 溯源卡开在这张卡自己底下。
            不套的话芯片点了没反应，而一枚点不开的芯片比没有芯片坏。 */}
        <BlockShell index={index} className="border-t border-hairline px-3.5 py-2.5" alwaysShow>
          <ul className="space-y-1.5">
            {conditions.map((c, i) => (
              <li key={i} className="meta flex gap-2 leading-relaxed">
                <span className="shrink-0 tabular-nums text-counter">{i + 1}</span>
                <span className="min-w-0 text-ink">
                  <InlineCites text={c} />
                </span>
              </li>
            ))}
          </ul>
          {indicators.length > 0 && (
            <div className="mt-2.5 border-t border-hairline pt-2.5">
              <p className="meta text-ink-faint">{indicators.join("、")}</p>
            </div>
          )}
        </BlockShell>
      </details>
    </div>
  );
}
