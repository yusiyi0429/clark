"use client";

import { Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { CardFourPart } from "@/components/card-four-part";
import { Panel } from "@/components/panel";
import { CodeText } from "@/components/provenance/code-ref";
import { SignalsInboxSection } from "@/components/signals-inbox";
import { api } from "@/lib/data/client";
import { formatClock } from "@/lib/format";
import { useInvalidate, useResource } from "@/lib/use-resource";
import type {
  Card,
  InboxSignal,
  IssueSummary,
  MonitorStrategy,
  ScanRound,
  ScanState,
  WithheldItem,
} from "@/lib/data/types";
import { cn } from "@/lib/utils";
import { digestTitle } from "./digest-title";

/**
 * 页面1 待定事项 —— 五个环节的第一格。
 *
 * 一号位一天给这一屏五分钟，它要让他把 0–3 件事定完、然后不带疑问地离开。三段结构，
 * 从上到下正好是「我替你看着什么 → 我为什么把这几件端上来 → 我替你挡了什么」：
 *
 * **一切的起点是这一屏。** 一号位手上的每一件战略议题都从这里被他采信出去，三个来源
 * 都汇到这一份清单上：雷达按公司布下的靶点抓回来的、DRI 押上名字递上来的、以及他自己
 * 想到的（下面那个「+ 我自己有一件事」）。第三个来源原来在战略议题那一页上，打一行字
 * 就直接得到一条在办议题 —— 那是给他自己开的特权通道，也让「我手上有几件事」这个问题
 * 有了两个入口。
 *
 * 1. **监测靶点。** 头部那一行摊的是当下布控着的 Re-open Trigger。它们是上一次写回
 *    留下来的 —— 会后确认那一下布控的条件，回到这一屏就是这一行。感知不是「什么新闻
 *    都看」，是「盯着公司自己布下的那几个点」。
 * 2. **提请卡。** 四段式，每天最多三张。三键处置（聊聊/先看着/不看了）就是采信这一
 *    下 —— Signal 永远不会自己升级成组织任务，确认权在这一次点击里。
 * 3. **待挑的信号。** 雷达过线、还没立案的那些，摆在卡片底下，分量低一档（行，不是卡）。
 *    它原来是自己一页，从这一屏标题行上的一个口子进；合到这一屏是因为在一号位眼里
 *    两边都是「今天有什么新东西要我看」。合的是页面，不合对象 —— 信号不强转成议题，
 *    升级那一下仍然要他确认标题、仍然由他按（理由写在 `components/signals-inbox.tsx`）。
 * 4. **没出卡的账。** 预算制要可信，被压下去的就得摊开、逐条给出可核对的理由。它和
 *    未读红点是反义词：红点说「你还欠我 N 次点击」，这行小字说「我替你挡了这些，
 *    账在这儿」。
 *
 * 这一屏上没有头像也没有问候语，也没有一句解释这一屏是干什么的 —— 它是一份**清单**。
 */

export function DigestView() {
  const key = "digest:today";
  const resource = useResource<Card[]>(key, () => api.listPending());

  /*
   * 有卡的预研在跑就每五秒重问一次这份清单。
   *
   * 这一屏原来一次都不轮询：一张卡上写着「预研进行中」，跑完了他也不知道 —— 那一格
   * 要等他下次进这一屏才变。现在那一格还写着走到第几步，是几十秒一变的东西。
   *
   * 判据是「这张卡上真有一轮在跑」（`preResearchStartedAt`），**不是「没有报告」**：
   * demo 那一档压根不叫模型，按「没报告」判的话这一屏会为一件没人在做的事永远轮下去。
   * 跟卡面上那个四元同一套条件（见 `CardFourPart`）：有几张卡在呼吸，这里就替它们去问。
   */
  const mutate = resource.mutate;
  const running = (resource.data ?? []).some((c) => !c.disposedAs && c.preResearchStartedAt);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void mutate(), 5000);
    return () => clearInterval(t);
  }, [running, mutate]);

  return (
    /*
     * 这一屏不进纸（`width="full"`，不套 `.page-sheet`）。卡片自己就是一版摆开的东西，
     * 底下再垫一张纸，屏幕上是一块大面里套着一叠小面，而那张纸不说明任何事。
     *
     * 宽度收到 1180：两列卡片各 ~560，和单列那 780 是同一个量级的正文宽。
     */
    <Panel width="full" className="max-w-[1180px] pb-16">
      <AsyncBoundary resource={resource} skeleton={<DigestSkeleton />}>
        {(cards) => <Digest cards={cards} />}
      </AsyncBoundary>
      <Withheld />
    </Panel>
  );
}

function Digest({ cards }: { cards: Card[] }) {
  /*
   * 处置全部移到详情页了，这一屏只剩清单。
   *
   * 卡上原来挂着三颗处置键和一个指派下拉，连带一整套「回执 / 收起 / 交接包」的
   * 会话态。删得干净是有理由的：这一屏是他决定**点哪几条进去**的地方，不是拍板的
   * 地方。处置发生在他读过参谋判断之后，那是详情页的事。
   */
  /*
   * 标题要对底下那一段待挑的信号也负责（`digestTitle`）。同一个 key，和那一段共用
   * 一份缓存，这里不多打一次接口。**放在提前返回之前** —— 它是 hook。
   */
  const inbox = useResource<InboxSignal[]>("signals-inbox", () => api.listInboxSignals());
  const openSignals = inbox.data?.length ?? 0;

  // 处置过的不留在这一屏 —— 账在处置记录页。
  const visible = cards.filter((c) => !c.disposedAs);
  const open = visible.length;
  const handled = cards.length - open;

  if (cards.length === 0) return <EmptyDay openSignals={openSignals} />;

  return (
    <>
      <DigestHead
        /*
         * 这里曾经写着「今日信号 3 个 · 每日上限 3」。上限没有了 —— 那句承诺是拿系统
         * 的克制去换他的信任，代价是把**什么算战略议题**这件事替他定了。一天真有五件
         * 要紧事，第四第五件就得排到明天。
         *
         * 剩下的只有一个事实：今天进来了几条。判断哪几条值得他花时间，是他的活。
         */
        eyebrow={`潜在议题 · 今天进来 ${cards.length} 条`}
        title={digestTitle({ openCards: open, totalCards: cards.length, openSignals })}
      />

      <MonitorRow />

      {/* 两列，先摆满一行再下一行。每块拉满行高，两块的下沿因此对齐 —— 一屏读起来是
          一版格子，不是两条各走各的柱子。 */}
      <div className="stagger mt-6 grid gap-4 md:grid-cols-2">
        {visible.map((card, i) => (
          <div key={card.id} className="h-full" style={{ "--i": i } as React.CSSProperties}>
            <CardFourPart card={card} />
          </div>
        ))}
      </div>

      {/* 卡片底下、分量低一档：雷达过线还没立案的那些。一条都没有就整段不出现。 */}
      <SignalsInboxSection />

      {/*
       * 处置过至少一件之后才出现的那一个出口。
       *
       * 三键按下去屏幕不跳走：他可能连着处置三张卡，每一次都被弹到别处的话，这一屏就
       * 守不住五分钟。走到下一环是一个他自己做的动作 —— 而且只有一个方向可走，因为
       * 采信的那几件事此刻都在池子里。
       */}
      {handled > 0 && (
        <div className="animate-fade mt-8 border-t border-hairline pt-5">
          <p className="meta text-ink-faint">已处置 {handled} 件</p>
          <div className="mt-2.5 flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex h-10 items-center rounded-lg bg-solid px-4 text-md font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90"
            >
              去战略议题 →
            </Link>
            <ArchiveLink />
          </div>
        </div>
      )}
    </>
  );
}

/** 待定区入口。有存货才出现 —— 空档案馆不值得占一行。 */
function ArchiveLink() {
  const parked = useResource<Card[]>("parked", () => api.listParked());
  const n = parked.data?.length ?? 0;
  if (n === 0) return null;
  return (
    <Link
      href="/archive"
      className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
    >
      待定区 {n} 条 →
    </Link>
  );
}

/**
 * 每一轮扫描提名了什么。**一直在，一轮都没跑过也在。**
 *
 * 和上面那个入口的分工：待挑的信号是「现在要他挑的」，这一条是「机器都提名过什么、
 * 每一条最后去了哪」—— 包括被判成噪音的。一号位要的就是这个：机器在「这条信号会不会
 * 动到公司战略」那一步的判断不一定比他深，所以他得能回头自己瞅一眼。
 *
 * 所以它和 `InboxLink` 的「有货才出现」正好相反，而这不是不一致：待挑的信号是一份
 * **待办**，空着的时候一个「0 条」的口子只是噪音；这一条是一份**台账**，而一份要等
 * 有内容才肯露面的台账，等于要求他先知道它存在才找得到它。空着的时候点进去也有话
 * 说 —— 那一页的空态写着扫描的节奏和起一轮的去处。
 */
function ScansLink() {
  const nominated = useResource<{ rounds: ScanRound[]; signals: InboxSignal[] }>(
    "signals-nominated",
    () => api.listNominatedSignals()
  );
  // 这个口子上的数还是**信号条数**，不是轮数：他点进去是要看机器提名了什么。
  const n = nominated.data?.signals.length ?? 0;
  return (
    <Link
      href="/signals-scans"
      className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
    >
      {/* 数还没回来时也是这一句 —— 不写「0 条」，那会在一两百毫秒里断言一件可能不真的事。 */}
      {n === 0 ? "扫描记录 →" : `扫描记录 ${n} 条 →`}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 标题行 —— 左边是这一屏是什么，右上角是这一屏能做什么。
 *
 * 右上角摞两层，两层的分量差一整档：
 *
 *   上层  主动开始扫描 · + 我自己有一件事   按下去真的会发生事情
 *   下层  扫描记录 · 处置记录              回头查账的两个口子
 *
 * 下层原来还有一条「待挑的信号 N 条 →」，比那两条重一档（它是活，那两条是账）。
 * 待挑的信号现在长在这一屏的卡片底下，那个口子跟着没了 —— 下层只剩查账的。
 *
 * 上面那两个键原来钉在这一屏的页脚。卡片摆成两列之后，页脚要翻过一屏才够得着，而它们
 * 是这一屏仅有的两个出口 —— 他想起一件事、或者想现在就去扫一轮，不该先滚到底。
 *
 * 展开之后要占地方的两样（输入面、扫描结果）接在标题行下面通栏摆：右上角那一格放得下
 * 一个键，放不下一个能贴一整篇文章的框。
 */
function DigestHead({
  eyebrow,
  title,
}: {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
}) {
  const scan = useScan();
  const [composing, setComposing] = useState(false);
  const [added, setAdded] = useState(false);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="meta mb-1.5 text-ink-faint">{eyebrow}</div>
          <h1 className="text-lg font-medium tracking-[-0.01em] text-ink">{title}</h1>
        </div>

        <div className="flex flex-none flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <ScanButton scan={scan} />
            <button
              type="button"
              onClick={() => {
                setAdded(false);
                setComposing(true);
              }}
              className="inline-flex h-8 flex-none items-center rounded-lg bg-solid px-3 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90"
            >
              + 我自己有一件事
            </button>
          </div>

          {/* `items-baseline` 而不是 `items-center`：三段字号不同，对中会让 12px 那两条
              浮在 14px 那条的字腰上。 */}
          <div className="flex items-baseline gap-4">
            <ScansLink />
            <Link
              href="/signals-log"
              className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
            >
              处置记录 →
            </Link>
          </div>
        </div>
      </header>

      {composing ? (
        <AddOwnPanel
          onClose={() => setComposing(false)}
          onAdded={() => {
            setComposing(false);
            setAdded(true);
          }}
        />
      ) : added ? (
        <p className="animate-fade meta mb-5 text-confirmed">已收下</p>
      ) : null}

      <ScanResult scan={scan} />
    </>
  );
}

/**
 * 「我自己有一件事」—— 三个来源里的第三个。
 *
 * 这个入口最不能省：一号位心里那件事从来不在任何信号流里，他不说，系统永远不知道。
 *
 * **它进来的方式和另外两个来源完全一样**：落成一张潜在议题卡，等他自己处置。不是
 * 直接变成一条在办议题 —— 他刚想到一件事，和他决定要为这件事花时间，是两回事。
 *
 * ## 一个框收三种东西
 *
 * 一句话、一整篇文章、一个链接。**没有「这是链接 / 这是文章」的开关** —— 判定在服务端
 * 做（`own-issue-input.ts`）。给他一个开关等于要求他先替系统分类，而他手上那件事本来是
 * 什么样，系统自己看得出来。
 *
 * 下面那个 `kind` 只用来决定按钮上写哪句话。它可能判错（比如一段话里正好只有一个网址），
 * 判错的代价是按钮上那句话不准 —— 而真正的分类由服务端重做一遍，那一遍说了算。
 */
function AddOwnPanel({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const invalidate = useInvalidate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  /*
   * 等着的那一下要说清在等什么。
   *
   * 贴一个链接是「去抓那个页面」（最长六秒），贴一整篇是「读一遍再起个标题」（一两秒的
   * 模型调用），一句话就是原样收下。三句都是这一刻真的在发生的事 —— 不做成一串自己往前
   * 走的假进度：那种进度条走完之后如果服务端还没回来，屏幕上就只剩一个 100% 在骗人。
   */
  const raw = text.trim();
  const kind = /^https?:\/\/\S+$/i.test(raw) ? "link" : raw.length > 60 ? "long" : "short";
  const busyLabel =
    kind === "link"
      ? "正在打开那个链接…"
      : kind === "long"
        ? "正在读一遍，顺手起个标题…"
        : "正在收下…";

  const submit = async () => {
    if (!raw || busy) return;
    setBusy(true);
    try {
      // H2 —— 服务端说了算。它答应之前，清单上什么都不动。
      await api.addIssue(raw);
      // 这一屏原地重问（他刚提的那条要出现在下面的清单里），其余屏幕清掉重问。
      invalidate("digest:today");
      setText("");
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    /* 一块输入面，保留自己的边界。边是半个物理像素的发丝线环（`.card`），不是 1px 描边。 */
    <div className="card animate-panel mb-5 p-4">
      <textarea
        id="add-own"
        /* 屏幕上的 label 和 placeholder 都删了（那两句是在教他怎么写）。
           这一格不上屏，它只是给读屏软件一个控件名 —— 没有名字的输入框念出来是「文本框」。 */
        aria-label="我自己有一件事"
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter 提交。裸 Enter 留给换行 —— 一句话也可能想断两行写。
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") onClose();
        }}
        /*
         * 贴一整篇进来时框自己长高（`field-sizing-content`），长到 14rem 封顶再内部滚 ——
         * 固定两行的话，六千字挤在两行里，他连自己贴对了没有都看不出来。
         */
        className="report scroll-slim field-sizing-content max-h-56 min-h-[3.75rem] w-full resize-none overflow-y-auto rounded-md border border-hairline bg-paper px-3 py-2.5 text-md text-ink outline-none transition-colors duration-fast placeholder:text-ink-faint focus:border-hairline-strong"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || raw.length === 0}
          onClick={() => void submit()}
          className="inline-flex h-9 items-center rounded-lg bg-solid px-3.5 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
        >
          {busy ? busyLabel : "加进清单"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          算了
        </button>
      </div>
    </div>
  );
}

/**
 * 监控策略。**「你凭什么替我筛」的答案就摊在这里。**
 *
 * 这一行原来写的是「正在替您盯着 N 个靶点」，展开是几条 Re-open Trigger。那句话把
 * 雷达说小了：真正决定什么能进那份清单的是**观察域 + KIQ + 战略假设 + 时窗与阈值**，
 * 触发条件只是其中一层（而且是最窄的一层 —— 它盯的是已经做过的判断会不会被推翻）。
 * 一号位读到「N 个靶点」，会以为自己看见了全部口径，其实那几条只占一小块。
 *
 * 所以这里改成摊成条目：每一条都是**准确的**，不是一句概括。展开这一面里
 * 只列域名和每个域下面 KIQ 的条数，KIQ 原文和策略正文在 `/sensors` 那一页 ——
 * 这一屏他给五分钟，六个域十几条 KIQ 铺开会把下面那几张卡挤到屏外。
 *
 * 两半都是本仓库自己的账：上面那一半（域、KIQ、口径）读 `scan/strategy-body.ts` 里
 * 那份靶点策略，下面那一半（触发条件）是历次会后确认布控下来的。**这一折因此没有
 * 「读不到」这一档** —— 它原来有，因为策略要现去实验台读；策略搬回来之后那一档
 * 一起没了（分工写在 `store.getMonitorStrategy`）。
 */
function MonitorRow() {
  const resource = useResource<MonitorStrategy>("monitor-strategy", () =>
    api.getMonitorStrategy()
  );
  const [open, setOpen] = useState(false);

  const s = resource.data;
  // 两边都空 = 这一屏此刻真的说不出监控口径。空着的时候不占一行 —— 那一行只会写出
  // 「监控策略 · 0 个观察域」，而屏幕上宁可什么都不说，也不说一句没有内容的话。
  if (!s || (s.domains.length === 0 && s.limits.length === 0 && s.triggers.length === 0)) {
    return null;
  }

  const kiqs = s.domains.reduce((n, d) => n + d.kiqs.length, 0);
  const summary = [
    s.domains.length > 0 ? `${s.domains.length} 个观察域` : "",
    kiqs > 0 ? `${kiqs} 条情报问题` : "",
    s.triggers.length > 0 ? `${s.triggers.length} 条触发条件` : "",
  ].filter(Boolean);

  return (
    /* 一块淡底的折叠面。边用内缩的发丝线环，不用 1px 描边 —— 1px 在 2x 屏上是两个
       物理像素，比原生粗一倍；而 inset 环不占布局盒子，展开时内容位置不用跟着改。 */
    <div className="animate-fade rounded-lg bg-neutral-wash px-4 py-3 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="meta flex w-full items-center gap-1.5 rounded-[3px] text-ink-muted transition-colors duration-fast hover:text-ink"
      >
        监控策略{summary.length > 0 ? ` · ${summary.join(" · ")}` : ""}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 text-ink-faint transition-transform duration-base ease-swift",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="animate-fade mt-3 space-y-4">
          {s.hypotheses.length > 0 ? (
            <MonitorGroup label="研判的靶心">
              {s.hypotheses.map((h) => (
                <MonitorBullet key={h}>{h}</MonitorBullet>
              ))}
            </MonitorGroup>
          ) : null}

          {s.domains.length > 0 ? (
            <MonitorGroup label="盯的是这几个域">
              {s.domains.map((d) => (
                <MonitorBullet key={d.code}>
                  <span className="font-medium text-ink">
                    {d.code} {d.title}
                  </span>
                  {/* 条数而不是原文：原文在 `/sensors`（见这个组件开头那段）。 */}
                  {d.kiqs.length > 0 ? (
                    <span className="text-ink-faint"> · {d.kiqs.length} 条情报问题</span>
                  ) : null}
                </MonitorBullet>
              ))}
            </MonitorGroup>
          ) : null}

          {s.limits.length > 0 ? (
            <MonitorGroup label="什么才端到您面前">
              {s.limits.map((l) => (
                <MonitorBullet key={l}>{l}</MonitorBullet>
              ))}
            </MonitorGroup>
          ) : null}

          {s.triggers.length > 0 ? (
            <MonitorGroup label="这几条一动，那件事就重开">
              {s.triggers.map((t) => (
                <li key={t.id} className="flex items-baseline gap-2">
                  <Link
                    href={t.href}
                    className="meta shrink-0 rounded-[3px] bg-solid px-1.5 py-[1px] font-medium text-solid-fg transition-opacity duration-fast hover:opacity-85"
                  >
                    {t.judgmentId}
                  </Link>
                  <span className="text-base text-ink-muted">{t.text}</span>
                </li>
              ))}
            </MonitorGroup>
          ) : null}

          <div className="flex items-baseline gap-4 border-t border-hairline pt-3">
            <Link
              href="/sensors"
              className="rounded-[3px] text-base text-ink underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:decoration-ink"
            >
              监控策略全文 · 调整它 →
            </Link>
            {s.origin ? (
              <span className="meta text-ink-faint">
                {s.origin}
                {s.readAt ? ` · ${formatClock(s.readAt)} 读到` : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 展开面里的一组条目。小标题 + 一列点。 */
function MonitorGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="meta text-ink-faint">{label}</p>
      <ul className="mt-1.5 space-y-1.5">{children}</ul>
    </div>
  );
}

/**
 * 一个点。
 *
 * 圆点自己写，不用 `list-disc`：那个原生点的大小和位置跟着字号走，在 14px 上偏大、
 * 而且第二行会缩回点下面。这里要的是「点固定在第一行的字腰上，续行齐着文字缩进」。
 */
function MonitorBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-base text-ink-muted">
      <span aria-hidden className="mt-[0.5em] size-1 flex-none rounded-full bg-ink-faint" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * 没出卡的账。
 *
 * 「每天最多 3 张」要可信，就得让一号位看得到被压下去的是什么、为什么 —— 否则那个分母
 * 读起来不是克制，是「它可能瞒了我什么」。每条的理由必须可核对（「单一来源」「不动摇
 * 任何在版判断」），含糊的理由被识破一次，预算制就完了。
 *
 * 行尾的「这个我要看」是这一屏唯一的反馈通道：他指着一条被压下的信号说它值得上桌，
 * 这个动作本身就是对出卡门槛的一次校准 —— 不需要问卷。
 */
function Withheld() {
  const resource = useResource<WithheldItem[]>("withheld:today", () => api.listWithheld());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const items = resource.data;
  if (!items || items.length === 0) return null;

  const reclaim = async (item: WithheldItem) => {
    setBusy(item.id);
    try {
      // H2 —— 服务端说了算，答复回来之前这一行不动。
      const next = await api.reclaimWithheld(item.id);
      await resource.mutate(
        items.map((i) => (i.id === next.id ? next : i)),
        { revalidate: false },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="animate-fade mt-7 border-t border-hairline pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="meta flex items-center gap-1.5 rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
      >
        另有 {items.length} 件事没打扰您
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform duration-base ease-swift",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <ul className="animate-fade mt-3 space-y-3.5">
          {items.map((item) => (
            <li key={item.id}>
              <p className="meta text-ink-faint">{item.source}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                <CodeText text={item.line} />
              </p>
              <p className="meta mt-0.5 text-ink-faint">
                没出卡：<CodeText text={item.reason} />
              </p>
              {item.requestedAt ? (
                <p className="meta mt-1 text-confirmed">{item.requestedNote}</p>
              ) : (
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void reclaim(item)}
                  className="meta mt-1 rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint disabled:opacity-50"
                >
                  {busy === item.id ? "正在记下…" : "这个我要看"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 空报是合格输出，不是错误态。没有插画，没有「系统健康」，没有周报统计，也没有一句
 * 替自己辩护的话 —— 就一句事实，和还走得通的那条路。
 *
 * **上线第一天看到的就是这一屏**（`store.ts` 三个集合都是空的）。所以原来那句
 * 「今天没有值得您看的变化」不能留：一件事都还没进来过，说「没有变化」是在暗示
 * 有人在外面看过了一遍 —— 而雷达那一条还没接。同理那个「去战略议题 →」：第一天
 * 那一页也是空的，把他送过去等于让他自己撞一次空屏，所以真有在办议题时才出现。
 *
 * 空着的时候这一屏上有两个按得动的键：「主动开始扫描」和「+ 我自己有一件事」——
 * 两个都在标题行的右上角（`DigestHead`），不是这一屏专有的。
 * 三个来源那一行小字点名的正是它们背后的三条路，所以那句话不需要再解释一遍。
 */
function EmptyDay({ openSignals }: { openSignals: number }) {
  return (
    <>
      <DigestHead
        /*
         * 只有这一屏的眉标放大一号。`.meta` 的字号在同一个元素上压得过 Tailwind 的
         * `text-*`（globals.css 里写了这条顺序），所以放大要靠一个子元素 —— 而不是
         * 去改 `.meta`：那把尺是全站的，动它等于动每一页的眉标。
         *
         * 空屏上它是唯一一行坐标：清单空着的时候，「这一页是什么」全靠这三个字。
         */
        eyebrow={<span className="text-base">潜在议题</span>}
        /*
         * 雷达过线了几条、一件都还没立案时，「还没有发现新情报」是假话 —— 底下就摆着
         * 那几条。四句话的分法在 `digestTitle`。
         */
        title={digestTitle({ openCards: 0, totalCards: 0, openSignals })}
      />
      <MonitorRow />
      {/* 三个来源，一行说完。原来那段三句话的解释在空屏上太重 —— 他要的是「谁在替我
          找」，不是一段流程说明。 */}
      <p className="meta mt-4 text-ink-faint">雷达检测 · 部门上报 · 您的洞察</p>
      {/* 一张卡都没有的那天，待挑的信号照样在这一屏上 —— 它是那天唯一有的东西。 */}
      <SignalsInboxSection />
      <OpenIssuesLink />
    </>
  );
}

/**
 * 主动开始扫描。
 *
 * 按下去是**真的**去抓：实验台起一轮 catching，选源、抓源、去重、逐条研判，分钟级。
 * 所以跑起来之后那行小字必须说实话 —— 它写的是实验台此刻在哪一步（`step` 是那一侧
 * `describe_step` 给的原话），不是这边编的一句「正在分析全网资讯」。
 *
 * 状态收进一个 hook：那个键在标题行的右上角，跑完那句话在标题行下面通栏 —— 两处读的
 * 必须是同一份状态。
 */
type Scan = {
  state: ScanState | null;
  running: boolean;
  busy: boolean;
  start: () => void;
};

function useScan(): Scan {
  const invalidate = useInvalidate();
  const [state, setState] = useState<ScanState | null>(null);
  const [busy, setBusy] = useState(false);

  // 进屏先问一次：上一轮可能还在跑（他刷新过页面，或者刚从别的屏回来）。
  useEffect(() => {
    void api.scanStatus().then(setState).catch(() => setState(null));
  }, []);

  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void api
        .scanStatus()
        .then((next) => {
          setState(next);
          // 收下来的东西要立刻能看见：待挑的信号那个口子靠 `signals-inbox` 亮，
          // 标题行上那个「扫描记录 N 条」靠 `signals-nominated` 数。
          if (next.status !== "running") {
            invalidate("digest:today", "signals-inbox", "signals-nominated");
          }
        })
        .catch(() =>
          // 问不到进度就说问不到。一直扫下去是这里最不能出的错：他会以为还在跑。
          setState({ status: "failed", error: "问不到进度了（网络中断？）。" }),
        );
    }, 2000);
    return () => clearInterval(t);
  }, [running, invalidate]);

  const start = () => {
    setBusy(true);
    void api
      .startScan()
      .then(setState)
      .catch((err: unknown) =>
        setState({ status: "failed", error: err instanceof Error ? err.message : "起不来。" }),
      )
      .finally(() => setBusy(false));
  };

  return { state, running, busy, start };
}

/**
 * 右上角那个键。三档：跑不了、正在跑、按得动。
 *
 * 这条路走不通时（这台机器没配实验台、或者是演示档）留在原地的是一行照实说的小字，
 * 而不是一个按了没用的键 —— 一号位按不动这个键的时候，他最需要知道的就是为什么。
 */
function ScanButton({ scan }: { scan: Scan }) {
  const { state } = scan;

  if (state?.unavailable) {
    return (
      <span className="meta max-w-[18rem] text-right text-ink-faint">{state.unavailable}</span>
    );
  }

  if (scan.running) {
    /* 一行低存在感的小字，一道光从左往右扫过去。它不是进度条 —— 这一轮要几分钟，
       一根走不动的进度条比一行会动的字更让人怀疑它卡住了。 */
    return (
      <p className="meta sweeping-text" aria-live="polite">
        {state?.step
          ? `正在${state.step}${state.no && state.total ? ` · 第 ${state.no}/${state.total} 步` : ""}`
          : "正在起一轮扫描…"}
      </p>
    );
  }

  return (
    <button
      type="button"
      disabled={scan.busy}
      onClick={scan.start}
      className="inline-flex h-8 flex-none items-center rounded-lg border border-hairline-strong px-3 text-sm font-medium text-ink transition-colors duration-fast ease-swift hover:bg-neutral-wash disabled:opacity-40"
    >
      {scan.busy ? "正在起一轮…" : "主动开始扫描"}
    </button>
  );
}

/** 扫完、或者没跑成那一句。通栏摆在标题行下面 —— 右上角那一格摆不下一句整话。 */
function ScanResult({ scan }: { scan: Scan }) {
  const { state } = scan;

  if (state?.status === "done" && state.got) {
    return (
      <div className="mb-5">
        <ScanDone got={state.got} finishedAt={state.finishedAt} />
      </div>
    );
  }
  if (state?.status === "failed" && state.error) {
    // 原话照登。这一条链路跨两个仓库，含糊一句「扫描失败」等于让他去问人。
    return (
      <p className="animate-fade meta mb-5 max-w-prose text-ink-muted">
        这一轮没跑成 · {state.error}
      </p>
    );
  }
  return null;
}

/**
 * 扫完那一行。
 *
 * ## 它不是小字
 *
 * 这一行原来走 `.meta`（12px，全站的元信息尺）—— 而元信息尺是给「附注」用的：
 * 时间戳、条数、出处。这一行说的是**他刚才按下那个键之后事情办完了**，是这一屏上
 * 唯一一句报结果的话。12px 的 `.meta` 在浅绿（`--confirmed`）上还要再瘦一档，
 * 于是它读起来像一条随时会消失的提示。改成 14px 正文尺。
 *
 * ## 那颗绿点
 *
 * 实心圆 + 白对号，14px —— **和字同高，不超过**。不用 `CircleCheck` 那个图标：
 * 它是描边的（圆环 + 一道勾，`fill="none"`），在 14px 上圆环只有半像素多一点，
 * 渲染出来是一圈发灰的毛边。这里要的是一块实心的绿，所以圆是一个 `bg-confirmed`
 * 的 `span`，对号只是压在上面的一道白线（`strokeWidth` 调到 3 才在 10px 上看得清）。
 *
 * ## 收下了新东西的时候，这一行是一个入口
 *
 * 新增不为零 = 这一屏底下那一段待挑的信号多了几条，而他此刻正好在看着「刚扫完」这
 * 四个字 —— 让他自己往下翻着找是多一步，所以这一行直接滚到那一段（`#inbox`）。
 * 新增为零的时候它**不是链接**：滚过去是一段没变化的列表，那种「点了但什么都没发生」
 * 比不能点更糟。
 *
 * 时间只到分钟，而且是**服务端盖的那一下**（理由写在 `ScanState.finishedAt` 上）。
 * `finishedAt` 可能没有 —— 服务重启过、状态是上一版留下的。那就不写时间，不用
 * 前端的 `new Date()` 顶上去：那量的是他这台机器什么时候看到的。
 */
function ScanDone({
  got,
  finishedAt,
}: {
  got: NonNullable<ScanState["got"]>;
  finishedAt?: string;
}) {
  const at = finishedAt ? ` · ${formatClock(finishedAt)}` : "";
  const fresh = got.inserted > 0;
  const text =
    got.received === 0
      ? `扫描完成 · 这一轮没有过线的东西${at}`
      : fresh
        ? `扫描完成 · 新增 ${got.inserted} 个信号${at}`
        : // 过线了但一条都不新：全是已经在列表里的那几条（同一个 URL）。这句话得说出来，
          // 否则「收下 4 条」和列表里没多东西对不上账。
          `扫描完成 · 收下 ${got.received} 条，都是见过的${at}`;

  const icon = (
    <span
      aria-hidden
      className="flex size-3.5 flex-none items-center justify-center rounded-full bg-confirmed"
    >
      <Check className="size-2.5 text-surface" strokeWidth={3} />
    </span>
  );

  if (!fresh) {
    return (
      <p className="animate-fade mt-2 flex items-center gap-1.5 text-base text-confirmed">
        {icon}
        {text}
      </p>
    );
  }
  return (
    /* 同一页内的锚点，用原生 `<a>`：这一下只是滚动，不是导航。 */
    <a
      href="#inbox"
      className="animate-fade mt-2 inline-flex items-center gap-1.5 rounded-[3px] text-base text-confirmed underline decoration-hairline underline-offset-4 transition-opacity duration-fast hover:opacity-80"
    >
      {icon}
      {text} →
    </a>
  );
}

/**
 * 在办议题的口子。和 `ArchiveLink` 一样：有存货才出现，空屏不往空屏送。
 *
 * 要滤掉 `Candidate` —— `listIssues` 把潜在议题也一并返回（战略议题那一页自己滤，
 * 见 `issues-view.tsx`）。不滤的话他提完自己那一件，这个口子就亮了，点进去还是空的。
 */
function OpenIssuesLink() {
  const issues = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const open = issues.data?.filter((i) => i.state !== "Candidate") ?? [];
  if (open.length === 0) return null;
  return (
    <Link
      href="/"
      className="mt-6 inline-block text-md text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
    >
      去战略议题 →
    </Link>
  );
}

function DigestSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-3 block h-5 w-[62%]" />
      <div className="mt-7 space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-hairline p-4">
            <span className="skeleton block h-2.5 w-28" />
            <span className="skeleton mt-3 block h-4 w-[72%]" />
            <span className="skeleton mt-3 block h-3 w-full" />
            <span className="skeleton mt-1.5 block h-3 w-[84%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
