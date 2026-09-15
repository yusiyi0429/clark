"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { groupSizes } from "@/lib/agent/a4/blocks/registry";
import type {
  BlockEvidence,
  Confidence,
  RowGrade,
  SourceType,
} from "@/lib/agent/a4/blocks/schema";
import { cn } from "@/lib/utils";

/**
 * 区块报告的共用零件：置信徽章、证据芯片、溯源卡、共源折叠。
 *
 * 十五个渲染器都从这里取，而不是各写一份 —— 「这一枚编号点开长什么样」在十五处各写一遍
 * 的结果是同一条证据在 KPI 卡上写着「已核验」、在正文里没写，而两处读的是同一行数据。
 *
 * ## 溯源卡为什么长在块底下，不是浮在芯片旁边
 *
 * 这块面板窄（正文 42rem，实际可用常常不到 30rem），而溯源卡要装来源全名、时点、地址、
 * 独立性 —— 一张 20rem 的浮层从行末那枚芯片下面弹出来会顶穿右边界。任务书 §6③ 那条
 * 「窄面板无横向溢出」不是排版偏好，是**溢出之后地址那一行读不完**。
 *
 * 所以卡片开在那个块的底部，占满一栏宽，芯片上留一道下划线指认是哪一枚点开的。代价是
 * 眼睛要往下走一段；换来的是不用测量、不会溢出、缩到手机宽度也一样。
 */

/* -------------------------------------------------------------------------- */
/* 上下文                                                                      */
/* -------------------------------------------------------------------------- */

interface BlocksValue {
  byId: Map<string, BlockEvidence>;
  /** 每个独立性组里有几条。「共源×3」数的是这个。 */
  groups: Map<string, number>;
  /** 此刻点开的那一枚：`${块序号}:${编号}`。同时只开一枚 —— 开一屏卡片等于把证据表复读一遍。 */
  open: string | null;
  toggle: (key: string) => void;
  /** 只看有核验证据支撑的那几节。 */
  verifiedOnly: boolean;
}

const BlocksCtx = createContext<BlocksValue | null>(null);

/** 当前块的序号。芯片靠它算 `open` 的键，不用把 index 一层层传进散文里。 */
const IndexCtx = createContext<number>(-1);

export function useBlocks(): BlocksValue {
  const v = useContext(BlocksCtx);
  if (!v) throw new Error("useBlocks 只能在 BlocksProvider 里用");
  return v;
}

export function BlocksProvider({
  evidence,
  verifiedOnly,
  children,
}: {
  evidence: BlockEvidence[];
  verifiedOnly: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const value = useMemo<BlocksValue>(
    () => ({
      byId: new Map(evidence.map((e) => [e.id, e] as const)),
      groups: groupSizes(evidence),
      open,
      toggle: (key: string) => setOpen((cur) => (cur === key ? null : key)),
      verifiedOnly,
    }),
    [evidence, open, verifiedOnly],
  );
  return <BlocksCtx.Provider value={value}>{children}</BlocksCtx.Provider>;
}

/* -------------------------------------------------------------------------- */
/* 置信与来源的记号                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 四挡置信各自的色。
 *
 * 只有最高那一挡用实心 —— 一屏里实心块的数量就是「这份报告有多硬」的第一眼答案，
 * 四挡全用实心的话那个信号消失了。
 */
const CONFIDENCE_TONE: Record<Confidence, string> = {
  初步提示: "bg-neutral-wash text-ink-faint",
  当前更支持: "bg-judgment-wash text-judgment",
  较强支持: "bg-confirmed-wash text-confirmed",
  接近确证: "bg-solid text-solid-fg",
};

export function ConfidenceBadge({
  confidence,
  missing,
  className,
}: {
  confidence: Confidence;
  /**
   * 模型压根没写分档（`defaulted` 里有 `confidence`）。
   *
   * 这一枚要和「它写了初步提示」分得出来：填进去的默认值在屏幕上和真写的一模一样，
   * 而前一种是违纪（`lint.ts` 的 A4-B03 会拦），后一种是一句诚实的弱结论。
   */
  missing?: boolean;
  className?: string;
}) {
  if (missing) {
    return (
      <span
        title="模型没有给出置信分档 —— 这一挡是补上的默认值，不是它的判断"
        className={cn(
          "text-micro rounded-[3px] border border-dashed border-counter px-1.5 py-0.5 font-medium text-counter",
          className,
        )}
      >
        未标分档
      </span>
    );
  }
  return (
    <span
      className={cn(
        "text-micro rounded-[3px] px-1.5 py-0.5 font-medium",
        CONFIDENCE_TONE[confidence],
        className,
      )}
    >
      {confidence}
    </span>
  );
}

/**
 * 谁在说这句话，在屏幕上长什么样。
 *
 * `mark` 只给三档：厂商宣传、内部DOC、模型既有知识。任务书 §3 单独点了这三种要有区别记号，
 * 理由是它们**读起来都像事实**而来路完全不同 —— 一句厂商宣传里的产能数字和一句官方统计里
 * 的产能数字措辞一样精确。剩下几档靠颜色区分就够：它们的差别在强弱，不在性质。
 */
const SOURCE_MARK: Record<SourceType, { tone: string; mark?: string }> = {
  官方一手: { tone: "text-factual" },
  公司披露: { tone: "text-factual" },
  学术论文: { tone: "text-factual" },
  行业机构: { tone: "text-ink-muted" },
  媒体转述: { tone: "text-ink-muted" },
  厂商宣传: { tone: "text-counter", mark: "宣" },
  内部DOC: { tone: "text-confirmed", mark: "内" },
  模型既有知识: { tone: "text-judgment", mark: "记" },
  来路不明: { tone: "text-ink-faint", mark: "?" },
};

const GRADE_TONE: Record<RowGrade, string> = {
  A: "text-factual",
  B: "text-ink-muted",
  C: "text-ink-faint",
  E: "text-counter",
};

/** 分层表那一列的档次标记。`E` 是估算 —— 它和 A/B/C 不是一个量纲，所以写全称。 */
export function GradeMark({ grade }: { grade: RowGrade }) {
  return (
    <span
      title={grade === "E" ? "这一行是估算，不是取回来的数" : `证据档次 ${grade}`}
      className={cn("text-micro font-medium tabular-nums", GRADE_TONE[grade])}
    >
      {grade === "E" ? "估" : grade}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 证据芯片                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一枚编号。点开是溯源卡。
 *
 * 三种状态在屏幕上必须分得出来：
 * - 过了核验的（台账里逐字定位过原文）—— 实线，按来源上色；
 * - 没过核验的（模型的既有知识、查不到原文的）—— **虚线下划**，任务书 §3 那条；
 * - 证据表里压根没有这个编号（悬空引用）—— 点不开，划掉。悬空引用由 `lint.ts` 报 p0，
 *   所以正常情况下他看不到这一种；但流式跑到一半时正文先出来、证据表还没出来，
 *   那期间满屏都是这一种，所以它不能长得像错误。
 */
export function EvidenceChip({ id }: { id: string }) {
  const { byId, groups, open, toggle } = useBlocks();
  const index = useContext(IndexCtx);
  const e = byId.get(id);

  if (!e) {
    return (
      <span
        title={`证据表里还没有 ${id} —— 正文先写出来了，或者这一条没有入列`}
        className="text-micro ml-[1px] align-super font-medium tabular-nums text-ink-faint"
      >
        [{id.replace(/^E/, "")}]
      </span>
    );
  }

  const key = `${index}:${id}`;
  const style = SOURCE_MARK[e.sourceType];
  const cohort = groups.get(e.independenceGroup) ?? 1;
  const title = [
    e.sourceName,
    e.sourceType,
    `${e.grade} 级`,
    e.verified ? "已核验原文" : "未核验",
    cohort > 1 ? `共源×${cohort}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      title={title}
      aria-expanded={open === key}
      onClick={() => toggle(key)}
      className={cn(
        "text-micro ml-[1px] rounded-[2px] align-super font-medium tabular-nums transition-colors duration-fast",
        style.tone,
        e.verified ? "hover:underline hover:underline-offset-2" : "underline decoration-dashed decoration-from-font underline-offset-2",
        open === key && "bg-wash-hover",
      )}
    >
      [{e.id.replace(/^E/, "")}
      {style.mark ?? ""}]
    </button>
  );
}

/**
 * 块上那一排 `evidenceRefs`。**同一个独立性组只出一枚芯片，后面跟「共源×N」。**
 *
 * 这是任务书 §4.2 第四条在屏幕上的那一半：三份转载摆成三枚芯片，读的人数出三个来源 ——
 * 那是这套东西最容易骗过自己的地方，而它骗的是自己人。校验器那一半拦的是「拿它们当三方
 * 独立印证」，这一半保证的是**屏幕上数不出三个来**。
 */
export function EvidenceRefs({ refs, className }: { refs: string[]; className?: string }) {
  const { byId, groups } = useBlocks();
  if (!refs.length) return null;

  // 按独立性组折。不在证据表里的编号自己一组（否则它们会挤进同一个 `undefined` 组，
  // 屏幕上写成「共源×4」——而它们之间毫无关系）。
  const seen = new Set<string>();
  const shown: { id: string; cohort: number; hidden: string[] }[] = [];
  for (const id of refs) {
    const g = byId.get(id)?.independenceGroup ?? `未列:${id}`;
    if (seen.has(g)) {
      const first = shown.find((x) => (byId.get(x.id)?.independenceGroup ?? `未列:${x.id}`) === g);
      first?.hidden.push(id);
      continue;
    }
    seen.add(g);
    shown.push({ id, cohort: groups.get(g) ?? 1, hidden: [] });
  }

  return (
    <span className={cn("meta inline-flex flex-wrap items-baseline gap-x-1.5 text-ink-faint", className)}>
      {shown.map((x) => (
        <span key={x.id} className="whitespace-nowrap">
          <EvidenceChip id={x.id} />
          {x.hidden.length > 0 && (
            <span
              title={`${[x.id, ...x.hidden].join("、")} 出自同一份材料 —— 算一个来源，不算 ${x.hidden.length + 1} 个`}
              className="text-micro ml-1 rounded-[3px] bg-counter-wash px-1 py-px font-medium text-counter"
            >
              共源×{x.hidden.length + 1}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 溯源卡                                                                      */
/* -------------------------------------------------------------------------- */

/** 这个块里此刻点开的那一枚编号（没有就是 `null`）。 */
function openedIn(index: number, open: string | null): string | null {
  if (!open) return null;
  const at = open.indexOf(":");
  return at > 0 && Number(open.slice(0, at)) === index ? open.slice(at + 1) : null;
}

/**
 * 溯源卡。一枚编号背后的全部东西。
 *
 * 地址不做成可点的链接：这一层是产品自己的面，点出去要新开一个标签页，而他此刻在读一份
 * 报告。写全 host 就够对账 —— 要打开的话选中复制，那一步是他自己的决定。
 *
 * 「共源」那一行列的是同组的**全部**编号，包括这个块没引到的：他点开这一枚要问的正是
 * 「这条到底有几个独立来源」，而答案不取决于这一节引了几个。
 */
function SourceCard({ id }: { id: string }) {
  const { byId, groups } = useBlocks();
  const e = byId.get(id);
  if (!e) return null;

  const cohort = groups.get(e.independenceGroup) ?? 1;
  const style = SOURCE_MARK[e.sourceType];

  return (
    <div
      className={cn(
        "animate-fade mt-3 rounded-lg border px-3.5 py-3",
        e.verified ? "border-hairline bg-neutral-wash" : "border-dashed border-counter bg-counter-wash/40",
      )}
    >
      <div className="meta flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium tabular-nums text-ink">{e.id}</span>
        <span className={cn("font-medium", style.tone)}>{e.sourceType}</span>
        <span className="text-ink-faint">{e.grade} 级</span>
        {e.verified ? (
          <span className="text-confirmed">已核验原文</span>
        ) : (
          <span className="font-medium text-counter">未核验</span>
        )}
        {cohort > 1 && <span className="text-counter">共源×{cohort}</span>}
        {e.origin === "model" && (
          <span title="这一条来自模型自己的记忆，不是这一轮取回来的" className="text-judgment">
            模型既有知识
          </span>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink">{e.claim}</p>

      <dl className="meta mt-2 space-y-1 text-ink-muted">
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-faint">来源</dt>
          <dd className="min-w-0 break-words">{e.sourceName}</dd>
        </div>
        {e.retrievedAt && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">取回</dt>
            <dd className="tabular-nums">{e.retrievedAt}</dd>
          </div>
        )}
        {e.url && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">地址</dt>
            {/* `break-all`：一条 URL 里没有可断行的空白，不许它自己撑宽整栏（§6③）。 */}
            <dd className="min-w-0 break-all">{e.url}</dd>
          </div>
        )}
        {e.updateDirection && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">作用</dt>
            <dd className="min-w-0">
              {e.updateDirection.effect}了「{e.updateDirection.target}」
            </dd>
          </div>
        )}
      </dl>

      {!e.verified && (
        <p className="meta mt-2 leading-relaxed text-counter">
          这一条这一轮没有联网核到原文。当成线索读，不当成事实。
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 块外壳                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 每个块的外壳：标题、序号上下文、点开的溯源卡、以及筛选视图下的折叠。
 *
 * 标题上的 `id` 是章节导航的落点 —— 导航是从块里数出来的（`heading` 非空的那几个），
 * 不另写一份目录，所以不会出现「导航里有这一节、正文里没有」。
 */
export function BlockShell({
  index,
  heading,
  /** 这个块引了哪些证据。给了就参与筛选视图，也决定溯源卡开在哪。 */
  refs = [],
  /** 这个块的性质就是「没有核验」（未核验清单、分歧视图），筛选视图不折它。 */
  alwaysShow,
  /**
   * 覆盖节间距。留给不在正文流里的那一份 —— 推翻条件常驻卡也要能点开溯源卡，而它挂在
   * 底边的一条 `details` 里，正文那一档 `mt-7` 在那里会顶出一道空隙。
   */
  className = "mt-7 first:mt-0",
  children,
}: {
  index: number;
  heading?: string;
  refs?: string[];
  alwaysShow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { byId, open, verifiedOnly } = useBlocks();
  const opened = openedIn(index, open);

  const cited = refs.filter((r) => byId.has(r));
  const anyVerified = cited.some((r) => byId.get(r)?.verified);
  const folded = verifiedOnly && !alwaysShow && cited.length > 0 && !anyVerified;

  return (
    <IndexCtx.Provider value={index}>
      <section className={className}>
        {heading && (
          <h3 id={`blk-${index}`} className="report scroll-mt-4 text-lg font-medium text-ink">
            {heading}
          </h3>
        )}
        {folded ? (
          <p className="meta mt-2 rounded-lg border border-dashed border-hairline-strong px-3.5 py-2.5 leading-relaxed text-ink-faint">
            这一节引到的 {cited.length} 条证据没有一条过了核验 —— 筛选视图下折起来了。
          </p>
        ) : (
          <>
            <div className={heading ? "mt-3" : undefined}>{children}</div>
            {opened && <SourceCard id={opened} />}
          </>
        )}
      </section>
    </IndexCtx.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* 行内引用                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 正文里的 `[E1]`、`[E3, E7]`、`[E3][E7]` 渲染成芯片。
 *
 * 正则和 `registry.ts` 的 `INLINE_CITE` 是同一个形状（那里也抄了 `gate.ts` 的）——
 * 三处走岔的后果是校验器数到的编号和屏幕上点得开的编号不是同一批。加 `\[` 前的
 * 捕获分组是因为这里要**保留原文**：编号本身留在句子里（任务书 §3），只是变成可点的。
 */
const CITE = /\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g;

export function InlineCites({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(CITE)) {
    const start = m.index ?? 0;
    if (start > at) out.push(text.slice(at, start));
    for (const one of m[0].matchAll(/E?(\d+)/g)) {
      out.push(<EvidenceChip key={`c${n++}`} id={`E${one[1]}`} />);
    }
    at = start + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** 正文里引到的编号，按出现顺序 —— 筛选视图要拿它判断这一段有没有核验过的支撑。 */
export function inlineRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE)) {
    for (const one of m[0].matchAll(/E?(\d+)/g)) {
      const id = `E${one[1]}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}
