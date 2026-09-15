"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import type {
  CrawledSignalInput,
  InboxSignal,
  InboxSignalMeta,
  ScanRound,
} from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { formatScanCadence, scanCadence } from "@/lib/scan/cadence";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 潜在议题 · 扫描记录：每一轮扫描提名了什么，一条不落，标题就是原文的链接。
 *
 * 为什么要有这一页（一号位的原话）：机器在「这条信号会不会动到公司战略」那一步的
 * 判断不一定比他深，所以他要能回头**自己瞅一眼**机器提名了什么。于是这一页跟
 * 「待挑的信号」那一页的取舍正好相反：
 *
 *   · 待挑那一页只留**未处置**的，处置过就从屏幕上走掉 —— 那一页是干活的地方；
 *   · 这一页什么都留，包括他按过「不看了」的、以及 A1a 判成噪音的那些 —— 这一页是
 *     回头核对的地方，而被判掉的那几条恰恰是最该被核对的。
 *
 * 这份记录**不是**「机器看过的全部」，有两条边界（都不写在屏幕上）：
 *
 *   1. **只有过线的才在这里。** 没过线的（分数低于阈值）从来没到正式版这一侧，它们
 *      不在这一页上 —— 每组抬头的那个编号是这一轮扫描的号，日志里按它能看到完整漏斗。
 *   2. **收件柜封顶 200 条**，满了先丢已处置的，所以这份记录会从尾巴上变短。
 *
 * ## 一条都没过线的那一轮也在这里
 *
 * 它靠的是另一份账（`ScanRound`，扫完就落一条），不是从信号反推的。那一轮在屏幕上
 * 是一行「这一轮没有过线的东西」—— 说的是雷达按时看过一遍、外面确实没有值得他看的
 * 东西。少了它，这一页在「扫过但空手」和「压根没扫」之间是沉默的，而这一页存在的
 * 理由正是回答后一个问题。
 */
export function SignalsScansView() {
  const resource = useResource<{ rounds: ScanRound[]; signals: InboxSignal[] }>(
    "signals-nominated",
    () => api.listNominatedSignals()
  );

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<ScansSkeleton />}>
        {({ rounds, signals }) => <Scans rounds={rounds} signals={signals} />}
      </AsyncBoundary>
    </Panel>
  );
}

/**
 * 一轮扫描 = 一个 `runId`。同一轮里分数高的在前。只包含抓取的信号。
 *
 * `nominated` 是那一轮当时收下的条数（来自 `ScanRound`），可能比 `signals` 长 ——
 * 收件柜封顶把那几条挤掉了。没有账的老批次（这份账是后来才有的）就没有这个值。
 */
type Batch = {
  runId: string;
  scannedAt: string;
  nominated?: number;
  signals: (CrawledSignalInput & InboxSignalMeta)[];
};

function groupByRun(rounds: ScanRound[], signals: InboxSignal[]): Batch[] {
  /*
   * 按 `runId` 收进一张表，而不是「相邻就是同一轮」。
   *
   * 相邻那种写法在正常情况下也对（一批信号共用一个 `scanned_at`，store 又按它倒序），
   * 但两轮撞上同一个时间戳时会把一轮切成两组 —— 屏幕上就是同一个 run id 出现两次。
   * 这里多一个 Map，少一个只在半夜出现的怪现象。
   */
  const byRun = new Map<string, Batch>();
  // 扫描记录页只显示抓取的那一支 —— 人报的没有 runId / scannedAt。
  const crawled = signals.filter((s): s is CrawledSignalInput & InboxSignalMeta => s.kind === "crawled");
  for (const s of crawled) {
    const cur = byRun.get(s.runId);
    if (cur) cur.signals.push(s);
    else byRun.set(s.runId, { runId: s.runId, scannedAt: s.scannedAt || s.receivedAt, signals: [s] });
  }

  /*
   * 再把扫描账并进来。**两份数据取的是并集**：
   *
   *   · 账里有、信号里没有 —— 那一轮没有过线的东西（或者收下的那几条已被挤掉），
   *     这就是这份账的用处，补一个空组；
   *   · 信号里有、账里没有 —— 这份账是后来才有的，老批次照旧从信号反推。
   */
  for (const r of rounds) {
    const cur = byRun.get(r.runId);
    if (cur) cur.nominated = r.nominated;
    else byRun.set(r.runId, { runId: r.runId, scannedAt: r.scannedAt, nominated: r.nominated, signals: [] });
  }

  // 并集之后顺序得自己排一次：Map 的插入顺序里，补进来的空组全在尾巴上。
  return [...byRun.values()].sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

function Scans({ rounds, signals }: { rounds: ScanRound[]; signals: InboxSignal[] }) {
  const batches = groupByRun(rounds, signals);
  /*
   * 节奏就地从这一页已经拿到的 `rounds` 算 —— 它和 `getScanCadence` 读的是同一张台账，
   * 再走一趟接口只会换来一份可能比屏幕上这一份新半秒的数，那正是同一页上两个数的来路。
   * 算法和措辞只有一处出处（`scanCadence` / `formatScanCadence`），三个页面同一句。
   *
   * 它不在空态里：走到空态就意味着台账上一轮都没有，那时这一句恒为空。
   */
  const rhythm = formatScanCadence(scanCadence(rounds));

  return (
    <>
      <PanelHead
        eyebrow={`潜在议题 · 扫描记录 · ${batches.length} 轮 · ${signals.length} 条`}
        title="每一轮扫描提名了什么。"
        actions={
          <Link
            href="/signals"
            className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
          >
            回潜在议题 →
          </Link>
        }
      />

      {/* 台账上真发生过的节奏。算不出来就不渲染这一行，不拿话填。 */}
      {rhythm ? <p className="meta -mt-4 text-ink-faint">{rhythm}</p> : null}

      {batches.length === 0 ? (
        <PanelEmpty title="还没有扫描记录。" />
      ) : (
        <div className="mt-7 space-y-7">
          {batches.map((b, bi) => (
            <section key={b.runId} className="stagger" style={{ "--i": bi } as React.CSSProperties}>
              <div className="meta flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-faint">
                <span className="tabular-nums text-ink-muted">{formatStamp(b.scannedAt)}</span>
                <span>提名 {b.nominated ?? b.signals.length} 条</span>
                {/* run id 是「这一轮到底按什么参数抓的」的唯一入口，所以原样露出来。 */}
                <span className="tabular-nums">{b.runId || "没有记下 run id"}</span>
              </div>

              {/*
               * 这一轮底下一条都没有。两种来路，说的话不一样 —— 混成一句「没有内容」
               * 就等于把一次合格的空扫说成一次数据丢失：
               *
               *   · 提名 0 条 —— 雷达扫过了，外面没有过线的东西。这是合格输出。
               *   · 提名过几条但都不在了 —— 收件柜封顶把它们挤掉了，条数还在账上。
               */}
              {b.signals.length === 0 ? (
                /* 空组不套那张卡：一张空的 `.card` 在屏幕上是一个什么都没装的框。 */
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  {b.nominated
                    ? `这一轮提名的 ${b.nominated} 条已经从收件柜里挤掉了。`
                    : "这一轮没有过线的东西 —— 扫过了，外面没有值得端给您的。"}
                </p>
              ) : (
                <ul className="card mt-2.5 overflow-hidden">
                  {b.signals.map((sig) => (
                    /* `row concentric` 挂在 `<li>` 上：缝里那条发丝线是 `.row + .row` 画的，只认相邻兄弟。 */
                    <li key={sig.dedupeKey} className="row concentric px-3.5 py-3">
                      <div className="flex items-baseline gap-2.5">
                        <span
                          className={cn(
                            "meta tabular-nums font-medium",
                            sig.score >= 4.5 ? "text-confirmed" : "text-ink-muted"
                          )}
                        >
                          {sig.score.toFixed(1)}
                        </span>
                        <a
                          href={sig.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 text-md leading-relaxed text-ink underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:decoration-ink-faint"
                        >
                          {sig.title}
                        </a>
                      </div>

                      <div className="meta mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-faint">
                        <span>{sig.source || "未标来源"}</span>
                        {sig.publishedAt ? <span>{formatStamp(sig.publishedAt)}</span> : null}
                        {sig.kiq ? <span>{sig.kiq}</span> : null}
                        {sig.origin === "discovered" ? <span>作业自己提名的源</span> : null}
                        <Outcome sig={sig} />
                      </div>

                      {sig.why ? (
                        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{sig.why}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 这一条后来怎么了。
 *
 * 「A1a 判为噪音」用中性色而不是报错色：那是一个正经结论，不是故障。而它恰恰是
 * 一号位最想复核的一档 —— 机器在这一步的判断可能比他浅。
 */
function Outcome({ sig }: { sig: InboxSignal }) {
  if (!sig.disposedAs) return <span className="text-ink-muted">还在待挑</span>;
  if (sig.disposedAs === "watch") return <span>他记为待定</span>;
  if (sig.disposedAs === "dismiss") return <span>他记了不看了</span>;

  // disposedAs === "issue"：他按过「开成议题」，接着看 A1a 那一轮的结论。
  const judged = sig.judged;
  if (!judged) return <span className="text-ink-muted">他开成议题（还没有结论）</span>;
  if (judged.status === "failed") return <span className="text-ink-muted">他开成议题 · 那一轮没跑成</span>;
  if (judged.status === "ignored" || judged.route === "ignore") {
    return <span className="text-ink-muted">他开成议题 · 机器判为噪音</span>;
  }
  return (
    <span className="text-confirmed">
      他开成议题 · {judged.route === "update_issue" ? "机器判为取代既有议题" : "机器判为新议题"}
    </span>
  );
}

function ScansSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-52" />
      <span className="skeleton mt-2.5 block h-5 w-[48%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="mt-7 space-y-7">
        {[0, 1].map((b) => (
          <div key={b}>
            <span className="skeleton block h-2.5 w-40" />
            <div className="card mt-2.5 overflow-hidden">
              {[0, 1].map((i) => (
                <div key={i} className="row concentric px-3.5 py-3">
                  <span className="skeleton block h-4 w-[74%]" />
                  <span className="skeleton mt-2 block h-2.5 w-52" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
