"use client";

import { ChevronDown, EyeOff, Search, Timer } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { api, ApiError } from "@/lib/data/client";
import type { AgentRunRecord, InboxDisposition, InboxSignal } from "@/lib/data/types";
import type { TaskState } from "@/lib/agent/tasks";
import { formatStamp } from "@/lib/format";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * GET /api/agent/a1a/inbox 的响应 —— 除了任务状态，还带上 A1a 的结论。
 *
 * `issueId` = 这条信号开出来的那条议题。**开不出来就没有这个字段**（判为噪音、模型挂了、
 * 或者产出里没有议题正文），所以屏幕上那条链接只在它有值时才出现。
 */
type InboxTaskState = TaskState & { judged?: AgentRunRecord["status"]; issueId?: string };

/**
 * 有价值的信号 —— 潜在议题那一屏下半段。
 *
 * 扫描（`lib/scan/run.ts`，按靶点策略检索 + 逐条研判）每轮把过线的投到这里。
 * **这一段不做任何研判**：分数、命中的 KIQ、一句话理由、建议的议题方向，全是扫描那一步
 * 算完的；这一段只把它们摆开，让一号位挑。
 *
 * ## 它为什么长在潜在议题那一屏上，而不是自己一页
 *
 * 它原来是一页（`/signals-inbox`），从潜在议题那一屏标题行上的一个口子进。两边在一号位
 * 眼里是重合的：都是「今天有什么新东西要我看」。但两样东西在数据上差得很远 —— 一条待挑
 * 的信号只花过一次便宜的机器打分，没有议题号、没有卡、没有预研；一张潜在议题卡是已经
 * 立了案的，立案那一下就自动起一轮预研（真实的模型调用）。所以合的是**页面**，不合
 * **对象**：信号不强转成议题（那等于每天替他花八轮没人要的预研，还把标题确认那一步
 * 跳过去），而是在同一屏上放到卡片底下，分量低一档。
 *
 * 分量低一档靠形式，不靠标签：卡片是格子里的块、20px 的问句；这一段是一段清单里的行、
 * 14px 的标题、灰字理由，三键缩成 meta 尺寸。**不折叠** —— 它是这一屏上唯一要他动手的
 * 活，折起来他就看不见了。超过一轮扫描的封顶（8 条）才把分数更低的那些折成一行。
 *
 * 三键的重量差得很远，所以底色分三档：
 *   - **升级为议题** —— 先把要立的那句话摆给他过目，确认后当场立案，再去跑 A1a 补正文。
 *   - **待定** —— 记一笔，先从这一段拿走。
 *   - **不看了** —— 同上。**没有撤销**（账在数据层，v1 只记不读）。
 *
 * 按下去屏幕不跳走、行也不消失：他可能连着处置四五条，每一次都被弹到别处或者让列表
 * 当场重排，这一屏就没法一口气看完。行留在原地、按钮换成一句结果；升级的那条同时会在
 * 上面的格子里多出一张「预研进行中」的卡 —— 同一件事在一屏上出现两处，是对的：他看得见
 * 那条信号被搬上去了。刷新之后这一行就不在了，只剩卡。
 */
export function SignalsInboxSection() {
  const resource = useResource<InboxSignal[]>("signals-inbox", () => api.listInboxSignals());

  return (
    <AsyncBoundary resource={resource} skeleton={<InboxSkeleton />}>
      {(signals) => <InboxList signals={signals} />}
    </AsyncBoundary>
  );
}

/** 一轮扫描最多收 8 条（`max_review_items`）。超过这个数的那些先折起来。 */
const FOLD_AFTER = 8;

function InboxList({ signals }: { signals: InboxSignal[] }) {
  /*
   * 一条都没有就整段不出现 —— 和原来那个「有货才出现」的口子一个道理：这一段是一份
   * 待办，空着的时候一行「0 条」只是噪音。扫描的节奏在扫描记录那一页说。
   *
   * 这个判断放在 hooks 之后（见下面），这里先只算出来。
   */
  const empty = signals.length === 0;
  /*
   * 本地快照：处置后的行留在屏幕上带着结论，缓存怎么变都不动屏幕。
   * 只 seed 一次，之后不再跟着 `signals` 同步 —— 站内导航回来时缓存是新的，
   * 但屏幕上已处置的那几条仍在原地。用 lazy initializer，首次渲染就拿到数据。
   */
  const [snapshot] = useState<InboxSignal[]>(() => signals);

  /** 第 9 条起折着的那几条展没展开。 */
  const [showAll, setShowAll] = useState(false);

  /*
   * 带着 `#inbox` 进来的（旧地址 `/signals-inbox` 的跳转）要落到这一段上。浏览器自己
   * 按锚点滚的那一下发生在页面加载时，而这一段是数据到了才渲染的 —— 那时它还不在，
   * 于是页面停在顶上。所以数据到了之后自己滚一次；只在挂载时看一眼 hash，不监听它，
   * 因为同页那条「新增 N 个信号 →」点的时候这一段已经在了，浏览器自己滚得到。
   */
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#inbox") return;
    document.getElementById("inbox")?.scrollIntoView({ behavior: "instant", block: "start" });
  }, []);

  /** 这一次进来点过的那几条：留在屏幕上，只是换一句结果。 */
  const [acted, setActed] = useState<Record<string, InboxDisposition>>({});
  /**
   * 正在确认升级的那一条，以及框里此刻的文字。
   *
   * **默认值是这条信号自带的「建议方向」** —— 扫描那一步研判完就写好的一句问题句
   * （`suggestedIssue`）。没有它才回落到信号标题：标题是媒体给稿件起的名字，
   * 拿它当议题会让池子里多一条读起来像新闻的议题。
   */
  const [confirming, setConfirming] = useState<{ key: string; text: string } | null>(null);
  /** 已经升级成议题的那几条：`dedupeKey` → 他确认的那句话 + 开出来的议题号。 */
  const [upgraded, setUpgraded] = useState<Record<string, { text: string; issueId: string }>>({});
  /**
   * 参谋判不值得、他仍然开出来的那几条：`dedupeKey` → 新议题号。
   *
   * 和 `judging` 分开存：那一份是每两秒问回来的任务状态，A1a 那次运行的结论
   * （`judged === "ignored"`）要原样留在屏幕上 —— 这一下开出来的议题不抹掉参谋说过的话。
   */
  const [openedAnyway, setOpenedAnyway] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [judging, setJudging] = useState<Record<string, InboxTaskState>>({});
  /** 行内错误：写失败时显示，保留三个按钮让他能再点一次。 */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const invalidate = useInvalidate();

  /*
   * 有在跑的就每 2 秒问一次进度。
   *
   * 依赖写成拼起来的字符串而不是数组 —— 数组每次渲染都是新引用，effect 会每帧
   * 重挂一次计时器，看起来正常，实际是在按渲染频率打接口。
   */
  const running = Object.entries(judging)
    .filter(([, s]) => s.status === "running")
    .map(([k]) => k)
    .join("\n");

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      for (const key of running.split("\n")) {
        void fetch(`/api/agent/a1a/inbox?key=${encodeURIComponent(key)}`, { cache: "no-store" })
          .then((r) => r.json() as Promise<InboxTaskState>)
          .then((s) => setJudging((cur) => ({ ...cur, [key]: s })))
          .catch(() =>
            // 问不到进度就说问不到。一直转圈是这一页最不能出的错：他会以为还在跑。
            setJudging((cur) => ({
              ...cur,
              [key]: { status: "failed", error: "问不到进度了（网络中断？）。" },
            }))
          );
      }
    };
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [running]);

  /**
   * 确认那一下。**议题当场就建出来，不等模型。**
   *
   * 顺序是有讲究的：`api.upgradeSignal` 同步地立案（一条 Candidate 议题、一张卡、
   * 一轮预研），所以他松手时潜在议题那一屏上就有它了；随后那一发 A1a 只是去写四块
   * 框架，跑完由服务端补到同一条议题上（见 `applyA1aInbox` 里那道「议题已经在了」的闸）。
   *
   * A1a 起不起得来**不影响这条议题的成立** —— 所以它那一步的失败只进错误行，
   * 不把已经建好的东西撤掉。
   */
  const confirmUpgrade = async (sig: InboxSignal, text: string) => {
    const title = text.trim();
    if (!title) return;
    setBusy(sig.dedupeKey);
    setErrors((cur) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sig.dedupeKey]: _, ...rest } = cur;
      return rest;
    });
    try {
      const { issueId } = await api.upgradeSignal(sig.dedupeKey, title);
      setConfirming(null);
      setUpgraded((cur) => ({ ...cur, [sig.dedupeKey]: { text: title, issueId } }));
      setActed((cur) => ({ ...cur, [sig.dedupeKey]: "issue" }));
      /* 潜在议题那一屏立刻要有它；待挑这一份也重问（这条已经被标成处置过了）。 */
      invalidate("signals-inbox", "digest:today", "issues");

      /*
       * 再去起 A1a 写正文。**不 await 它的结果来决定屏幕** —— 屏幕上那一块此刻已经
       * 是「已升级」，而它确实已经升级了。这一发只是让参谋把四块框架补上。
       */
      void fetch("/api/agent/a1a/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: sig.dedupeKey }),
        cache: "no-store",
      })
        .then((r) => (r.ok ? (r.json() as Promise<InboxTaskState>) : null))
        .then((state) => {
          if (state) setJudging((cur) => ({ ...cur, [sig.dedupeKey]: state }));
        })
        .catch(() => {
          /* 补正文没起来不影响这条议题。它自己那一格会照实说没有那四块。 */
        });
    } catch (e) {
      setErrors((cur) => ({
        ...cur,
        [sig.dedupeKey]: e instanceof ApiError ? e.message : "这一下没有走完。",
      }));
    } finally {
      setBusy(null);
    }
  };

  const dispose = async (sig: InboxSignal, action: Exclude<InboxDisposition, "issue">) => {
    setBusy(sig.dedupeKey);
    setErrors((cur) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sig.dedupeKey]: _, ...rest } = cur;
      return rest;
    });
    try {
      await api.disposeInboxSignal(sig.dedupeKey, action);
      setActed((cur) => ({ ...cur, [sig.dedupeKey]: action }));
      invalidate("signals-inbox");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "这一下没有走完。";
      setErrors((cur) => ({ ...cur, [sig.dedupeKey]: msg }));
    } finally {
      setBusy(null);
    }
  };

  if (empty) return null;

  const left = snapshot.filter((s) => !acted[s.dedupeKey]).length;

  /*
   * 折叠按快照切，不按处置后剩几条：处置过的行留在原地（见文件开头），切在剩余数上
   * 会让一次「不看了」把折起来的一条顶上来，而那正是这一段要避免的当场重排。
   * 人报的排在最前面（`listInboxSignals` 那一头排的），所以折起来的永远是分数最低的抓取。
   */
  const shown = showAll ? snapshot : snapshot.slice(0, FOLD_AFTER);
  const folded = snapshot.length - shown.length;

  return (
    /*
     * `id="inbox"`：扫完那一行「新增 N 个信号 →」和原来 `/signals-inbox` 那条路都落到这里。
     * `scroll-mt` 给顶栏留出位置，不然跳过来时段落标题压在顶栏底下。
     */
    <section id="inbox" className="mt-10 scroll-mt-24 border-t border-hairline pt-5">
      {/*
       * 段落标题只有一行小字：还剩几条。**不是 h1** —— 这一屏的 h1 是上面那句
       * 「值得注意的新议题」，这一段是它底下分量低一档的东西。
       *
       * **底下那句「这些东西哪来的」撤了。** 来路在行上早就分得清（上报的那几条不占
       * 分数那一格，写的是「DRI 上报 · 某某」），头上再替全批说一遍是多的；「升级之后
       * 才会立案」那半句同理 —— 升级那一下会把要立的话摆出来让他过目，做的时候看得见。
       * **不写「已扫描 N 条」** —— 那个分母没人核得动。
       */}
      <h2 className="meta text-ink-faint">有价值的信号 · 还剩 {left} 条</h2>

        <ul className="card mt-4 overflow-hidden">
          {shown.map((sig, i) => (
            /* `row concentric` 挂在 `<li>` 上：缝里那条发丝线是 `.row + .row` 画的，只认相邻兄弟。 */
            <li
              key={sig.dedupeKey}
              className={cn(
                "stagger row concentric",
                /* 升级过的那一块整块换脸：深底白字，而且只剩三样（见 `Upgraded`）。 */
                upgraded[sig.dedupeKey] ? "p-0" : "px-3.5 py-3.5",
              )}
              style={{ "--i": i } as React.CSSProperties}
            >
              {upgraded[sig.dedupeKey] ? (
                <Upgraded
                  title={sig.title}
                  issue={upgraded[sig.dedupeKey].text}
                />
              ) : (
                <>
              <div className="flex items-baseline gap-2.5">
                {sig.kind === "reported" ? (
                  /*
                   * 人报的那一条**不摆分数位** —— 那个位置空着比填一个占位符好：它在屏幕上
                   * 就是「这条没有机器分数」，而这正是事实。可信度写在名字上。
                   */
                  <span className="meta font-medium text-ink">DRI 上报 · {sig.by}</span>
                ) : (
                  <span
                    className={cn(
                      "meta tabular-nums font-medium",
                      sig.score >= 4.5 ? "text-confirmed" : "text-ink-muted"
                    )}
                  >
                    {sig.score.toFixed(1)}
                  </span>
                )}
                {/* 人报那一支的 url 可能是空串（上报页那个字段不是必填）—— 空的时候
                    不画链接，因为没有可去的地方就不该长得像能点。 */}
                {sig.url.trim() ? (
                  <a
                    href={sig.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 text-base leading-relaxed text-ink underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:decoration-ink-faint"
                  >
                    {sig.title}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 text-base leading-relaxed text-ink">
                    {sig.title}
                  </span>
                )}
              </div>

              <div className="meta mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-faint">
                <span>{sig.source || "未标来源"}</span>
                {sig.publishedAt ? <span>{formatStamp(sig.publishedAt)}</span> : null}
                {sig.kind === "crawled" ? (
                  <>
                    {sig.kiq ? <span>{sig.kiq}</span> : null}
                    {sig.origin === "discovered" ? <span>检索找到的</span> : null}
                  </>
                ) : null}
              </div>

              {sig.why ? <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{sig.why}</p> : null}
              {sig.kind === "crawled" && sig.suggestedIssue ? (
                <p className="meta mt-1 text-ink-faint">建议方向：{sig.suggestedIssue}</p>
              ) : null}

              <div className="mt-3">
                {acted[sig.dedupeKey] ? (
                  <Outcome
                    action={acted[sig.dedupeKey]}
                    task={judging[sig.dedupeKey]}
                    dedupeKey={sig.dedupeKey}
                    openedAnyway={openedAnyway[sig.dedupeKey]}
                    onOpenedAnyway={(issueId) => {
                      setOpenedAnyway((cur) => ({ ...cur, [sig.dedupeKey]: issueId }));
                      invalidate("signals-inbox");
                    }}
                  />
                ) : confirming?.key === sig.dedupeKey ? (
                  <ConfirmUpgrade
                    text={confirming.text}
                    busy={busy === sig.dedupeKey}
                    failure={errors[sig.dedupeKey]}
                    onText={(text) => setConfirming({ key: sig.dedupeKey, text })}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => void confirmUpgrade(sig, confirming.text)}
                  />
                ) : (
                  <>
                    {errors[sig.dedupeKey] && (
                      <p className="meta mb-2 text-counter" aria-live="polite">
                        {errors[sig.dedupeKey]}
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-1.5 sm:max-w-sm">
                      <Act
                        icon={<Search className="size-3.5" aria-hidden />}
                        label="升级为议题"
                        tone="solid"
                        disabled={busy !== null}
                        /*
                         * 不直接立案 —— 先把要立的那句话摆出来让他过一眼。默认值是扫描
                         * 那一步写好的「建议方向」，没有就退回信号标题（媒体给稿件起的
                         * 名字，所以只是兜底）。
                         */
                        onClick={() =>
                          setConfirming({
                            key: sig.dedupeKey,
                            text:
                              (sig.kind === "crawled" && sig.suggestedIssue) || sig.title,
                          })
                        }
                      />
                      <Act
                        icon={<Timer className="size-3.5" aria-hidden />}
                        label="待定"
                        tone="outline"
                        disabled={busy !== null}
                        onClick={() => void dispose(sig, "watch")}
                      />
                      <Act
                        icon={<EyeOff className="size-3.5" aria-hidden />}
                        label="不看了"
                        tone="bare"
                        disabled={busy !== null}
                        onClick={() => void dispose(sig, "dismiss")}
                      />
                    </div>
                  </>
                )}
              </div>
                </>
              )}
            </li>
          ))}
        </ul>

      {folded > 0 ? (
        /* 折起来的那几条一句说清是什么：分数更低的抓取，不是「更多」。 */
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="meta mt-3 flex items-center gap-1.5 rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          还有 {folded} 条分数更低的
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

/**
 * 升级前那一下确认。
 *
 * ## 为什么要有这一步
 *
 * 上一版按下「开成议题」就直接去跑 A1a，标题由模型写。于是**池子里那条议题叫什么，
 * 一号位事先不知道**——他按的是「这条值得看」，拿回来的却可能是一句他不会那么问的话。
 * 而议题的标题不是装饰：它是后面深研、判断、开会都围着转的那个问题本身，问错了，
 * 后面每一步都在答一个他没问的问题。
 *
 * 所以这一步只做一件事：**把要立的那句话摆到他眼前**。默认值不是空的（空框等于让他
 * 从头写一遍），是扫描研判那一步已经写好的「建议方向」。他可以原样确认，也可以改。
 *
 * ## 它不是弹层
 *
 * 就地展开在这一行里，不盖住别的信号。他此刻在做的事是**在几条信号之间挑**，
 * 一个盖住全屏的弹层会把正在比较的那几条藏起来 —— 而对比正是他按下这一步的依据。
 */
function ConfirmUpgrade({
  text,
  busy,
  failure,
  onText,
  onCancel,
  onConfirm,
}: {
  text: string;
  busy: boolean;
  failure?: string;
  onText: (next: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="animate-fade rounded-lg bg-neutral-wash p-3 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
      <p className="meta text-ink-faint">升级成潜在议题，标题写成：</p>
      <textarea
        aria-label="议题标题"
        autoFocus
        rows={2}
        value={text}
        disabled={busy}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          /* ⌘/Ctrl+Enter 确认；裸 Enter 留给换行 —— 一句问题句也可能想断两行写。 */
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onConfirm();
          }
          if (e.key === "Escape") onCancel();
        }}
        className="report scroll-slim mt-1.5 field-sizing-content max-h-40 w-full resize-none overflow-y-auto rounded-md border border-hairline bg-paper px-2.5 py-2 text-md leading-relaxed text-ink outline-none transition-colors duration-fast focus:border-hairline-strong disabled:opacity-50"
      />
      <div className="mt-2.5 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={onConfirm}
          className="inline-flex h-8 items-center rounded-lg bg-solid px-3 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "正在立案…" : "确认升级"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          算了
        </button>
      </div>
      {failure ? (
        <p role="alert" className="meta mt-2 text-counter">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 确认之后那一块。**深底白字，只剩三样。**
 *
 * 三样是：这条信号原来叫什么、他确认立成了什么议题、以及「已升级为潜在议题」。
 * 分数、来源、日期、KIQ、理由、建议方向全部撤掉 —— 那几样是**帮他决定要不要升级**
 * 的材料，而决定已经做完了。留着它们，这一行会继续看起来像一条待办。
 *
 * 换成深色不是为了好看：这一屏上其余每一行都是浅色的待办，深的那一块因此一眼就
 * 分得出「这条已经处理完了」。同一套语言在首页那一栏也用着（排上会的那几件是深色
 * 重块），所以他不用重新学一遍。
 *
 * **刷新之后它就不在了** —— 升级那一下服务端已经把这条信号标成处置过（列表按
 * `disposedAs` 过滤）。留在屏幕上只是为了不让他按完之后眼前一跳：他可能连着处置
 * 四五条，每一次都让列表当场重排，这一页就没法一口气看完。
 */
function Upgraded({ title, issue }: { title: string; issue: string }) {
  return (
    <div className="bg-solid px-3.5 py-3.5 text-solid-fg">
      <p className="meta opacity-70">{title}</p>
      <p className="report mt-1.5 text-md leading-relaxed font-medium">{issue}</p>
      <p className="meta mt-2 opacity-70">已升级为潜在议题</p>
    </div>
  );
}

/**
 * 点完之后那一行字。
 *
 * A1a 判为噪音（`ignored`）**不是失败**，是一个正经结论：这条不值得开成议题。混成
 * 「失败」的话，他会以为系统坏了然后再点一次，而那是一次真实的模型调用。
 */
function Outcome({
  action,
  task,
  dedupeKey,
  openedAnyway,
  onOpenedAnyway,
}: {
  action: InboxDisposition;
  task?: InboxTaskState;
  dedupeKey: string;
  /** 参谋判不值得、他仍然开出来的那条议题。这一次进来还没开就是 undefined。 */
  openedAnyway?: string;
  onOpenedAnyway: (issueId: string) => void;
}) {
  if (action === "watch") return <p className="meta text-ink-muted">已记为待定。</p>;
  if (action === "dismiss") return <p className="meta text-ink-faint">已记下不看了。</p>;

  if (!task || task.status === "running" || task.status === "idle") {
    return (
      <p className="meta text-ink-muted" aria-live="polite">
        正在开成议题 —— 调研这一步要两次模型调用，稍等…
      </p>
    );
  }
  if (task.status === "failed") {
    return (
      <p className="meta text-counter">
        这一条没开成：{task.error ?? "没有给出原因。"}（处置已经记下了，账不会丢。）
      </p>
    );
  }
  // `done` 但 A1a 判为噪音 —— 用中性色，不是报错的红。
  if (task.judged === "ignored") {
    return (
      <>
        <p className="meta text-ink-muted">
          A1a 判这条不值得开成议题 —— 处置已经记下了。
        </p>
        {/*
         * 参谋这句话不是终局。**这一条原来就死在这里了** —— 屏幕上只有上面那一行字，
         * 他没有任何办法否掉这次判断。参谋的结论留在原地，他要开就在它下面开。
         */}
        {openedAnyway ? (
          <div className="mt-1.5">
            <OpenedLine issueId={openedAnyway} />
          </div>
        ) : (
          <OpenAnyway dedupeKey={dedupeKey} onOpened={onOpenedAnyway} />
        )}
      </>
    );
  }
  /*
   * 议题真的开出来了。那条链接是这一行的全部意义 —— 他此刻想做的就是读一眼那条议题。
   *
   * 这一句**只说立案这件事**，不提预研：`issueFromSignal` 确实同时起了一轮，但那一轮
   * 起没起成（demo 档不叫模型、图服务挂了就是 failed）这一侧看不见。那条议题自己的
   * 页面照实写着预研到哪了，这里不替它承诺。
   */
  if (task.issueId) {
    return <OpenedLine issueId={task.issueId} />;
  }
  /*
   * 跑完了、也不是判为噪音，却没有议题 —— 这条路上只有一个原因（产出里没有议题正文），
   * 但那个原因这一侧看不见，所以只说看得见的：没开出来，结论在那条 Run 上。
   * 旧文案「议题还需手动创建」不能留：手动创建已经不是这条路的收尾了。
   */
  return (
    <p className="meta text-ink-muted">
      调研完成，但这一条没开出议题。结论记在这条信号上了。
    </p>
  );
}

/**
 * 议题开出来了那一行。**两条路共用**：A1a 判为值得自己开的，和参谋判不值得、
 * 他自己开的。开出来的是同一种东西，写成两句话只会让人以为是两种。
 */
function OpenedLine({ issueId }: { issueId: string }) {
  return (
    <p className="meta text-confirmed">
      已开成潜在议题 ——{" "}
      <Link
        href={`/signals/${issueId}`}
        className="rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:decoration-ink-faint"
      >
        {issueId}
      </Link>
    </p>
  );
}

/**
 * 参谋判不值得，他还是要开。
 *
 * **不填标题不给按。** 判为噪音那条路上模型一个对象都没建（`applyA1aInbox` 的 `ignore`
 * 支），也就没给过任何议题正文 —— 没有可回落的东西。他要否掉这次判断，就得自己说清
 * 这件事是什么。拿信号原标题顶上去的话，池子里会多一条标题是一家媒体稿件标题的议题。
 */
function OpenAnyway({
  dedupeKey,
  onOpened,
}: {
  dedupeKey: string;
  onOpened: (issueId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const open = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const issue = await api.openIssueAnyway(dedupeKey, text);
      onOpened(issue.id);
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : "这一下没有走完。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 sm:max-w-md">
        <input
          value={title}
          disabled={busy}
          placeholder="议题标题"
          onChange={(e) => setTitle(e.target.value)}
          /* 回车就是按那颗键。 */
          onKeyDown={(e) => {
            if (e.key === "Enter") void open();
          }}
          className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || !title.trim()}
          onClick={() => void open()}
          className="meta inline-flex h-8 flex-none items-center rounded-md border border-hairline-strong px-3 font-medium text-ink transition-colors duration-fast ease-swift hover:bg-neutral-wash disabled:opacity-40"
        >
          {busy ? "正在开成议题…" : "我还是要开"}
        </button>
      </div>
      {failed ? (
        <p className="meta mt-1.5 text-counter" aria-live="polite">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 动作按重量分三档：实心=主出口，描边=次要出口，无框=降级。同 signal-view。
 * 高度 8，比卡片详情页那三颗矮一档 —— 这一段在潜在议题那一屏上分量低一档，键也跟着小。
 */
function Act({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "solid" | "outline" | "bare";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "meta inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg px-1 font-medium whitespace-nowrap transition-colors duration-fast ease-swift disabled:opacity-40",
        tone === "solid" && "bg-solid text-solid-fg hover:opacity-90",
        tone === "outline" && "border border-hairline-strong text-ink hover:bg-neutral-wash",
        tone === "bare" && "text-ink-faint hover:text-ink-muted"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function InboxSkeleton() {
  return (
    <div aria-live="polite" className="mt-10 border-t border-hairline pt-5">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-2.5 block h-3.5 w-[46%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-4 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3.5">
            <span className="skeleton block h-4 w-[78%]" />
            <span className="skeleton mt-2 block h-2.5 w-48" />
            <span className="skeleton mt-2.5 block h-3.5 w-[64%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
