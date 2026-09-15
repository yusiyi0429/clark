"use client";

import { useEffect, useRef, useState } from "react";
import { CodeText } from "@/components/provenance/code-ref";
import {
  SelectionToolbar,
  useSelectionQuote,
} from "@/components/provenance/selection-quote";
import { ResearchStepLine } from "@/components/research-step-line";
// 类型 only：`tasks.ts` 是服务端那张任务表，编译后这一行不进客户端包（同 `signal-view.tsx`）。
import type { TaskState } from "@/lib/agent/tasks";
import { api } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import type {
  BoardJudgement,
  ConfirmChannel,
  JudgementBoard,
  JudgementOrigin,
} from "@/lib/data/types";
import { cn } from "@/lib/utils";
import { navigableTrace } from "@/lib/data/report-traces";

/**
 * 判断板 —— 首页右栏和议题研究左栏共用的那一块。
 *
 * ## 为什么是上下两层，不是一条时间线
 *
 * 上一版是一条版本链（J₀ → 追问 → J₁ → J₂）。那个模型只装得下**一条**判断的演进，
 * 而真实的议题不是这样：一份深研会一次给出三四条判断，后续对谈又会长出新的，
 * 中间还开过两次会。把它们串成一条链，等于强行给一堆并列的判断编造父子关系。
 *
 * 真正要分的那一刀是**它经没经过一号位**：
 *
 *   上半层  参谋给的，还没经过他 —— 可以被反驳、被改、被丢掉
 *   下半层  他确认过的，已经是公司口径 —— 要动它得有新证据
 *
 * 这一刀分完，屏幕上就能回答那个最要紧的问题：**这个议题现在有几条话是算数的。**
 * 上一版回答不了 —— 链上每一节看起来份量都一样。
 *
 * ## 上半层为什么要标来源
 *
 * 三种来源的可信度和可反驳性完全不同：研报提炼的能回原文核；对谈长出来的背后是他
 * 自己的追问；会上沉淀的牵着别人的话。他想推翻一条判断时，第一步永远是
 * 「这是谁说的」—— 答不出来就没法开始。
 *
 * ## 引用为什么做得这么淡
 *
 * 判断本身才是要读的东西，引用是他起疑时才会去看的一层。做成显眼的徽章之后，
 * 一屏十几条判断变成一屏几十枚徽章，判断反而读不出来了。所以是行尾的一小行灰字，
 * 不是徽章墙。
 *
 * ## 下半层每条为什么必须写「凭什么」
 *
 * 只记「7 月 15 日会上确认」，半年后回头只知道**确认过**，不知道**凭什么**。
 * 而真要重新打开一条判断时，要检查的恰恰是当时那个「凭什么」还成不成立。
 *
 * ## 这块板也能划词
 *
 * 每条底下那枚「就这条聊」带走的是**整条判断**，而他真正想追的常常是里面半句 ——
 * 边界那一行、「凭什么」那一句、变化前后的某个说法。原来只有报告原文能划，等于逼他
 * 先切到报告去找一句意思相近的话。所以划词在这一栏照样有，两个前提：
 *
 *   `onQuote` 传了       首页右栏没有对话，划出一枚「引用提问」按了没地方去
 *   板上真有判断         空板和挂了的时候，这一栏里唯一的字是本产品自己写的状态说明
 *                        （「这一轮判断没生成成功…」）—— 让它可引用，等于请参谋
 *                        解释一句 UI 文案。报告那一栏是同一道闸（`active?.doc`）。
 */

const ORIGIN: Record<JudgementOrigin, { label: string; tone: string }> = {
  research: { label: "深研提炼", tone: "text-confirmed" },
  dialogue: { label: "对谈中形成", tone: "text-judgment" },
  meeting: { label: "会上沉淀", tone: "text-factual" },
};

const CHANNEL: Record<ConfirmChannel, string> = {
  manual: "手动确认",
  dialogue: "对谈中确认",
  meeting: "会上确认",
};

export function JudgementBoardPane({
  board,
  onChanged,
  onQuote,
  compact = false,
  notice,
  footer,
}: {
  board: JudgementBoard | null;
  /** 确认之后重取。 */
  onChanged?: () => void;
  /** 「就这条聊」与划词「引用提问」—— 把话带进对话。首页没有对话栏，就不传。 */
  onQuote?: (text: string) => void;
  /** 首页右栏用紧凑档：字小一号、留白收一档。 */
  compact?: boolean;
  /**
   * 摆在判断上面那一句 —— 这一轮**交付到什么程度**。
   *
   * 由宿主给而不是这块板自己去问：它在首页右栏和议题研究左栏各出现一次，而只有后者
   * 手上有那一轮的报告。首页那一档不传，一个像素都不变。
   *
   * 位置在最上面而不是最底下：一份三节只成了一节的报告，这句话读不到就等于没说 ——
   * 而它恰恰是决定「底下这几条判断该按多重来读」的那一句。
   */
  notice?: React.ReactNode;
  /**
   * 板子最底下那一块 —— 议题研究页把「整理成行动建议」那个显式入口放在这里。
   *
   * **不做成默认落点。** 研究完成不等于已形成决议，更不等于该立即派发命令：默认这一屏
   * 答的是「现在怎么判断、凭什么、还缺什么」，要走到行动那一面得他自己按一下。
   */
  footer?: React.ReactNode;
}) {
  /*
   * 参谋在读报告的时候，隔一会儿自己去问一次。
   *
   * 这一块是全站唯一会**自己变**的读面：判断不是他点出来的，是深研跑完之后自动
   * 生成的（`ensureJudgements`）。不轮询的话，屏幕上写着「正在读」，而读完了他得
   * 手动刷一次才看得见 —— 那句「正在读」就成了一个永远不结束的承诺。
   *
   * 八秒一次，只在 `running` 的时候转。别的读面照旧不自动重取（见 `use-resource.ts`）。
   */
  const running = board?.pending === "running";
  // 回调走 ref：调用方给的是一个内联箭头函数，直接进依赖数组的话每次重渲染都会把
  // 计时器清掉重设 —— 那个八秒于是永远走不满。
  const notify = useRef(onChanged);
  // 划词的坐标是**相对这个滚动容器**算的，所以 ref 挂在滚动的那一层上（见
  // `useSelectionQuote`）；容器同时要 `relative`，否则工具条会飞到页面左上角。
  const scroller = useRef<HTMLDivElement>(null);
  const { selected, clear, onMouseUp } = useSelectionQuote(scroller);
  useEffect(() => {
    notify.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => notify.current?.(), 8000);
    return () => clearInterval(t);
  }, [running]);

  /*
   * 板上一条都没有、参谋那一轮也没在跑 —— 那就是在**等深研报告**。这时去问深研那张
   * 任务表。
   *
   * 「深研报告还没到」答不出他此刻真正在问的那句话：它是在干活，还是根本没人在跑。
   * 这块板是他进这一页第一眼落到的地方，而报告那一栏在右边（首页那一档甚至没有报告栏），
   * 让他自己切过去核对，等于把一个系统答得出的事实推给他。
   *
   * 自己去问，不从外面接一个 prop：这块板在首页右栏和议题研究左栏各出现一次，两处的
   * 宿主手上都没有深研状态 —— 让它们各拿一遍再往下传，是同一根线在两个地方各接一次。
   */
  const issueId = board?.issueId;
  const waitingForReport = Boolean(
    board && board.pending === null && board.draft.length === 0 && board.confirmed.length === 0,
  );
  const [deep, setDeep] = useState<TaskState | null>(null);
  useEffect(() => {
    if (!waitingForReport || !issueId) return;
    let alive = true;
    const read = () => {
      void api
        .deepResearchStatus(issueId)
        .then((st) => alive && setDeep(st))
        .catch(() => {});
    };
    read();
    // 五秒。报告落库之后板上的 `pending` 会翻成 `running`，所以顺手把板也重取一次 ——
    // 上面那个八秒的计时器只在 `running` 时转，等报告的这一档它是停着的。
    const t = setInterval(() => {
      if (!alive) return;
      read();
      notify.current?.();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [waitingForReport, issueId]);

  if (!board) return null;

  const { draft, confirmed, pending } = board;
  /*
   * 同义重复的那几条折到提出它的那一条底下（`foldSynonymous`）。ISS-239 的当前判断 1 和 3
   * 说的是同一件事的两个说法，摊在一排上时这块板看起来有三条判断、实际只有两条。
   */
  const drafts = foldSynonymous(draft);
  const empty = draft.length === 0 && confirmed.length === 0;
  /** 划词得有真东西可划 —— 理由见文件头「这块板也能划词」。 */
  const quotable = Boolean(onQuote) && !empty;

  return (
    <div
      ref={scroller}
      onMouseUp={quotable ? onMouseUp : undefined}
      /*
       * `--pane-inset-top`：**上面浮着一条东西时**第一行从哪儿开始。
       *
       * 议题研究页那一栏的页签行是一条悬浮的磨砂长条（见 `advisor-view.tsx`），它压在
       * 正文上面，不占流里的高度 —— 所以那一页得把第一行往下推，推的距离由那一页给。
       * 首页右栏没有那条长条，取默认值，一个像素都不变。
       */
      className={cn(
        "scroll-slim relative min-h-0 flex-1 overflow-y-auto",
        compact
          ? "px-4 pt-[var(--pane-inset-top,1rem)] pb-4"
          : "px-5 pt-[var(--pane-inset-top,1.25rem)] pb-5",
      )}
    >
      {quotable ? (
        <SelectionToolbar
          selected={selected}
          onQuote={() => {
            if (!selected || !onQuote) return;
            onQuote(`「${selected.text}」`);
            clear();
          }}
        />
      ) : null}

      {/* 这一轮交付到什么程度（宿主给的，见上面那个 prop）。摆在所有判断前面。 */}
      {notice}

      {/*
       * 参谋这一轮的状态。板不空的时候也要说 —— 板上可能只有对谈里聊出来的那几条，
       * 而报告读出来的那一批还在路上。
       */}
      {pending === "running" && (
        <p className={cn("meta text-ink-muted", empty ? "" : "mb-3")}>
          参谋正在把深研报告读成判断。
        </p>
      )}
      {pending === "failed" && (
        <p className={cn("meta text-counter", empty ? "" : "mb-3")}>
          这一轮判断没生成成功，<span className="font-medium">不会自动重试</span>。报告本身还在。
        </p>
      )}

      {/*
       * 读完了、一条都没落住。**这一档要单独说** —— 它是唯一一种「这块板不会再自己
       * 变了」：不会有下一轮（同一份报告只读一遍，见 `ensureJudgements`）。报的是
       * 「还没到」的话，他会等一个不会来的东西；报「正在读」的话，那个圈永远转。
       *
       * 只在板空的时候说：板上有对谈聊出来的判断时，这句话没有任何用处。
       *
       * 整句摆在 JS 字符串里而不是直接写在标签之间：中文句子在源码里换行的话，JSX
       * 会把那个换行折成**一个空格**，屏幕上就是一句中间裂开一格的话。
       */}
      {pending === "read-nothing" && empty && (
        <p className="meta text-ink-faint">
          {"参谋读完了这份报告，没有一条判断落到板上 —— 报告本身还在，只是没有能单独摘出去用的口径。"}
        </p>
      )}

      {empty ? (
        // 只有在既没在跑、也没挂的时候才说「在等报告」—— 否则这句话是假的。
        pending === null && <AwaitingReport task={deep} reportsKept={board.reportsKept} />
      ) : (
        <>
          {/*
           * 这一层不再写「参谋给的，还没经过您。可以反驳、可以改、也可以丢掉」。
           * 「待您确认」四个字已经说完了归属，而那一行里三颗按钮（采信／改一句／丢掉）
           * 就是「可以反驳、可以改、也可以丢掉」—— 那句话是把屏幕上摆着的东西又念了一遍。
           */}
          <p className="meta mb-3 text-ink-faint">Agent 提出，供您追问和挑战；可形成初步倾向或带入会议讨论的问题。</p>
          {/* 条数写折完之后的 —— 屏幕上摆着几条，这个数就该是几。 */}
          <Tier title="对这个议题的判断" count={drafts.length} empty="暂时没有新的判断。">
            {drafts.slice(0, 3).map((g) => (
              <DraftRow key={g.lead.id} g={g} compact={compact} onChanged={onChanged} onQuote={onQuote} />
            ))}
            {drafts.length > 3 && <li className="list-none"><details><summary className="meta cursor-pointer py-2 text-ink-muted">其余 {drafts.length - 3} 条判断</summary><ul className="mt-2 space-y-3">{drafts.slice(3).map((g) => <DraftRow key={g.lead.id} g={g} compact={compact} onChanged={onChanged} onQuote={onQuote} />)}</ul></details></li>}
          </Tier>

          {/*
           * 空的时候这一层什么都不说。原来那句「这个议题目前全部是参谋的猜测」把一件
           * 中性的事（还没轮到确认）说成了一句自我否定，而它出现的时机恰好是他刚进这一页、
           * 一条都还没来得及看的时候 —— 屏幕上第一句话不该是「上面那些都是猜的」。
           * 「您已确认 · 0 条」自己就把这件事说清了。
           */}
          <Tier
            title="您已确认"
            count={confirmed.length}
            className="mt-6 border-t border-hairline pt-5"
          >
            {confirmed.map((j) => (
              <ConfirmedRow key={j.id} j={j} compact={compact} onQuote={onQuote} />
            ))}
          </Tier>
        </>
      )}

      {/* 走到行动那一面的显式入口（宿主给的）。板空的时候也摆着 —— 它答的是「这一轮有没有
          整理好的行动建议」，跟板上有没有判断是两件事。 */}
      {footer}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 同义重复                                                                    */
/* -------------------------------------------------------------------------- */

/** 一条判断，连着被折到它底下的那几条同义说法。 */
export type DraftGroup = { lead: BoardJudgement; echoes: BoardJudgement[] };

/** 比字之前先把标点和空白去掉 —— 「首访：以单场景验收」和「首访, 以单场景验收」是一句话。 */
const bare = (t: string): string => t.replace(/[\s\p{P}\p{S}]/gu, "");

/** 三字一组的集合。三字而不是两字：两字捕到的是共同话题（「客户」「验收」），三字才开始捕到共同说法。 */
function trigrams(text: string): Set<string> {
  const t = bare(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

/** 两句话的重合度（Dice）。两边都太短就退成「一模一样才算」。 */
export function sameSaying(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return bare(a) === bare(b) ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 同义重复折起来的那条线。ISS-239 的当前判断 1 和 3 量到 0.17，另外两对是 0.045 和 0。
 *
 * **0.15。** 这个数是在一个样本上量出来的，所以这一段的设计前提是**它会误判**：
 *
 * · 折起来的那几条**一条都没丢**，点开就在（`DraftRow` 底下那个「另一种说法」）。误判的
 *   代价因此是一条判断少占了半屏，不是一条判断消失了 —— 而后者才是不可接受的那一种。
 *   HANDOVER §3.F 那句「去同义判断，不抹掉不同边界或冲突」说的正是这件事：边界、依据、
 *   重开条件全都跟着原条走，折的只是版面。
 * · 真正该做语义合并的地方是产出那一侧的收口（`foldSections`），那里有全文和证据编号。
 *   这一层是渲染，手上只有几句话，做不了也不该做语义判断 —— 更不许为此多起一次模型调用。
 *
 * 只折**上半层**（待确认的那批）。已确认的是一本账，账上两条记录哪怕说的是同一件事，
 * 也各自是一次真发生过的确认。
 *
 * 顺序保留：先来的那条当牵头，后面重合的折到它底下。
 */
export function foldSynonymous(list: BoardJudgement[], threshold = 0.15): DraftGroup[] {
  const groups: DraftGroup[] = [];
  for (const j of list) {
    const into = groups.find((g) => sameSaying(g.lead.statement, j.statement) >= threshold);
    if (into) into.echoes.push(j);
    else groups.push({ lead: j, echoes: [] });
  }
  return groups;
}

/* -------------------------------------------------------------------------- */

/**
 * 板是空的，而参谋那一轮既没在跑也没挂 —— 也就是在等深研报告。
 *
 * 三档，分的还是那一刀：**要不要继续等**。深研跑挂了不会自动重试，那时这块板不该
 * 呼吸；没人开过那一轮的时候更不该。
 *
 * 挂掉那一档还要再分一刀：**报告原件有没有留下来**。一轮深研常常是先把几条链路的报告
 * 跑完、再挂在后半段（2026-08-26 的 ISS-111 就是），那几份原件现在会留住（见
 * `UnfinishedResearchRound`）。那时候说「没有报告可读」是假的 —— 报告栏里明明有几份。
 *
 * 这两句都不再写「已记在运营台」：被服务重启掐断的那一轮根本没走到落记录那一步，而这块板
 * 分不出是哪一种。没跑完的原话在报告那一栏（`DeepPending`），那里放得下一整句。
 */
function AwaitingReport({
  task,
  reportsKept,
}: {
  task: TaskState | null;
  /** 那一轮留下来的报告原件份数，`JudgementBoard.reportsKept`。没留下就没有这个数。 */
  reportsKept?: number;
}) {
  if (task?.status === "failed") {
    return (
      <p className="meta text-counter">
        {reportsKept ? (
          <>
            这一轮深研没跑完 —— 板上一条判断都没有，但已经写出来的 {reportsKept} 份报告原件留住了。
            <span className="font-medium">不会自动重试</span>。
          </>
        ) : (
          <>
            这一轮深研没跑完 —— 没有报告可读，所以板上一条判断都没有。
            <span className="font-medium">不会自动重试</span>。
          </>
        )}
      </p>
    );
  }

  if (task?.status === "idle") {
    return <p className="meta text-ink-faint">这件议题还没有深研。</p>;
  }

  return (
    <ResearchStepLine
      className="meta block"
      step={task?.status === "running" ? task.step : undefined}
      startedAt={task?.status === "running" ? task.startedAt : undefined}
      queuePosition={task?.status === "queued" ? task.queuePosition : undefined}
      fallback="深研报告还在路上"
    />
  );
}

function Tier({
  title,
  count,
  empty,
  className,
  children,
}: {
  title: string;
  count: number;
  /** 一条都没有时说什么。不给就什么都不说。 */
  empty?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-medium text-ink">{title}</h2>
        <span className="meta text-ink-faint">{count} 条</span>
      </div>
      {/* 不给空态文案的那一层这里什么都不渲染 —— 不留一个空的 `<p>`：空段落照样吃掉
          mt-0.5 加一行行高。 */}
      {count === 0 && empty ? <p className="meta mt-0.5 text-ink-faint">{empty}</p> : null}
      {count > 0 && <ul className="mt-3 space-y-3">{children}</ul>}
    </section>
  );
}

function DraftRow({
  g,
  compact,
  onChanged,
  onQuote,
}: {
  /** 这一条，连着被折到它底下的那几条同义说法（`foldSynonymous`）。 */
  g: DraftGroup;
  compact: boolean;
  onChanged?: () => void;
  onQuote?: (text: string) => void;
}) {
  const j = g.lead;
  const [confirming, setConfirming] = useState(false);
  const [support, setSupport] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const o = ORIGIN[j.origin];

  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await api.confirmBoardJudgement(j.id, "manual", support);
      setConfirming(false);
      onChanged?.();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "确认失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-hairline bg-surface px-3.5 py-3">
      <p className="flex items-baseline gap-2">
        {j.label && <span className="text-sm font-medium text-ink">{j.label}</span>}
        <span className={cn("meta font-medium", o.tone)}>{o.label}</span>
        {j.meetingLabel && <span className="meta text-ink-faint">· {j.meetingLabel}</span>}
        <span className="meta ml-auto text-ink-faint">{formatStamp(j.at)}</span>
      </p>

      <p className={cn("report mt-1.5 leading-relaxed text-ink", compact ? "text-sm" : "text-md")}>
        <CodeText text={j.statement} />
      </p>

      {j.changeFrom && j.changeTo && (
        <p className="mt-1.5 text-sm leading-relaxed">
          <span className="meta mr-1.5 text-ink-faint">变化</span>
          <span className="text-judgment">{j.changeFrom}</span>
          <span className="mx-1.5 text-ink-faint">→</span>
          <span className="text-judgment">{j.changeTo}</span>
        </p>
      )}

      <details className="mt-2">
        <summary className="meta cursor-pointer text-ink-muted">依据、边界与待挑战的问题</summary>
        <Facets j={j} />
      </details>
      <InlineNotes j={j} />

      {/*
       * 折起来的那几条同义说法。**一条都没丢，点开就在** —— 这一层的合并是版面上的，
       * 不是内容上的（理由写在 `foldSynonymous` 上）。各自的依据、边界、重开条件跟着自己
       * 那一条走，不并进上面那一条：并起来就成了一条没人写过的判断。
       */}
      {g.echoes.length > 0 && (
        <details className="mt-2 border-t border-hairline pt-2">
          <summary className="meta cursor-pointer text-ink-faint">
            另有 {g.echoes.length} 条说法与这条重合
          </summary>
          <ul className="mt-2 space-y-3">
            {g.echoes.map((e) => (
              <li key={e.id}>
                <p className="flex items-baseline gap-2">
                  {e.label && <span className="text-sm font-medium text-ink-muted">{e.label}</span>}
                  <span className="meta ml-auto text-ink-faint">{formatStamp(e.at)}</span>
                </p>
                <p className="report mt-1 text-sm leading-relaxed text-ink-muted">
                  <CodeText text={e.statement} />
                </p>
                <Facets j={e} />
                <InlineNotes j={e} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {confirming ? (
        <div className="mt-2.5 space-y-2 border-t border-hairline pt-2.5">
          {/*
           * 备注是必填。服务端也拦一道 —— 空的确认在半年后等于没确认过，
           * 而屏幕上它跟一条有依据的确认长得一模一样，那才是真正危险的地方。
           */}
          <textarea
            value={support}
            onChange={(e) => setSupport(e.target.value)}
            rows={2}
            placeholder="备注"
            autoFocus
            className="scroll-slim w-full resize-none rounded-md border border-hairline bg-paper px-2.5 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
          />
          {failed && <p className="meta text-counter">{failed}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !support.trim()}
              onClick={() => void confirm()}
              className="meta inline-flex h-8 items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "正在确认…" : "确认这条判断"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="meta rounded-[3px] px-1 text-ink-faint hover:text-ink-muted"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
          >
            手动确认 →
          </button>
          {onQuote && (
            <button
              type="button"
              onClick={() => onQuote(`「${j.statement}」`)}
              className="meta ml-auto rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
            >
              就这条聊 →
            </button>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * 下半层的一条。**默认折起来，只留一行。**
 *
 * 上半层那几条是要一条条读的 —— 他正在决定认不认。下半层已经认完了，摊开之后每条
 * 占七八行（判断、凭什么、边界、重开条件、引用），一个议题认下五条就把这块板全占满，
 * 而真正要动的上半层被挤到屏幕外面。所以折起来：一行标签 + 判断本身，其余点开才有。
 *
 * 折起来之后仍然留着的是**判断那句话**（截一行）而不只是标签 —— 标签是可选的
 * （对谈和会上沉淀的那批没有），只剩日期的一行等于一条读不出内容的账。
 */
function ConfirmedRow({
  j,
  compact,
  onQuote,
}: {
  j: BoardJudgement;
  compact: boolean;
  onQuote?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = j.confirmed;
  if (!c) return null;

  return (
    <li className="rounded-lg border border-hairline bg-neutral-wash">
      {/*
       * 整行可点，不是行尾挂一个小箭头：折叠态只有一行高，点击目标就该是那一行本身。
       * 时间与途径在最上面 —— 下半层是一本账，读账先读日期和经办方式。
       */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full rounded-lg px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-wash-hover"
      >
        <span className="flex items-baseline gap-2">
          {j.label && <span className="text-sm font-medium text-ink">{j.label}</span>}
          <span className="meta font-medium text-confirmed">{CHANNEL[c.channel]}</span>
          <span className="meta text-ink-faint">{formatStamp(c.at)}</span>
          {j.meetingLabel && <span className="meta text-ink-faint">· {j.meetingLabel}</span>}
          <span className="meta ml-auto flex-none text-ink-faint">{open ? "收起" : "展开"}</span>
        </span>

        <span
          className={cn(
            "report mt-1 block leading-relaxed text-ink",
            compact ? "text-sm" : "text-md",
            !open && "truncate",
          )}
        >
          <CodeText text={j.statement} />
        </span>
      </button>

      {open && (
        <div className="px-3.5 pb-3">
          {/*
           * 「凭什么」。左边一道实线，和判断本身分开 —— 它不是判断的一部分，
           * 是这条判断能站在下半层的资格证明。
           */}
          <p className="mt-1 border-l-2 border-confirmed pl-2.5 text-sm leading-relaxed text-ink-muted">
            {c.support}
          </p>

          <Facets j={j} />
          <InlineNotes j={j} />

          {onQuote && (
            <button
              type="button"
              onClick={() => onQuote(`「${j.statement}」`)}
              className="meta mt-2 rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
            >
              就这条聊 →
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * 一条判断除了正文之外的另外三样：凭什么、边界、什么情况下重开。
 *
 * ## 为什么不折叠起来
 *
 * 这三样正是他按下「手动确认」之前要看的东西。折进一个「展开详情」里，
 * 屏幕就变成了「一句话 + 一个确认按钮」—— 那是在请他凭一句话给公司定口径。
 * 边界尤其不能藏：一条没有边界的判断会被当成比它实际更强的东西用。
 *
 * 认完之后就不一样了：下半层那一条整体折起来（见 `ConfirmedRow`），这三样跟着进去 ——
 * 决定已经做完，那时要的是这块板别被已办的事占满。
 *
 * ## 为什么是可选的
 *
 * 对谈和会上沉淀的判断是一句话记下来的，没有这三样（见 `BoardJudgement`）。
 * 那时这一块整段不出现，而不是留三行「—」。空占位会让人以为参谋漏填了。
 */
function Facets({ j }: { j: BoardJudgement }) {
  const rows: [string, string | undefined][] = [
    ["凭什么", j.basis],
    ["边界", j.boundary],
    ["重开条件", j.reopenIf],
  ];
  const has = rows.filter((r): r is [string, string] => Boolean(r[1]?.trim()));
  if (has.length === 0) return null;
  return (
    <>
      {has.map(([k, v]) => (
        <p key={k} className="mt-1.5 text-sm leading-relaxed text-ink-muted">
          <span className="meta mr-1.5 text-ink-faint">{k}</span>
          <CodeText text={v} />
        </p>
      ))}
    </>
  );
}

/** 一份本地文档的编号长这样。库里全部是 `DOC-…`（`seed-*.ts`），`getDoc` 也只认这一批。 */
const LOCAL_DOC = /^\/docs\/DOC-[A-Za-z0-9_-]+$/;

/**
 * 这个引用**点得开吗** —— 渲染这一侧的最后一道闸。
 *
 * `navigableTrace` 只看形状：以 `/` 开头就算站内地址。ISS-239 的判断板上于是出现了
 * `/docs/E30` 这种东西 —— `E30` 是**这一份报告里的证据编号**，不是文档号，而 `getDoc`
 * 只查本地文档表，点进去必然是「找不到文档 E30」。同一份板上还有 `/docs/ISS-239`：
 * 议题号进了文档路径，一样打不开。
 *
 * 解析那一步（按证据登记表把 E 编号映射回真来源）在 `lib/data/report-traces.ts`，另一条
 * 线在改。这里是**渲染侧**：解析不出来的保留文字、标一句「未定位」，不画成可点的死链。
 * 两道闸不重复 —— 那边负责把能解析的解析掉，这边负责剩下的一律不许长得像链接。
 *
 * 判据是「`/docs/` 底下必须是一个文档号」，不是「不许是 E 编号」：白名单挡得住下一种
 * 还没见过的形状，黑名单只挡得住见过的那一种。站内别的路径（`/issues/…`、`/decisions`）
 * 照旧放行 —— 那些是真路由。
 */
export function traceHref(href?: string): string | null {
  if (!navigableTrace(href)) return null;
  if (href!.startsWith("/docs/") && !LOCAL_DOC.test(href!)) return null;
  return href!;
}

/**
 * 引用。**行尾一小行灰字，不是徽章。**
 *
 * 点得开的才做链接，剩下的是一段说明文字。不给「推断」类的溯源做链接 ——
 * 点开是空的链接比没有链接更伤：他点第二次就不再相信这一屏上任何一个可点的东西。
 *
 * **「未定位」只标在那种「本来给了地址、但那个地址指不到东西」的引用上。** 一条只写了
 * 来源名字、压根没带地址的引用（「CSA / Oasis 2026」这种）不是没定位到，它本来就是一句
 * 署名 —— 给它挂一句「未定位」，等于把一批完好的引用说成坏的。
 */
function InlineNotes({ j }: { j: BoardJudgement }) {
  if (j.notes.length === 0) return null;
  return (
    <p className="meta mt-1.5 text-ink-faint/85">
      {j.notes.map((t, i) => {
        const href = traceHref(t.href);
        const lost = Boolean(t.href) && !href;
        return (
          <span key={i}>
            {i > 0 && <span className="mx-1 text-ink-faint/60">·</span>}
            {href ? (
              <a
                href={href}
                className="rounded-[2px] underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:text-ink-muted"
              >
                {t.source}
              </a>
            ) : (
              <span>
                {t.source}
                {lost && <span className="ml-1 text-ink-faint/70">（未定位）</span>}
              </span>
            )}
          </span>
        );
      })}
    </p>
  );
}
