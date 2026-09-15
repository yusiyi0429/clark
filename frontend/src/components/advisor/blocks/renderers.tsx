"use client";

import { useMemo, useState } from "react";

import { compileExpr } from "@/lib/agent/a4/blocks/expr";
import type {
  BarCompareBlock,
  Block,
  CaliberMapBlock,
  DivergenceViewBlock,
  EvidenceListBlock,
  EvidenceUsageBlock,
  FunnelBlock,
  JudgmentBlock,
  KpiCardsBlock,
  LayeredTableBlock,
  ParamModelBlock,
  ProseBlock,
  ScenarioCardsBlock,
  UnverifiedPanelBlock,
  VerdictBannerBlock,
} from "@/lib/agent/a4/blocks/schema";
import { cn } from "@/lib/utils";

/**
 * 一根柱子的三档颜色。`i` 是**系列序号**，六个一循环。
 *
 * 分类色板在 `globals.css`（`--c1`…`--c6`）：色相取自 Okabe-Ito（色盲安全），
 * 明度彩度在 OKLCH 里按「对纸色和面色都 ≥3.2:1」重算过，顺序冷暖交替。
 *
 * **只在「几项互相比」的图上按序号取色。** 一个序列的多个阶段（比如漏斗）是同一件
 * 东西的不同刻度，全部用同一个色 —— 一段一个颜色会让人以为那是五类不同的东西。
 */
function barVars(i: number): React.CSSProperties {
  const n = (i % 6) + 1;
  return {
    "--bar": `var(--c${n})`,
    "--bar-dim": `var(--c${n}-dim)`,
  } as React.CSSProperties;
}

import {
  BlockShell,
  ConfidenceBadge,
  EvidenceChip,
  EvidenceRefs,
  GradeMark,
  InlineCites,
  inlineRefs,
  useBlocks,
} from "./chrome";

/**
 * 十五种块各自的样子。**一律用 `globals.css` 里已有的 token。**
 *
 * 任务书 §0 那条「继承主题变量，复刻它的气质、不复刻它的代码」在这里的落点很具体：
 * 没有一个 `#hex`、没有一处 `shadow-*`（内容层的边界一律是发丝线）、字号只从那七挡里取。
 * 一个组件自己发明第八挡字号，代价不是这一个组件不好看 —— 是整屏的字阶从此说不清。
 *
 * 每个渲染器都套 `BlockShell`：标题、章节锚点、溯源卡的落点、筛选视图的折叠都在那一层，
 * 十五处不各写一遍。
 */

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 数字排版。千分位 + 定宽数字 —— 一列数对不齐的话「哪个大」要一位一位数。
 *
 * 小数位按量级给：**1 以上留两位**（`12.5714 %` 这种四位小数是算出来的中间产物的样子，
 * 不是一个能写进结论的数），**1 以下留四位**（利用率、占比这类数第一位有效数字就在小数点
 * 后第三位，砍到两位会全变成 `0`）。
 */
const fmt = (n: number): string =>
  n.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });

/** 一段说明文字。列表里那些 `keyNumbers`、`assumptions` 都可能带行内引用。 */
function Line({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      <InlineCites text={text} />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 核心判断横幅                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 一份报告只有一个。**边界那一句和判断本身同等重要**，所以它不是小字附注 ——
 * 「在什么范围内成立」缺了的判断没法证伪，而一句没法证伪的判断在判断板上是死条目。
 */
function VerdictBanner({ b, index }: { b: VerdictBannerBlock; index: number }) {
  return (
    <BlockShell index={index} heading={b.heading}>
      <div className="card px-4 py-4">
        <div className="flex items-start gap-3">
          <ConfidenceBadge
            confidence={b.confidence}
            missing={b.defaulted?.includes("confidence")}
            className="mt-1 shrink-0"
          />
          <p className="report text-md min-w-0 flex-1 font-medium text-ink">
            <InlineCites text={b.text} />
          </p>
        </div>
        {b.boundary ? (
          <p className="meta mt-3 border-t border-hairline pt-2.5 leading-relaxed text-ink-muted">
            成立范围：
            <InlineCites text={b.boundary} />
          </p>
        ) : (
          <p className="meta mt-3 border-t border-hairline pt-2.5 leading-relaxed text-counter">
            没有写成立范围 —— 这条判断此刻推不倒也证不实。
          </p>
        )}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* KPI 卡                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 几个数。**口径脚注和数字同框**，不折起来。
 *
 * 折起来的那一版做过：一屏四个大字，口径要 hover 才看得到 —— 于是两个口径不同的数被摆在
 * 一起比，而屏幕上没有任何东西阻止这件事。口径是这几张卡存在的前提，不是补充说明。
 *
 * 一行两张，不是四张。窄面板里四张并排每张只有 6rem，那个宽度装不下一句口径（§6③）。
 */
function KpiCards({ b, index }: { b: KpiCardsBlock; index: number }) {
  const refs = b.cards.flatMap((c) => c.evidenceRefs);
  return (
    <BlockShell index={index} heading={b.heading} refs={refs}>
      <div className="grid gap-3 sm:grid-cols-2">
        {b.cards.map((c, i) => (
          <div key={i} className="card px-3.5 py-3">
            <p className="meta text-ink-faint">{c.label}</p>
            {/* `flex-wrap`：24rem 面板里「数 + 单位 + 增减」三段挤不进一行，不换行就顶出卡片外面。 */}
            <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-xl font-medium tabular-nums text-ink">{c.value}</span>
              {c.unit && <span className="meta text-ink-muted">{c.unit}</span>}
              {c.delta && <span className="meta tabular-nums text-judgment">{c.delta}</span>}
            </p>
            <p className="meta mt-2 leading-relaxed text-ink-muted">
              <Line text={c.caliberNote} />
            </p>
            <EvidenceRefs refs={c.evidenceRefs} className="mt-1.5" />
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 口径防火墙                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 每个指标答得出什么、答不出什么。窄面板里**不摆成四列表格** —— 四列各 7rem 的表格里
 * 「答不出什么」那一栏会折成六行，而它是这张表唯一的重点。所以一行一个指标，纵向排。
 */
function CaliberMap({ b, index }: { b: CaliberMapBlock; index: number }) {
  return (
    <BlockShell index={index} heading={b.heading}>
      <div className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline">
        {b.rows.map((r, i) => (
          <div key={i} className="px-3.5 py-3">
            <p className="text-sm font-medium text-ink">{r.metric}</p>
            <dl className="meta mt-1.5 space-y-1 leading-relaxed">
              {r.answersWhat && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-confirmed">答得出</dt>
                  <dd className="min-w-0 text-ink-muted">
                    <Line text={r.answersWhat} />
                  </dd>
                </div>
              )}
              {r.cannotAnswer && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-counter">答不出</dt>
                  <dd className="min-w-0 text-ink-muted">
                    <Line text={r.cannotAnswer} />
                  </dd>
                </div>
              )}
              {r.handling && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-faint">本报告</dt>
                  <dd className="min-w-0 text-ink-muted">
                    <Line text={r.handling} />
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 分层表                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 真的表格。**横向滚动关在自己的盒子里**（§3 最后一条）：让整个面板横滚的话，
 * 一屏正文会跟着走 —— 他在读第三节，滚一下第三节的标题跑出去了。
 *
 * 竖向不滚（`scroll-x-only`，别换回裸的 `overflow-x-auto`）：他读报告时鼠标本来就压在
 * 表格上，那一下滚轮要的是整页往下走。理由整段在那个类上面。
 */
function LayeredTable({ b, index }: { b: LayeredTableBlock; index: number }) {
  return (
    <BlockShell index={index} heading={b.heading} refs={b.evidenceRefs}>
      <div className="scroll-slim scroll-x-only rounded-lg border border-hairline">
        <table className="w-full min-w-max border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline bg-neutral-wash">
              {b.rowGrade && <th className="meta px-2 py-2 font-medium text-ink-faint">档</th>}
              {b.columns.map((c, i) => (
                <th key={i} className="meta px-3 py-2 font-medium whitespace-nowrap text-ink-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {b.rows.map((row, ri) => (
              <tr key={ri}>
                {b.rowGrade && (
                  <td className="px-2 py-2 align-top">
                    <GradeMark grade={b.rowGrade[ri]} />
                  </td>
                )}
                {b.columns.map((_, ci) => (
                  <td key={ci} className="px-3 py-2 align-top text-sm text-ink">
                    <Line text={row[ci] ?? ""} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <EvidenceRefs refs={b.evidenceRefs} className="mt-2" />
      {b.rowGrade?.includes("E") && (
        <p className="meta mt-1.5 text-ink-faint">带「估」的行是估算，不是取回来的数。</p>
      )}
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 漏斗                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 漏斗。**每一级掉了多少是它要说的话** —— 不写掉了多少的漏斗就是一排长短不一的条，
 * 而「装机到上架掉了四成」正是这一类报告的结论本身。
 *
 * 用 CSS 宽度画，不引图表库：一个横条图值不上一个运行时依赖，而 `width: 62%` 在窄面板里
 * 天然不会溢出。
 */
function Funnel({ b, index }: { b: FunnelBlock; index: number }) {
  const top = Math.max(...b.stages.map((s) => Math.abs(s.value)), 0);
  const refs = b.stages.flatMap((s) => inlineRefs(s.note ?? ""));
  return (
    <BlockShell index={index} heading={b.heading} refs={refs}>
      <div className="space-y-2.5">
        {b.stages.map((s, i) => {
          const prev = i > 0 ? b.stages[i - 1].value : null;
          const drop = prev && prev !== 0 ? 1 - s.value / prev : null;
          return (
            <div key={i}>
              <div className="meta flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink">{s.label}</span>
                <span className="shrink-0 tabular-nums text-ink-muted">
                  {fmt(s.value)}
                  {drop !== null && drop > 0 && (
                    <span className="ml-2 text-counter">−{(drop * 100).toFixed(0)}%</span>
                  )}
                </span>
              </div>
              {/* 一个漏斗是**一个序列**，所以五级同一个色（序号 0），只有长短不同。 */}
              <div className="bar-track sq mt-1.5 h-3 overflow-hidden">
                <div
                  className="bar-fill grow sq h-full"
                  style={{ ...barVars(0), width: `${top > 0 ? (Math.abs(s.value) / top) * 100 : 0}%` }}
                />
              </div>
              {s.note && (
                <p className="meta mt-1 leading-relaxed text-ink-faint">
                  <Line text={s.note} />
                </p>
              )}
            </div>
          );
        })}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 对比条                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 并排比几项。`nonAdditive` 为真时**不画占比、不画总量**。
 *
 * 那一栏不是排版开关，是拦一类具体的错：三家的「市场份额」口径各不相同，加起来 140% ——
 * 而画了占比的图会替读者把它们加起来。
 */
function BarCompare({ b, index }: { b: BarCompareBlock; index: number }) {
  const top = Math.max(...b.items.map((x) => Math.abs(x.value)), 0);
  const sum = b.items.reduce((a, x) => a + x.value, 0);
  const refs = b.items.flatMap((x) => inlineRefs(x.note ?? ""));
  return (
    <BlockShell index={index} heading={b.heading} refs={refs}>
      <div className="space-y-2.5">
        {b.items.map((x, i) => (
          <div key={i}>
            <div className="meta flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-ink">{x.label}</span>
              <span className="shrink-0 tabular-nums text-ink-muted">
                {fmt(x.value)}
                {!b.nonAdditive && sum > 0 && (
                  <span className="ml-2 text-ink-faint">{((x.value / sum) * 100).toFixed(0)}%</span>
                )}
              </span>
            </div>
            {/* 这里是**几项互相比**，所以每项一个分类色 —— 上一版全是同一个蓝，
                于是「哪根是谁」只能靠左边那行字，图本身没在帮忙。 */}
            <div className="bar-track sq mt-1.5 h-3 overflow-hidden">
              <div
                className="bar-fill grow sq h-full"
                style={{ ...barVars(i), width: `${top > 0 ? (Math.abs(x.value) / top) * 100 : 0}%` }}
              />
            </div>
            {x.note && (
              <p className="meta mt-1 leading-relaxed text-ink-faint">
                <Line text={x.note} />
              </p>
            )}
          </div>
        ))}
      </div>
      {b.nonAdditive && (
        <p className="meta mt-2.5 rounded-lg bg-counter-wash px-3 py-2 leading-relaxed text-counter">
          这几项口径不同，只可比较、不可相加 —— 所以这里不给占比，也不给总量。
        </p>
      )}
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 情景卡                                                                      */
/* -------------------------------------------------------------------------- */

/** 几种情景。触发指标排在最后且单独一档色 —— 那是唯一可以事后对账的一栏。 */
function ScenarioCards({ b, index }: { b: ScenarioCardsBlock; index: number }) {
  const refs = b.cards.flatMap((c) => [...c.assumptions, ...c.keyNumbers].flatMap(inlineRefs));
  return (
    <BlockShell index={index} heading={b.heading} refs={refs}>
      <div className="space-y-3">
        {b.cards.map((c, i) => (
          <div key={i} className="card px-3.5 py-3">
            <p className="text-md font-medium text-ink">{c.name}</p>
            {c.assumptions.length > 0 && (
              <Bullets label="前提" items={c.assumptions} />
            )}
            {c.keyNumbers.length > 0 && (
              <Bullets label="关键数" items={c.keyNumbers} />
            )}
            {c.triggerIndicators.length > 0 && (
              <Bullets label="触发指标" items={c.triggerIndicators} tone="text-judgment" />
            )}
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

function Bullets({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone?: string;
}) {
  return (
    <div className="mt-2.5">
      <p className={cn("meta font-medium", tone ?? "text-ink-faint")}>{label}</p>
      <ul className="mt-1 space-y-1">
        {items.map((x, i) => (
          <li key={i} className="meta flex gap-1.5 leading-relaxed text-ink-muted">
            <span className="shrink-0 text-ink-faint">·</span>
            <Line text={x} className="min-w-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 散文                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一段正文。空行断段，`[E1]` 变芯片，编号本身留在句子里。
 *
 * 用 `.report` 那副阅读嗓音（行高 1.85）和 `text-read`：这是整屏唯一要连读几分钟的东西，
 * 和四节压缩那一面用的是同一档 —— 换了档他会觉得区块页签「不是同一份报告」。
 */
function Prose({ b, index }: { b: ProseBlock; index: number }) {
  const paras = b.md
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <BlockShell index={index} heading={b.heading} refs={inlineRefs(b.md)}>
      <div className="space-y-4">
        {paras.map((p, i) => (
          <p key={i} className="report text-read text-ink">
            <InlineCites text={p} />
          </p>
        ))}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 判断                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一条判断 —— 判断板上那一条的来源。
 *
 * 证伪条件和升级条件**并排且都必须在屏幕上**：只有前者的判断永远升不上去，只有后者的
 * 判断永远推不倒。缺证伪条件时这里写红字，因为 `lint.ts` 会为它拦一轮重写（A4-B03）——
 * 那么屏幕上必须解释得出他为什么等了多一轮。
 */
function Judgment({ b, index }: { b: JudgmentBlock; index: number }) {
  return (
    <BlockShell index={index} heading={b.heading} refs={b.evidenceRefs}>
      <div className="rounded-lg border-l-2 border-judgment bg-judgment-wash/40 py-3 pr-3.5 pl-3.5">
        <div className="flex items-start gap-2.5">
          <ConfidenceBadge
            confidence={b.confidence}
            missing={b.defaulted?.includes("confidence")}
            className="mt-0.5 shrink-0"
          />
          <span
            className={cn(
              "text-micro mt-0.5 shrink-0 rounded-[3px] px-1.5 py-0.5 font-medium",
              b.defaulted?.includes("direction")
                ? "border border-dashed border-counter text-counter"
                : "bg-neutral-wash text-ink-muted",
            )}
            title={b.defaulted?.includes("direction") ? "模型没写它和标题那句命题的关系" : undefined}
          >
            {b.defaulted?.includes("direction") ? "未标关系" : b.direction}
          </span>
        </div>
        <p className="report text-md mt-2 font-medium text-ink">
          <InlineCites text={b.claim} />
        </p>
        {b.reasoningSummary && (
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            <InlineCites text={b.reasoningSummary} />
          </p>
        )}

        <dl className="meta mt-2.5 space-y-1.5 border-t border-hairline pt-2.5 leading-relaxed">
          <div className="flex gap-2">
            <dt className="w-[4.5rem] shrink-0 text-counter">什么会推翻</dt>
            <dd className={cn("min-w-0", b.falsifyCondition ? "text-ink-muted" : "font-medium text-counter")}>
              {b.falsifyCondition ? <Line text={b.falsifyCondition} /> : "没写 —— 这一条会被打回重写"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-[4.5rem] shrink-0 text-confirmed">什么会升档</dt>
            <dd className="min-w-0 text-ink-muted">
              {b.upgradeCondition ? <Line text={b.upgradeCondition} /> : "没写"}
            </dd>
          </div>
          {b.internalValidationHooks.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-[4.5rem] shrink-0 text-ink-faint">内部可裁</dt>
              <dd className="min-w-0 text-ink-muted">{b.internalValidationHooks.join("；")}</dd>
            </div>
          )}
        </dl>

        <EvidenceRefs refs={b.evidenceRefs} className="mt-2" />
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 未核验清单                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 查不到的那些。**虚线边 + 「未核验」**（§3）—— 这一节的存在本身是产品的一条纪律：
 * 查不到是合法结果（HP-5），但不许悄悄跳过。
 *
 * 两个影响面（真/假）并排摆，因为「它真不真」的价值恰恰等于两种结局的差 —— 差不大的话
 * 这一条不值得他花时间。
 */
function UnverifiedPanel({ b, index }: { b: UnverifiedPanelBlock; index: number }) {
  return (
    <BlockShell index={index} heading={b.heading} alwaysShow>
      <div className="space-y-3">
        {b.items.map((x, i) => (
          <div key={i} className="rounded-lg border border-dashed border-hairline-strong px-3.5 py-3">
            <div className="flex items-start gap-2">
              <span className="text-micro mt-0.5 shrink-0 rounded-[3px] bg-counter-wash px-1.5 py-0.5 font-medium text-counter">
                未核验
              </span>
              <p className="text-sm min-w-0 flex-1 leading-relaxed text-ink">
                <InlineCites text={x.statement} />
              </p>
            </div>
            <dl className="meta mt-2 space-y-1 leading-relaxed">
              {x.whyMatters && (
                <div className="flex gap-2">
                  <dt className="w-[4rem] shrink-0 text-ink-faint">为什么重要</dt>
                  <dd className="min-w-0 text-ink-muted">{x.whyMatters}</dd>
                </div>
              )}
              {x.whatWouldSettle && (
                <div className="flex gap-2">
                  <dt className="w-[4rem] shrink-0 text-ink-faint">什么能定它</dt>
                  <dd className="min-w-0 text-ink-muted">{x.whatWouldSettle}</dd>
                </div>
              )}
              {(x.impactIfTrue || x.impactIfFalse) && (
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  <div className="rounded-[6px] bg-confirmed-wash/50 px-2 py-1.5">
                    <p className="text-confirmed">若为真</p>
                    <p className="mt-0.5 text-ink-muted">{x.impactIfTrue || "没写"}</p>
                  </div>
                  <div className="rounded-[6px] bg-counter-wash/50 px-2 py-1.5">
                    <p className="text-counter">若为假</p>
                    <p className="mt-0.5 text-ink-muted">{x.impactIfFalse || "没写"}</p>
                  </div>
                </div>
              )}
            </dl>
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 证据清单                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 全报告的证据表。**按独立性组分块**，同组的排在一起、顶上写「共源×N」。
 *
 * 这是任务书 §4.2 第四条最要紧的落点：这张表是他核对「到底有几个独立来源」的地方，
 * 而一张按编号顺序平铺的表会让同一篇稿子的三份转载分散在 E1、E4、E9 三处 —— 数得出三条，
 * 数不出它们是一份材料。
 *
 * 表里的元数据一律取证据表（`registry.ts` 从台账折的），不取块里模型写的那一份：
 * 模型能把来源往弱改、不能往强改，而那条纪律在映射那一步就执行完了。
 */
function EvidenceList({ b, index }: { b: EvidenceListBlock; index: number }) {
  const { byId, groups } = useBlocks();

  // 按组归拢，组内保持清单里的顺序，组间按第一次出现的顺序。
  const order: string[] = [];
  const bucket = new Map<string, EvidenceListBlock["items"]>();
  for (const it of b.items) {
    const g = byId.get(it.id)?.independenceGroup ?? `未列:${it.id}`;
    if (!bucket.has(g)) {
      bucket.set(g, []);
      order.push(g);
    }
    bucket.get(g)?.push(it);
  }

  return (
    <BlockShell index={index} heading={b.heading} alwaysShow>
      <div className="space-y-2">
        {order.map((g) => {
          const items = bucket.get(g) ?? [];
          const cohort = groups.get(g) ?? items.length;
          return (
            <div
              key={g}
              className={cn(
                "rounded-lg border px-3.5 py-2.5",
                cohort > 1 ? "border-counter/40 bg-counter-wash/30" : "border-hairline",
              )}
            >
              {cohort > 1 && (
                <p className="meta mb-1.5 font-medium text-counter">
                  共源×{cohort} —— 下面这几条出自同一份材料，算一个来源
                </p>
              )}
              <ul className="space-y-1.5">
                {items.map((it) => {
                  const e = byId.get(it.id);
                  return (
                    <li key={it.id} className="meta flex gap-2 leading-relaxed">
                      <span className="shrink-0">
                        <EvidenceChip id={it.id} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink">{it.claim}</span>
                        {e && (
                          <span className="ml-1.5 text-ink-faint">
                            {e.sourceName} · {e.sourceType}
                            {!e.verified && <span className="ml-1 text-counter">未核验</span>}
                          </span>
                        )}
                        {(it.updateDirection ?? e?.updateDirection) && (
                          <span className="ml-1.5 text-judgment">
                            {(it.updateDirection ?? e?.updateDirection)?.effect}了「
                            {(it.updateDirection ?? e?.updateDirection)?.target}」
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 证据利用率对账                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 取回来的每一条去哪儿了。**弃用理由是这一块唯一的内容** —— 用上了的那几条在正文里到处
 * 都是，这里摆出来只为让他一眼看出分母；说不清的是那些取回来却没写进去的。
 *
 * 一份取回十八条、写进去六条的报告，在别的每一节前面都是干净的：数字都绑了编号、判断都有
 * 证伪条件。差的那十二条只在这一块上看得见（`lint.ts` 的 A4-B11 拦的就是它）。
 */
function EvidenceUsage({ b, index }: { b: EvidenceUsageBlock; index: number }) {
  const { byId } = useBlocks();
  const total = b.used.length + b.discarded.length;
  // 分母是这一块自己交代的两边之和，不是证据表的条数：证据表里还有模型既有知识那几条，
  // 它们不是这一轮检索的产出，算进利用率等于把记忆记成检索成绩。
  const rate = total ? Math.round((b.used.length / total) * 100) : 0;

  return (
    <BlockShell index={index} heading={b.heading} alwaysShow>
      <div className="rounded-lg border border-hairline px-3.5 py-3">
        <p className="meta text-ink-muted">
          取回 {total} 条，用上 {b.used.length} 条
          <span className="ml-1 tabular-nums text-ink">（{rate}%）</span>
          {b.discarded.length > 0 && `，弃用 ${b.discarded.length} 条`}
        </p>

        {b.used.length > 0 && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
            {b.used.map((id) => (
              <EvidenceChip key={id} id={id} />
            ))}
          </div>
        )}

        {b.discarded.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-hairline pt-2.5">
            {b.discarded.map((d) => (
              <li key={d.id} className="meta flex gap-2 leading-relaxed">
                <span className="shrink-0">
                  <EvidenceChip id={d.id} />
                </span>
                <span className="min-w-0 flex-1">
                  {d.reason ? (
                    <span className="text-ink-muted">{d.reason}</span>
                  ) : (
                    <span className="text-counter">没有写弃用理由</span>
                  )}
                  {byId.get(d.id) && (
                    <span className="ml-1.5 text-ink-faint">{byId.get(d.id)?.sourceName}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 分歧视图                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_TONE: Record<DivergenceViewBlock["adjudication"]["status"], string> = {
  已裁决: "bg-confirmed-wash text-confirmed",
  待裁决: "bg-judgment-wash text-judgment",
  欠定: "bg-counter-wash text-counter",
};

/**
 * 三条链路在同一命题上的分歧。**这是判断板的入口组件**（§3）。
 *
 * `keyBasis` 写的是依据不是立场：三条链路各自取证，所以分歧有两种来源 —— 同一批证据的
 * 两种读法，或者有一条压根没看到另一条抓回的那一页。只有写了具体依据才指得出是哪一种。
 *
 * 裁决方式那一枚必须和状态一起读：把「欠定」配上「事实核查」，读的人会以为再查一轮就有
 * 答案 —— 而欠定的意思正是「查不出来了，要么拿内部数据，要么承认这是先验判断」。
 * 那个组合 `lint.ts` 会拦（A4-B09），所以屏幕上它不该出现；出现了就说明那一轮漏了。
 */
function DivergenceView({ b, index }: { b: DivergenceViewBlock; index: number }) {
  const refs = b.positions.flatMap((p) => inlineRefs(p.keyBasis));
  return (
    <BlockShell index={index} heading={b.heading} refs={refs} alwaysShow>
      <div className="rounded-lg border border-hairline">
        <p className="report text-md border-b border-hairline px-3.5 py-2.5 font-medium text-ink">
          {b.topic}
        </p>
        <div className="divide-y divide-hairline">
          {b.positions.map((p, i) => (
            <div key={i} className="px-3.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="meta font-medium text-ink-muted">{p.lane}</span>
                <ConfidenceBadge confidence={p.confidence} />
                <span className="text-sm min-w-0 text-ink">{p.verdict}</span>
              </div>
              {p.keyBasis && (
                <p className="meta mt-1 leading-relaxed text-ink-faint">
                  依据：
                  <Line text={p.keyBasis} />
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-hairline bg-neutral-wash px-3.5 py-2.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={cn(
                "text-micro rounded-[3px] px-1.5 py-0.5 font-medium",
                STATUS_TONE[b.adjudication.status],
              )}
            >
              {b.adjudication.status}
            </span>
            <span className="meta text-ink-muted">怎么裁：{b.adjudication.method}</span>
          </div>
          {b.adjudication.note && (
            <p className="meta mt-1.5 leading-relaxed text-ink-muted">{b.adjudication.note}</p>
          )}
        </div>
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 参数化计算器                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 可复算的那一份。**算式由 `expr.ts` 求值，不执行模型给的 JS**（那条路要么间歇性坏掉，
 * 要么是个注入面）。
 *
 * 「电费占 30–50%」那次事故就是抄来的一个跨层占比 —— 所以 `layer` 那一行摆在最上面：
 * 一套算式属于哪一层（资产托管 / 算力租赁 / Token 生产）决定了它能不能搬。
 *
 * 算不出来的时候写「这组参数下算不出」，不写 `NaN`：屏幕上出现 `NaN` 的时候他分不出是
 * 算式错了还是参数拖到了边界。
 */
function ParamModel({ b, index }: { b: ParamModelBlock; index: number }) {
  const [vars, setVars] = useState<Record<string, number>>(() =>
    Object.fromEntries(b.params.map((p) => [p.id, p.default])),
  );
  const compiled = useMemo(
    () => b.outputs.map((o) => ({ ...o, expr: compileExpr(o.expr) })),
    [b.outputs],
  );
  const dirty = b.params.some((p) => vars[p.id] !== p.default);

  return (
    <BlockShell index={index} heading={b.heading}>
      <div className="card px-3.5 py-3">
        {b.layer && (
          <p className="meta text-ink-faint">
            这一套算式属于「{b.layer}」—— 换一层不成立。
          </p>
        )}

        <div className={cn("space-y-3", b.layer && "mt-2.5")}>
          {b.params.map((p) => (
            <div key={p.id}>
              <label className="meta flex items-baseline justify-between gap-3" htmlFor={`p-${index}-${p.id}`}>
                <span className="min-w-0 truncate text-ink-muted">{p.label}</span>
                <span className="shrink-0 tabular-nums text-ink">
                  {fmt(vars[p.id] ?? p.default)}
                  {p.unit && <span className="ml-1 text-ink-faint">{p.unit}</span>}
                </span>
              </label>
              <input
                id={`p-${index}-${p.id}`}
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={vars[p.id] ?? p.default}
                onChange={(ev) => setVars((v) => ({ ...v, [p.id]: Number(ev.target.value) }))}
                /* `--fill` 是已填充段的百分比，交给 CSS 画轨道 —— 算在这里是因为
                   只有组件手上有 min/max/当前值这三个数。 */
                style={
                  {
                    "--fill": `${p.max > p.min ? (((vars[p.id] ?? p.default) - p.min) / (p.max - p.min)) * 100 : 0}%`,
                  } as React.CSSProperties
                }
                className="slider mt-0.5"
              />
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
          {compiled.map((o, i) => {
            const value = o.expr.ok ? o.expr.expr.run(vars) : null;
            return (
              <div key={i} className="flex items-baseline justify-between gap-3">
                <span className="meta min-w-0 truncate text-ink-muted">{o.label}</span>
                <span className="text-md shrink-0 font-medium tabular-nums text-ink">
                  {!o.expr.ok ? (
                    <span className="meta font-normal text-counter" title={o.expr.why}>
                      算式读不通
                    </span>
                  ) : value === null ? (
                    <span className="meta font-normal text-counter">这组参数下算不出</span>
                  ) : (
                    <>
                      {fmt(value)}
                      {o.unit && <span className="meta ml-1 font-normal text-ink-faint">{o.unit}</span>}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
          <p className="meta min-w-0 leading-relaxed text-ink-faint">{b.disclaimer}</p>
          {dirty && (
            <button
              type="button"
              onClick={() => setVars(Object.fromEntries(b.params.map((p) => [p.id, p.default])))}
              className="meta shrink-0 rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
            >
              回到报告里那组数
            </button>
          )}
        </div>
      </div>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 派发                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一个块渲染成什么。
 *
 * `falsify_card` 不在这里 —— 它被外层提到常驻卡里（§3「推翻条件卡常驻」），在正文里
 * 不占位置。两处都画的话同一份推翻条件在一屏里出现两遍，而他会以为那是两组不同的条件。
 */
export function BlockView({ block, index }: { block: Block; index: number }) {
  switch (block.type) {
    case "verdict_banner":
      return <VerdictBanner b={block} index={index} />;
    case "kpi_cards":
      return <KpiCards b={block} index={index} />;
    case "caliber_map":
      return <CaliberMap b={block} index={index} />;
    case "layered_table":
      return <LayeredTable b={block} index={index} />;
    case "funnel":
      return <Funnel b={block} index={index} />;
    case "bar_compare":
      return <BarCompare b={block} index={index} />;
    case "scenario_cards":
      return <ScenarioCards b={block} index={index} />;
    case "prose":
      return <Prose b={block} index={index} />;
    case "judgment":
      return <Judgment b={block} index={index} />;
    case "unverified_panel":
      return <UnverifiedPanel b={block} index={index} />;
    case "evidence_list":
      return <EvidenceList b={block} index={index} />;
    case "evidence_usage":
      return <EvidenceUsage b={block} index={index} />;
    case "divergence_view":
      return <DivergenceView b={block} index={index} />;
    case "param_model":
      return <ParamModel b={block} index={index} />;
    case "falsify_card":
      // 提到常驻卡里去了。这里返回 null 而不是不派发 —— 少一个 case 会让编译器在下次加块
      // 类型时不再报「有一种块没画」，而那条报警是这个 switch 最值钱的地方。
      return null;
  }
}
