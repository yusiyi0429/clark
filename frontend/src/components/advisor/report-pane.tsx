"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AnchoredStatementList,
  type AnchorFocus,
  type DocSection,
} from "@/components/advisor/anchored-doc";
import { BlockReport } from "@/components/advisor/blocks";
import { readingDigest } from "@/lib/agent/a4/blocks/reading";
import { AsyncBoundary, LoadingLine } from "@/components/async-boundary";
import { TianshuThinkingMark } from "@/components/brand/tianshu-mark";
import {
  SelectionToolbar,
  useSelectionQuote,
} from "@/components/provenance/selection-quote";
import { ResearchStepLine, researchTookText } from "@/components/research-step-line";
import { armsRework, nextStage, type ReworkPress, type ReworkStage } from "./rework";
// 类型 only：`tasks.ts` 是服务端那张任务表，编译后这一行不进客户端包（同 `signal-view.tsx`）。
import type { TaskState } from "@/lib/agent/tasks";
import { api } from "@/lib/data/client";
import type {
  ProbeNode,
  IssueKnowledge,
  IssueReport,
  ManifestItem,
  ReportSource,
  ResearchDoc,
} from "@/lib/data/types";
import { formatDay, formatStamp } from "@/lib/format";
import { useResource, type Resource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 议题研究左栏的正文：报告与图谱。
 *
 * **页签行不在这里**，在 `_views/advisor-view.tsx` 上。那一排现在是
 * `当前判断 │ 行动整理（他自己走进去之后才有）│ 情报附件 │ 知识关系`，而几条链路各自的
 * 原件（`DeepSeek`、`Claude`、`ChatGPT`…）收在情报附件那一栏自己的第二条长条上 ——
 * 模型名是链路口径，不该出现在一号位默认看到的那一屏上
 * （`command-brief/intelligence-drawer.tsx`）。
 *
 * 更早以前是两层页签：外层「判断板 / 报告原文」，进去之后里面还有一排。几条链路一来，
 * 里层那排比外层还长，而「报告原文」这个中间层没有任何自己的内容 —— 点它只是为了再点
 * 一次。所以那一层拆掉了，报告列表和选中的那一项由外面传进来。
 *
 * 四类正文：同一轮深研里各条链路各自的报告（主源那条带四节压缩面，别的只有原件）、
 * 还在跑或者跑挂了的那条链路（`PendingLane` —— 它自己的秒表和步号）、被指派 DRI 回传的
 * 承接研究（有才出现）、知识关系。各条链路是各自取证、各自写成的东西，页签上署名，
 * 不混排。
 *
 * 划词是这一栏的第一交互：选中任意一段 → 「引用提问」把原文带进对话。一号位对报告的
 * 每一句都有权问一句「凭什么」，而问的地方就是右边那一栏。句子背后的来源仍在句末那枚
 * 上标里（`trace-chip`），点得开。
 */

const SECTIONS = [
  { key: "judgment", title: "当前判断" },
  { key: "keyEvidence", title: "关键证据" },
  { key: "counters", title: "反证与风险" },
  { key: "unknowns", title: "不确定性" },
] as const;

export function ReportPane({
  issueId,
  reportsRes,
  tab,
  nodes,
  onOpenNode,
  anchorFocus,
  onQuote,
  allowRework = true,
}: {
  issueId: string;
  /**
   * 报告列表由页签行那一层持有（`_views/advisor-view.tsx`）—— 同一份数据，页签行按它
   * 排页签，这里按它取正文。SWR 认 key，两处拿到的是同一份缓存，不会多取一次。
   */
  reportsRes: Resource<IssueReport[]>;
  /** 选中的页签：某份报告的 `key`，或深研还没装配好时那个占位的 `"agent"`，或 `"knowledge"`。 */
  tab: string;
  nodes: ProbeNode[];
  onOpenNode: (nodeId: string) => void;
  anchorFocus: AnchorFocus | null;
  /** 「引用提问」—— 把选中的原文带进对话输入框。 */
  onQuote: (text: string) => void;
  /**
   * 底下那颗「打回重研」给不给。
   *
   * 开会那一页不给：那一下丢掉现有报告、起一轮十几分钟、花一笔真钱，而按下它的那一刻
   * 屋里正坐着人。**默认给** —— 议题研究那一页上它是跑砸之后唯一的出路。
   */
  allowRework?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const { selected, clear, onMouseUp } = useSelectionQuote(bodyRef);

  /*
   * 深研还没装配好时去问那张任务表 —— 五秒一次，顺手把报告列表也重问一遍。
   *
   * 这一栏原来一次都不轮询：他点进议题研究看到「深度研究还在装配」，然后这句话就
   * 一直挂在那里，直到他自己刷新页面。报告落库了他也不知道。
   *
   * `reportsRes.data` 到了才开始问：加载中那一瞬列表是空的，照它判断的话每次打开
   * 这一栏都会白发一次状态请求。
   *
   * 只问「走到第几步」这一条：报告本身落库时服务端会说一声（`liveRefresh`），页签行
   * 因此在他还站在判断板上的时候就自己长出来了，不靠这里这个定时器。
   */
  const [deep, setDeep] = useState<TaskState | null>(null);
  const reportsMutate = reportsRes.mutate;
  /*
   * 判的是「这一轮**落库**了没有」，不是「有没有 `agent` 这一栏」。
   *
   * 一条链路写完之后它那一栏就有了正文（`DraftReport`，还没落库），但整轮后面还剩两步
   * （压成四节、反证复核）—— 照「有 `agent` 就算完」判的话，轮询在这里停掉：还在跑的
   * 那两条链路永远停在占位、写完的那几份永远停在草稿，屏幕上一动不动，而后台还在跑。
   * 所以要等到 `doc` 出现。
   */
  const deepPending =
    Boolean(reportsRes.data) && !reportsRes.data?.some((r) => r.key === "agent" && r.doc);
  useEffect(() => {
    if (!deepPending) return;
    let alive = true;
    const read = () => {
      void api
        .deepResearchStatus(issueId)
        .then((st) => alive && setDeep(st))
        .catch(() => {});
    };
    read();
    const t = setInterval(() => {
      if (!alive) return;
      read();
      void reportsMutate();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [deepPending, issueId, reportsMutate]);

  if (tab === "knowledge") {
    return (
      <div className="scroll-slim min-h-0 flex-1 overflow-auto px-5 pt-[var(--pane-inset-top,1.25rem)] pb-5">
        <KnowledgeMap issueId={issueId} />
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      onMouseUp={onMouseUp}
      /* `--pane-inset-top`：上面浮着那条磨砂页签长条时，正文第一行从哪儿开始。
         那条长条压在正文上、不占流里的高度，距离由那一页给（见 `advisor-view.tsx`）。 */
      className="scroll-slim relative min-h-0 flex-1 overflow-y-auto px-7 pt-[var(--pane-inset-top,1.5rem)] pb-6"
    >
      <AsyncBoundary resource={reportsRes} skeleton={<LoadingLine label="正在取这一轮的报告" />}>
        {(list) => {
          /*
           * 选中的页签不在列表里就不硬顶一个上来。
           *
           * 深研还没装配好时页签行给的是占位的 `"agent"`，它不在列表里 —— 那就照实说
           * 那件事（下面那个空态）。顶一份承接研究的等待态上来，会把「深度研究还在装配」
           * 这句话吃掉：屏幕上只剩「等某人回传」，而一号位问的是两件事。
           */
          const active = list.find((r) => r.key === tab) ?? null;
          /*
           * 别人写的那几份原件页头上要说清楚「判断板是从哪一份压出来的」，而那一份的
           * 名字是主源自己报的（`sourceLabel`），不在这里硬编码 —— 换了写报告的模型，
           * 这句话跟着换。
           */
          const primaryLabel = list.find((r) => r.key === "agent")?.label ?? "深研报告";

          return (
            <>
              {/*
                划词只对着一份真的报告开。
                「引用提问」是拿着一句报告原文去追问 —— 而这一栏里除了报告，还有两段本产品
                自己写的话（等待态、空态）。让它们也能被引用，等于请参谋解释一句 UI 文案。
                别人写的那一份也是报告：它同样是一句一句写出来的东西，同样有权被追问。
              */}
              {active?.doc || active?.source ? (
                <SelectionToolbar
                  selected={selected}
                  onQuote={() => {
                    if (!selected) return;
                    onQuote(`「${selected.text}」`);
                    clear();
                  }}
                />
              ) : null}

              {active?.doc ? (
                <ReportDoc
                  label={active.label}
                  doc={active.doc}
                  onQuote={onQuote}
                  nodes={active.key === "agent" ? nodes : []}
                  onOpenNode={onOpenNode}
                  anchorFocus={active.key === "agent" ? anchorFocus : null}
                />
              ) : active?.source ? (
                <SourceOnlyReport
                  label={active.label}
                  onQuote={onQuote}
                  source={active.source}
                  primaryLabel={primaryLabel}
                  /*
                   * 这一份是不是判断板要压的那一份。落库之后主源走上面那一支
                   * （`ReportDoc`），所以这里为真只有一种情形：这一轮还在跑，手上是草稿。
                   */
                  primary={active.key === "agent"}
                  // 还在跑就把「走到第几步」摆在报告页头上：这一份已经能读了，而他下一个
                  // 问题一定是「那另外几份呢」。
                  step={deepPending ? deep : null}
                />
              ) : active?.pending ? (
                <PendingLane label={active.label} pending={active.pending} />
              ) : active?.awaiting ? (
                <Awaiting name={active.awaiting.name} since={active.awaiting.since} />
              ) : (
                <DeepPending task={deep} />
              )}

              {/*
               * 打回重研。
               *
               * **摆在正文最底下、单独一条线以下**，不跟上面那排页签（区块 / 原文 /
               * 四节压缩）混在一起：那一排是换个看法，一下点错了再点回来就是；这一颗
               * 按下去丢掉现有报告、起一轮十几分钟、花一笔真钱。两种东西挨在一排的
               * 后果不是难看，是他会用点页签的手劲去点它。
               *
               * 只在深研那几栏出现（`agent` / `agent:alt<n>`，以及深研还没装配好时那个
               * 占位的空栏）。承接研究是别人回传的一份东西，这颗键起的是我们自己这一轮
               * 深研，摆在那一栏上指的是别的事。
               *
               * 两种情形给：**手上有一份读得到的东西**（他读完觉得方向不对），以及
               * **这一轮跑挂了**（`deepRoundState` 说 failed —— 那一档故意不自动重试，
               * 所以这颗键是他唯一的出路，而那正是它从前最缺的地方）。还在跑的那一栏
               * 上不给：打回打的是他此刻正等着的那一轮。
               */}
              {allowRework &&
              (!active || active.key.startsWith("agent")) &&
              (active?.doc || active?.source || deep?.status === "failed") ? (
                <Rework
                  issueId={issueId}
                  onStarted={() => {
                    void reportsMutate();
                    void api
                      .deepResearchStatus(issueId)
                      .then((st) => setDeep(st))
                      .catch(() => {});
                  }}
                />
              ) : null}
            </>
          );
        }}
      </AsyncBoundary>
    </div>
  );
}

/**
 * 打回重研 —— 这一栏里唯一一个**重动作**。
 *
 * 从前这颗键在界面上根本不存在：`api.requestRework` 与 `api.startDeepResearch` 两个方法
 * 都在库上挂着，而 `src/app` 与 `src/components` 里一处都没有调用方。后果是报告跑砸了、
 * 或者他读完觉得整个方向不对时，**屏幕上没有任何办法再跑一轮**。
 *
 * ## 为什么不复用 `startDeepResearch`
 *
 * 两个方法底下走的是同一个 `reopenDeepResearch`，差别在 `requestRework` 多做两件事：
 * 把留言发给承接人、在议题时间线上留一条按真实状态写的记录（起不起得来照实说）。
 * 绕过它自己调 `startDeepResearch`，等于把那两件事丢掉换一行更短的代码。
 *
 * ## 两下，不是一下
 *
 * 哪一下算数由 `armsRework` 定，理由整段写在 `rework.ts` 上 —— 这里只负责把它按出来。
 *
 * ## 起完之后屏幕上要看得出它在跑
 *
 * 不新写进度件：`onStarted` 让外面重取报告列表并立刻问一次任务表，这一栏于是落回
 * `DeepPending`／`PendingLane`，那两处已经有 `ResearchStepLine`（步号 + 秒表）。
 */
function Rework({ issueId, onStarted }: { issueId: string; onStarted: () => void }) {
  const [stage, setStage] = useState<ReworkStage>("idle");
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  const press = (p: ReworkPress) => {
    const fire = armsRework(stage, p);
    setStage(nextStage(stage, p));
    if (!fire) return;
    setFailed(null);
    void api
      .requestRework(issueId, note)
      .then(() => {
        setNote("");
        onStarted();
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setStage("idle"));
  };

  return (
    <div className="mx-auto mt-10 max-w-[42rem] border-t border-hairline pt-4">
      {stage === "confirming" ? (
        <div className="animate-fade">
          {/* 只报事实：丢什么、要多久、留言去哪。没有一句「建议先看看…」这类替他拿主意的话。 */}
          <p className="meta leading-relaxed text-ink-muted">
            现有报告与原件会丢掉，重跑一轮最多 25 分钟。留言发给承接人，不进这一轮的模型输入。
          </p>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="留言"
            className="talk scroll-slim mt-2.5 h-20 w-full resize-none rounded-xl border border-hairline bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors duration-fast placeholder:text-ink-faint focus:border-hairline-strong"
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => press("confirm")}
              className="meta inline-flex h-8 items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90"
            >
              确认打回
            </button>
            <button
              type="button"
              onClick={() => press("cancel")}
              className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
            >
              算了
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={stage === "running"}
          onClick={() => press("open")}
          className="meta rounded-md px-2 py-1 font-medium text-ink-muted transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink disabled:opacity-50"
        >
          {stage === "running" ? "正在打回…" : "打回重研"}
        </button>
      )}
      {/* 起不起得来是库那一侧的事实，原话照抄 —— 他要拿它判断是钥匙没配还是别的。 */}
      {failed ? <p className="meta mt-2 text-counter">{failed}</p> : null}
    </div>
  );
}

/**
 * 报告还没有。三档，因为「要不要继续等」这个问题只有它们分得开。
 *
 * 这一栏原来一律写「深度研究还在装配」。跑挂的那一轮也是这句话 —— 而深研失败不会自动
 * 重试（见 `ensureDeepResearch`），于是他会守着一份永远不会来的报告。
 *
 * 在跑的那一档现在写出走到第几步、已经跑了多久。
 *
 * 没跑完那一档**把原话带出来**，并且不再替它保证「已记在运营台」：那句保证有一种情况下
 * 是假的 —— 服务重启掐断的那一轮压根没走到落记录那一步（`UnfinishedResearchRound`），
 * 而那正是他最想知道原因的一种。原话由数据层给（`deepResearchStatus`），这里只负责摆。
 */
function DeepPending({ task }: { task: TaskState | null }) {
  if (task?.status === "failed") {
    return (
      <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
        <p className="text-md text-ink">这一轮深研没跑完。</p>
        {task.error ? (
          <p className="meta mt-1.5 whitespace-pre-line text-ink-muted">{task.error}</p>
        ) : null}
        <p className="meta mt-1.5 text-ink-muted">不会自动重试。</p>
      </div>
    );
  }

  if (task?.status === "idle") {
    return (
      <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
        <p className="text-md text-ink">这件议题还没有深研，也没有一轮在跑。</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
      <div className="flex items-center gap-2">
        <TianshuThinkingMark className="size-5 flex-none" />
        <ResearchStepLine
          className="text-md block"
          step={task?.status === "running" ? task.step : undefined}
          startedAt={task?.status === "running" ? task.startedAt : undefined}
          /* 排着队那一档写的是另一句话（「排队中 · 前面还有 N 轮」），步骤和秒表一概不写。 */
          queuePosition={task?.status === "queued" ? task.queuePosition : undefined}
          fallback="深度研究还在装配"
        />
      </div>
    </div>
  );
}

/**
 * 已经点名派出去、还没回传。
 *
 * 这一栏里唯一一段不是报告的内容，所以它长得也不像报告：一个 wash 底的小块，跟深研
 * 那个空态同一副面孔 —— 「这里现在没东西，因为在等某件事」这两处是同一件事。
 *
 * 数据层只给「等谁」「从什么时候起」两个事实（`awaiting`），这句话在这里写。不转圈：
 * 等的是一个真人，转圈会让人以为再等三秒就好了。
 */
function Awaiting({ name, since }: { name: string; since: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
      <p className="text-md text-ink">等 {name} 回传。</p>
      <p className="meta mt-1.5 text-ink-muted">{formatDay(since)} 起 · 回传后原文出现在这一栏</p>
    </div>
  );
}

/**
 * 一条链路，正文还没有（`IssueReport.pending`）—— 还在跑，或者已经挂了。
 *
 * **这一栏点得动，而且他会主动点进来。** 那几条链路同时起跑，各自要跑十几分钟，那期间他
 * 会一枚一枚地点过去看「这一条到哪了」。所以这里不是一句占位，
 * 是这条链路自己的进度：它自己的秒表、它自己走到第几步。
 *
 * 计时**用的是这条链路自己的 `startedAt`**，不是整轮那个 —— 几条同时起跑但不同时结束，
 * 挂整轮那个起点的话，屏幕上那几栏的秒数会一模一样，而那正是「单独计时」要否掉的东西。
 * 同理走到第几步读的是 `pending.step`（每条链路四步），不是整轮那四步。
 *
 * 三档，因为「还要不要等」这个问题只有它们分得开：跑挂了 / 在跑 / 还没起跑。
 */
function PendingLane({
  label,
  pending,
}: {
  label: string;
  pending: NonNullable<IssueReport["pending"]>;
}) {
  if (pending.error) {
    return (
      <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
        <p className="text-md text-ink">「{label}」这一条没跑成。</p>
        {/* 原话照抄，不改写成「出了点问题」——他要拿这句话判断是钥匙没配、还是额度
            用完了、还是这一题真的搜不到东西。 */}
        <p className="meta mt-1.5 leading-relaxed text-ink-muted">{pending.error}</p>
      </div>
    );
  }

  if (!pending.step && !pending.startedAt) {
    return (
      <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
        <p className="text-md text-ink">{pending.note}。</p>
      </div>
    );
  }

  /*
   * 已经交出来的那几块**这时候就读**。
   *
   * 这一条还在 `pending`（秒表还在走、步骤还在报，那两样在这一栏里都不能停），但它交出来
   * 的块是定稿的形状 —— 一块读得通就一块能读。等它整份写完再显示的话，出稿那一步要写两千
   * 多字，那几分钟里这一栏是一句「进行中…」，而屏幕上其实已经有半份报告了。
   *
   * 那期间正文会先出来、证据表还没出来，于是芯片点不开 —— 那是预期状态，`EvidenceChip`
   * 为它留了第三种样子。
   */
  return (
    <div>
      <div className="rounded-xl border border-hairline bg-neutral-wash px-5 py-6">
        <div className="flex items-center gap-2">
          <TianshuThinkingMark className="size-5 flex-none" />
          <ResearchStepLine
            className="text-md block"
            step={pending.step}
            startedAt={pending.startedAt}
            fallback={pending.note}
          />
        </div>
      </div>
      {pending.blocks ? <BlockReport report={pending.blocks} streaming className="mt-6" /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 报告正文                                                                    */
/* -------------------------------------------------------------------------- */

function ReportDoc({
  label,
  doc,
  nodes,
  onOpenNode,
  anchorFocus,
  onQuote,
}: {
  label: string;
  doc: ResearchDoc;
  nodes: ProbeNode[];
  onOpenNode: (nodeId: string) => void;
  anchorFocus: AnchorFocus | null;
  onQuote: (text: string) => void;
}) {
  /*
   * 有原件就默认给原件。
   *
   * 「报告原文」这四个字必须说话算数：他切到这个页签，是要看那份东西本来长什么样。
   * 四节压缩是参谋的加工 —— 有用，但它回答的是另一个问题（「太长了，给我要点」），
   * 而那个问题在判断板上已经答过一次了。
   *
   * 有区块就默认给区块，**这不违反上面那一句**：区块那一份不是加工，它就是模型交上来的
   * 那份东西本身（落库的规范形态是 JSON，原文是从它拼回来的一种视图）。所以「原文」页签
   * 留着 —— 他要签的那一份、要粘给别人的那一份仍然是连续的文字。
   *
   * 三种视图不是三个开关：老报告没有 `blocks`（开关关着的那些轮次、以及区块化之前跑的
   * 全部），那时这里退回原来的两挡，一行都不变（§6⑤）。
   */
  const [view, setView] = useState<"blocks" | "source" | "digest">(
    doc.blocks ? "blocks" : doc.sourceText ? "source" : "digest",
  );

  const tabs = [
    ...(doc.blocks ? ([["blocks", "报告"]] as const) : []),
    ...(doc.sourceText ? ([["source", "原文"]] as const) : []),
    ["digest", "要点"] as const,
  ];

  /*
   * 这份报告是什么时候跑出来的、跑了多久。
   *
   * 这份文档在这之前**一个时间戳都没有** —— 报告页答不出「它有多新」，而一份三周前
   * 的深研和今天早上那份在屏幕上长得一模一样。用时接在时刻后面：三分钟出来的和一分钟
   * 出来的不是同一种东西（长的那种通常意味着质量门打回重修过、或者反证复核真跑了）。
   *
   * 两样都没有（旧数据、DRI 回传的那一份）时整行不出现，不写「时间未知」。
   *
   * 署名也在这一行。页签上现在同时挂着好几条链路（`DeepSeek`、`Claude`、`ChatGPT`、
   * `豆包`），页签说的是「哪条链路跑的」，这里说的是「谁署名」—— 那几条署的是
   * 同一个参谋，它们是同一个 Agent 的几次独立研究。页签名字里已经含着署名的（承接研究那
   * 一份写着 DRI 的名字）就不重复一遍。
   */
  const stamp = [
    doc.byAgentLabel && !label.includes(doc.byAgentLabel) ? doc.byAgentLabel : null,
    doc.at ? formatStamp(doc.at) : null,
    researchTookText(doc.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="mx-auto max-w-[42rem]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="report text-xl font-medium text-ink">{label}</h2>
        {tabs.length > 1 && (
          <div className="meta ml-auto flex items-center gap-2 text-ink-faint">
            {tabs.map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view === k}
                onClick={() => setView(k)}
                className={cn(
                  "rounded-[3px] transition-colors duration-fast",
                  view === k
                    ? "text-ink-muted underline decoration-hairline underline-offset-4"
                    : "hover:text-ink-muted",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {stamp ? <p className="meta mt-1 text-ink-faint">{stamp}</p> : null}

      {/*
       * 这一份手上一条外部证据都没有时，说在最前面。
       *
       * 摆在三挡视图**外面**：换页签换的是同一份报告的看法，而「它是不是联网核过的」在三挡上
       * 都是同一件事。摆进某一挡等于他切一下页签这句话就没了。
       *
       * 摆在正文前面而不是折在末尾：原来这句话唯一的落点是报告原文里那一句「未联网」，夹在
       * 三千字中间，而他是从判断板往下读的 —— 于是一份没有外部证据的报告和一份有二十条证据
       * 的报告在这一屏上长得一模一样。用反证那个色：它说的正是「这份东西的分量要打折」。
       */}
      {doc.noExternalEvidence ? (
        <div className="mt-3 rounded-md border-l-2 border-counter bg-counter-wash px-3 py-2">
          <p className="report text-sm font-medium text-ink">{doc.noExternalEvidence.headline}</p>
          <p className="meta mt-1 leading-relaxed text-ink-muted">{doc.noExternalEvidence.why}</p>
        </div>
      ) : null}

      {view === "blocks" && doc.blocks ? (
        <>
          <BlockReport report={doc.blocks} className="mt-5" onQuote={onQuote} />
          <AssembledFrom items={doc.assembledFrom} />
        </>
      ) : view === "source" && doc.sourceText ? (
        <>
          <SourceText text={doc.sourceText} />
          <AssembledFrom items={doc.assembledFrom} />
        </>
      ) : (
        <StructuredDoc
          doc={doc}
          nodes={nodes}
          onOpenNode={onOpenNode}
          anchorFocus={anchorFocus}
        />
      )}
    </article>
  );
}

/**
 * 主源之外的一份报告：另一条链路自己跑出来的那一份。
 *
 * 只有原件：四节压缩、判断板锚点、反证复核都只从主源那一份来 —— 判断板只有一块，
 * 「板上这一条出自哪一份原件」这个问题在产品上没有答案，所以不制造它。
 *
 * 页头那句交待不是客套。他切过来看到一份结论不一样的报告，第一个问题一定是「那我刚才
 * 在判断板上看的是哪一份」—— 那句话当场答掉。也正因为如此，这里**不显示模型标识符**
 * （`claude-opus-5` 之类）：那是账上的名字，屏幕上只说人话，页签上那个短名已经够指认。
 *
 * 那句话**按 `kind` 分三种写法**，不共用一句 —— 这一栏页头的全部作用就是让他知道手上
 * 这份东西是怎么来的，而三种来路差得很远。判断依据是数据层给的 `kind`，不按页签上的字
 * 猜：那是文案。
 *
 * - 平常那一种（`kind: "writer"`）：**另一条链路从头跑的一整套**。它自己编命题、自己
 *   联网取证、自己写、自己过出口对账 —— 所以这里**不能**再写「同一套证据、只换了写的
 *   人」。那句话是几条链路共用一份台账那一版的事实，2026-08-25 起不成立了：现在两份
 *   报告对不上，可能是读法不同，也可能是**它们手里的材料本来就不是同一批**，而后一种
 *   才指得出「有一条链路漏了某个来源」。装配清单因此各自一份（底下那个折叠块）。
 * - `kind: "synthesis"`：读了前面几份再合出来的那一份。这一步 2026-08-25 删掉了，所以
 *   这一支只会被**那天以前的老报告**走到 —— 留着是因为老数据还在库里，屏幕上不能把它
 *   说成一条独立链路。
 * - `primary`：这一份**就是**主源，只不过这一轮还没跑完（还是 `DraftReport`）。那时候
 *   前两句都不能用 —— 头一句会写成「与『ChatGPT』是同一轮…」，而那说的正是它自己。
 * - `source.unfinished`：那一轮**没跑完**（挂在后半段，或者被服务重启掐断），这几份原件是
 *   从里面救出来的（见 `UnfinishedResearchRound`）。这一支盖掉上面三种：上面那三句都在说
 *   「这一轮会跑完」，
 *   而这一轮已经不会了 —— 四节压缩、溯源、判断板都不会再有，也不会自动重开。
 */
function SourceOnlyReport({
  label,
  source,
  primaryLabel,
  primary,
  step,
  onQuote,
}: {
  label: string;
  onQuote?: (text: string) => void;
  source: ReportSource;
  primaryLabel: string;
  /** 这一份就是判断板要压的那一份（此刻只可能是还没落库的草稿）。 */
  primary?: boolean;
  /**
   * **整轮**还在跑时走到第几步 —— 不是这一条链路的进度（这一条已经写完了，它的用时就在
   * 上面那行里）。答的是「我手上这份已经读完了，那这一轮什么时候算完」。跑完了给 null。
   */
  step?: TaskState | null;
}) {
  const stamp = [
    source.byAgentLabel && !label.includes(source.byAgentLabel) ? source.byAgentLabel : null,
    source.at ? formatStamp(source.at) : null,
    researchTookText(source.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");

  const synthesis = source.kind === "synthesis";
  // 老数据里没有 `basedOn`（或者只合了一份，那种情况根上就不该发生）时退回一句不点名的
  // 说法。硬写「V4、K3」会指着两份可能并不存在的原件。
  const read = source.basedOn?.length ? `「${source.basedOn.join("」「")}」那几份` : "前面那几份";

  /*
   * 这一栏也有两面：区块那一份和原文那一份。
   *
   * 和主源那一栏用同一套页签、同一个默认（有区块就先给区块）—— 各条链路是同一个 Agent 的
   * 几次独立研究，其中一栏切页签、另一栏切不了的话，他会以为这两份东西的性质不同。
   */
  const [view, setView] = useState<"blocks" | "source">(source.blocks ? "blocks" : "source");

  return (
    <article className="mx-auto max-w-[42rem]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="report text-xl font-medium text-ink">{label}</h2>
        {source.blocks && (
          <div className="meta ml-auto flex items-center gap-2 text-ink-faint">
            {(
              [
                ["blocks", "区块"],
                ["source", "原文"],
              ] as const
            ).map(([k, text]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view === k}
                onClick={() => setView(k)}
                className={cn(
                  "rounded-[3px] transition-colors duration-fast",
                  view === k
                    ? "text-ink-muted underline decoration-hairline underline-offset-4"
                    : "hover:text-ink-muted",
                )}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
      {stamp ? <p className="meta mt-1 text-ink-faint">{stamp}</p> : null}
      {/*
        这一轮还在跑：这一条链路已经写完（上面那行里有它自己的用时），但整轮还没落库，
        所以还没有时刻（`ReportSource.at`）。这一行接的是**整轮**的进度 —— 他读完手上
        这份，下一个问题就是「另外那几条呢、这一轮还要多久」。
      */}
      {step ? (
        <div className="mt-1 flex items-center gap-1.5">
          <TianshuThinkingMark className="size-4 flex-none" />
          <ResearchStepLine
            className="meta block text-ink-faint"
            step={step.status === "running" ? step.step : undefined}
            startedAt={step.status === "running" ? step.startedAt : undefined}
            fallback="这一轮还在跑"
          />
        </div>
      ) : null}

      <p className="meta mt-4 rounded-lg bg-neutral-wash px-3.5 py-2.5 leading-relaxed text-ink-muted">
        {source.unfinished ? (
          /*
           * 这一档最要紧的是别让他把它当成一份正常报告读。原件是真的、跑出来了；
           * 缺的是那一轮的后半段 —— 所以这里把「缺什么」一条条点掉，再把挂掉那句
           * 原话照实带上（和运营台那条记录上是同一句）。
           */
          <>
            这一轮深研没跑完，留下的是已经写出来的原件本身。
            <strong className="font-medium text-ink">没有四节压缩、没有句末溯源，判断板上也没有条目</strong>
            ；不会自动重试。挂在「{source.unfinished.error}」。
          </>
        ) : primary ? (
          <>
            这一份是判断板要压的那一份原件，此刻刚写完、还没落库。四节压缩、判断板上的
            条目、以及句末那些溯源都要等这一轮跑完才有。
          </>
        ) : synthesis ? (
          <>
            同一套证据、同一份指令，外加{read}已经写完的原件，交给第三个模型合出来的 ——
            它不联网、不另取证据，多出来的只是推理。判断板和四节压缩仍然只从「{primaryLabel}」压出来。
          </>
        ) : (
          <>
            与「{primaryLabel}」是同一轮，但
            <strong className="font-medium text-ink">不是同一套证据</strong>
            ：这一份是另一条链路从头跑出来的 —— 自己编命题、自己联网取证、自己写、自己过
            一道出口对账，底下那份装配清单是它自己的。判断板和四节压缩只从「{primaryLabel}」压出来。
          </>
        )}
      </p>

      {view === "blocks" && source.blocks ? (
        <BlockReport report={source.blocks} className="mt-5" onQuote={onQuote} />
      ) : (
        <SourceText text={source.text} />
      )}
      {/* 这一份清单是**这一条链路自己**装配的（`ReportSource.assembledFrom`），不是主源那
          一份 —— 各条链路各自取证之后抄主源的过来，等于把 ChatGPT 取回的页说成 Claude 取
          回的。还没落库时它没有：清单要到这一轮收尾才封，而「装配自 N 个对象」是拿来对账
          的数，一个会在他眼前变长的数对不了账。 */}
      <AssembledFrom items={source.assembledFrom ?? []} />
    </article>
  );
}

/**
 * 报告原文。**一个字都不动**，只按 `Doc.body` 那套约定分段：空行断段，`## ` 是小标题。
 *
 * 不做锚点、不挂溯源徽章 —— 原件上任何一处「本产品加的东西」都会让「这是原文」这句话
 * 打折。要引用某一句，划词工具条照常可用（它挂在外层容器上）。
 *
 * 断段用的是正则而不是 `split("\n\n")`：深研的原文现在是模型当场写的（以前这个字段只有
 * 导入的报告才有值），而模型会给出三个换行、或者 `\r\n`。按定长字符串切的话，多出来的
 * 那个换行会让一整节连着小标题挤进同一个 `<p>`，屏幕上表现成「原文格式乱了」，而原文
 * 本身是好的。
 */
function SourceText({ text }: { text: string }) {
  return (
    <div className="mt-6 space-y-4">
      {text
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((para, i) =>
          para.startsWith("## ") ? (
            <h3 key={i} className="report pt-2 text-lg font-medium text-ink">
              {para.slice(3)}
            </h3>
          ) : (
            <p key={i} className="report text-read leading-relaxed text-ink">
              {para}
            </p>
          ),
        )}
    </div>
  );
}

/** 四节压缩面 —— 划词锚点、判断板回跳都挂在这一份上。 */
function StructuredDoc({
  doc,
  nodes,
  onOpenNode,
  anchorFocus,
}: {
  doc: ResearchDoc;
  nodes: ProbeNode[];
  onOpenNode: (nodeId: string) => void;
  anchorFocus: AnchorFocus | null;
}) {
  // 已有讨论锚点按原文序号定位；无锚点时用选读摘要，不改落库的原文及历史索引。
  const reading = doc.blocks && !nodes.length && !anchorFocus ? { ...doc, ...readingDigest(doc.blocks, doc.ledger) } : doc;
  return (
    <>
      <div className="mt-6 space-y-8">
        {SECTIONS.map((s, i) => {
          const items = reading[s.key];
          if (items.length === 0) return null;
          return (
            <section key={s.key} data-report-section>
              <h3 className="report text-lg font-medium text-ink">
                {"一二三四五"[i]}、{s.title}
              </h3>
              <div className="mt-3">
                <AnchoredStatementList
                  section={s.key as DocSection}
                  statements={items}
                  nodes={nodes}
                  onOpenNode={onOpenNode}
                  anchorFocus={anchorFocus}
                  className="space-y-3"
                />
              </div>
            </section>
          );
        })}

        <section>
          <h3 className="report text-lg font-medium text-ink">五、下一步讨论</h3>
          <p className="report mt-3 text-read text-ink">
            {reading.routeSuggestion}
          </p>
        </section>
      </div>

      <AssembledFrom items={doc.assembledFrom} />
    </>
  );
}

/** 这份东西是从哪几个对象装起来的。带 href 的点得开 —— 点不开的清单不是证明。 */
function AssembledFrom({ items }: { items: ManifestItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="mt-7 border-t border-hairline pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
      >
        装配自 {items.length} 个对象{open ? " ▾" : " ▸"}
      </button>
      {open ? (
        <ul className="animate-fade mt-2 space-y-1">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
              <span aria-hidden className="text-ink-faint">
                ·
              </span>
              {item.href ? (
                <Link
                  href={item.href}
                  className="rounded-[3px] underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
                >
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 知识关系                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 这件议题在本体里牵住的一切。
 *
 * 上一版是三列清单，节点文字截到两行、连线是 CSS 伪元素画的一小截短横 —— 那不是图，
 * 是三份被排版成图的列表。两个具体后果：**看不全**（截断的那半句往往正是这个节点为什么
 * 挂在这里的原因），**看不出关系**（短横不指向任何东西，读者得自己脑补它连到哪）。
 *
 * 这一版：
 *
 * - **每个节点全文展示**，不截断。节点是本体里的对象，对象的名字被截一半就不再是那个
 *   对象了。
 * - **连线是真的**：布局完成后量每个节点与中心的实际位置，用 SVG 画贝塞尔曲线，线的
 *   颜色就是关系的颜色。量的是 `getBoundingClientRect`，所以换行、字号、窗口宽度怎么
 *   变，线都跟着走。
 * - 左边是**公司的赌注**（判断、域、Mission），右边是**材料与产出**（文件、外部证据、
 *   衍生议题、决策）。左边是这件事赌在什么上，右边是这件事拿什么在赌。
 */

type Tone = "judgment" | "confirmed" | "factual" | "solid";

const TONE_STROKE: Record<Tone, string> = {
  judgment: "var(--judgment)",
  confirmed: "var(--confirmed)",
  factual: "var(--factual)",
  solid: "var(--ink-faint)",
};

const TONE_BAR: Record<Tone, string> = {
  judgment: "bg-judgment",
  confirmed: "bg-confirmed",
  factual: "bg-factual",
  solid: "bg-ink-faint",
};

type GraphNode = {
  id: string;
  tone: Tone;
  href?: string;
  /** 节点上方那行小字：它是哪一类对象 */
  kind: string;
  /** 编号（有就写，没有就不写） */
  code?: string;
  label: string;
  /** 底下一行状态 */
  note?: string;
  noteTone?: "counter" | "faint";
};

type Edge = { id: string; d: string; tone: Tone };

function KnowledgeMap({ issueId }: { issueId: string }) {
  const resource = useResource<IssueKnowledge>(`knowledge:${issueId}`, () =>
    api.getIssueKnowledge(issueId),
  );

  return (
    <AsyncBoundary resource={resource} skeleton={<LoadingLine label="正在梳理知识关系" />}>
      {(k) => <Graph k={k} />}
    </AsyncBoundary>
  );
}

function Graph({ k }: { k: IssueKnowledge }) {
  const left: GraphNode[] = [
    ...k.judgments.map((j) => ({
      id: `j-${j.id}`,
      tone: "judgment" as Tone,
      href: `/judgments/${j.id}`,
      kind: "在版判断",
      code: j.id,
      label: j.statement,
      note: `v${j.version} · ${
        j.standing === "shaking"
          ? "正在被本议题动摇"
          : j.standing === "confirmed"
            ? "已确认"
            : j.standing === "unverified"
              ? "还是假设"
              : "已放弃"
      }`,
      noteTone: (j.standing === "shaking" ? "counter" : "faint") as "counter" | "faint",
    })),
    ...(k.domain
      ? [
          {
            id: "domain",
            tone: "solid" as Tone,
            kind: "业务域",
            code: k.domain.code,
            label: k.domain.name,
            note: `DRI · ${k.domain.driName}`,
          },
        ]
      : []),
    ...k.missions.map((m) => ({
      id: `m-${m.id}`,
      tone: "factual" as Tone,
      kind: "同域 Mission",
      code: m.code,
      label: m.name,
    })),
  ];

  const right: GraphNode[] = [
    ...k.docs.map((d) => ({
      id: `d-${d.id}`,
      tone: "confirmed" as Tone,
      href: `/docs/${d.id}`,
      kind: "内部文件",
      label: d.title,
    })),
    {
      id: "ext",
      tone: "factual" as Tone,
      kind: "外部证据",
      label: k.externalEvidence.label,
      note: `命中本报告 ${k.externalEvidence.count} 句`,
    },
    ...k.derivedIssues.map((i) => ({
      id: `i-${i.id}`,
      tone: "judgment" as Tone,
      href: `/issues/${i.id}`,
      kind: "关联 / 衍生议题",
      code: i.id,
      label: i.title,
    })),
    ...k.decisions.map((d, n) => ({
      id: `dec-${d.id}-${n}`,
      tone: "confirmed" as Tone,
      href: d.href,
      kind: "已固化决策",
      code: d.id,
      label: d.label,
    })),
  ];

  const hostRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  /*
   * 量位置、画线。
   *
   * 测量放在 ResizeObserver 的回调里，不是效应体里 —— 效应体里同步 setState 会被
   * `react-hooks/set-state-in-effect` 拦下，而 ResizeObserver 在 observe 那一刻就会
   * 触发一次，首屏那一次测量照样有。
   */
  const all = [...left, ...right];
  const signature = all.map((n) => n.id).join("|");
  useEffect(() => {
    const host = hostRef.current;
    const hub = hubRef.current;
    if (!host || !hub) return;

    const measure = () => {
      const H = host.getBoundingClientRect();
      const B = hub.getBoundingClientRect();
      setSize({ w: H.width, h: H.height });
      const next: Edge[] = [];
      nodeRefs.current.forEach((el, id) => {
        if (!el.isConnected) return;
        const R = el.getBoundingClientRect();
        const onLeft = R.left + R.width / 2 < B.left + B.width / 2;
        const x1 = (onLeft ? B.left : B.right) - H.left;
        const y1 = B.top + B.height / 2 - H.top;
        const x2 = (onLeft ? R.right : R.left) - H.left;
        const y2 = R.top + R.height / 2 - H.top;
        const mid = (x1 + x2) / 2;
        const tone = all.find((n) => n.id === id)?.tone ?? "solid";
        next.push({ id, tone, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
      });
      setEdges(next);
    };

    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(hub);
    nodeRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  return (
    <div className="min-w-[41rem]">
      <div ref={hostRef} className="relative">
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0"
          width={size.w}
          height={size.h}
        >
          {edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              stroke={TONE_STROKE[e.tone]}
              strokeWidth={1}
              strokeOpacity={0.42}
            />
          ))}
        </svg>

        <div className="relative grid grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_minmax(0,1fr)] items-center gap-x-6">
          <div className="space-y-2.5 py-2">
            {left.map((n) => (
              <Node key={n.id} node={n} side="left" ref={register(n.id)} />
            ))}
          </div>

          {/* 中：议题本体。整张图上唯一的深色实心块 —— 别的都是围着它的。 */}
          <div className="flex justify-center">
            <div
              ref={hubRef}
              className="w-full rounded-xl bg-solid px-4 py-4 text-solid-fg shadow-sm"
            >
              <p className="meta text-solid-fg/60">{k.issue.id}</p>
              <p className="report mt-1 text-sm leading-relaxed">{k.issue.title}</p>
            </div>
          </div>

          <div className="space-y-2.5 py-2">
            {right.map((n) => (
              <Node key={n.id} node={n} side="right" ref={register(n.id)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 图上的一个点。全文展示，不截断 —— 名字被截一半的对象不再是那个对象。 */
function Node({
  node,
  side,
  ref,
}: {
  node: GraphNode;
  side: "left" | "right";
  ref: (el: HTMLElement | null) => void;
}) {
  const body = (
    <span className="block">
      <span className={cn("flex items-baseline gap-1.5", side === "right" && "flex-row")}>
        <span className={cn("h-2.5 w-[2px] shrink-0 rounded-full", TONE_BAR[node.tone])} />
        <span className="meta text-ink-faint">{node.kind}</span>
        {node.code ? <span className="meta text-ink-faint">{node.code}</span> : null}
      </span>
      <span className="mt-1 block text-sm leading-relaxed text-ink">{node.label}</span>
      {node.note ? (
        <span
          className={cn(
            "meta mt-0.5 block",
            node.noteTone === "counter" ? "text-counter" : "text-ink-faint",
          )}
        >
          {node.note}
        </span>
      ) : null}
    </span>
  );

  const shell = cn(
    "block rounded-lg border border-hairline bg-surface px-3 py-2 transition-colors duration-fast",
    node.href && "hover:border-hairline-strong hover:bg-neutral-wash",
  );

  return node.href ? (
    <Link ref={ref as (el: HTMLAnchorElement | null) => void} href={node.href} className={shell}>
      {body}
    </Link>
  ) : (
    <div ref={ref as (el: HTMLDivElement | null) => void} className={shell}>
      {body}
    </div>
  );
}
