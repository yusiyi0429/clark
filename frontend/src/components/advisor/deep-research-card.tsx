"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { ReportPane } from "@/components/advisor/report-pane";
import { TianshuThinkingMark } from "@/components/brand/tianshu-mark";
import { PaneTab, PaneTabBar } from "@/components/pane-tabs";
import { ResearchStepLine } from "@/components/research-step-line";
// 类型 only：`tasks.ts` 是服务端那张任务表，编译后这一行不进客户端包（同 `report-pane.tsx`）。
import type { TaskState } from "@/lib/agent/tasks";
import { api } from "@/lib/data/client";
import type { IssueReport } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 这一轮对话把事情转给了深度研究 —— **对话流里那一块能点开的东西。**
 *
 * ## 为什么它得在对话里，而不是只在左栏
 *
 * 转深研这件事是**在对话里发生的**：他追问到一处轮内答不完的地方，参谋当面说「这条我
 * 转给深研」。而转完之后，那份产物出现在屏幕另一半的报告栏里，中间没有任何一条线把两者
 * 连起来 —— 他得记住刚才那句话，过几分钟自己想起来去点左边那排页签。这一块补的就是
 * 那条线：转手发生在哪儿，产物的门就开在哪儿。
 *
 * ## 四种状态，一个位置
 *
 *   在跑    整块底是一道流动的马赛克，点不动。上面写着走到第几步、跑了多久。
 *   好了    底停下，整块变成可点的 —— 点开是一扇浮窗，里面是这一轮的报告原文。
 *   没跑成  照实说哪一步挂了。**不在这里给「再跑一轮」** —— 理由写在 `ResearchWindow` 上。
 *   没起跑  照实说没起跑，底也不流（`idle` 是真会回的一档，见下面 `status` 那一段）。
 *
 * 四种状态**不换位置、不换大小**。换的话，他刚要点下去的时候这块东西自己长高了。
 *
 * ## 为什么不给百分比
 *
 * 同 `ResearchStepLine` 那一段：一轮深研走七步，第 3 步可能占掉整轮七成时间，折成
 * 百分比就是在说「快好了」。这里只说「在动」和「走到第几步」——两句都是真的。
 */
export function DeepResearchCard({
  issueId,
  why,
  onQuote,
}: {
  issueId: string;
  /** 参谋当时说的转手理由。原话，不是这里编的一句。 */
  why: string;
  /** 从浮窗里划一句话回对话输入框。 */
  onQuote: (text: string) => void;
}) {
  const task = useDeepStatus(issueId);
  const [open, setOpen] = useState(false);

  /*
   * 四种状态，一句话一句话地对上任务表。**`idle` 单独算一种，不并进「在跑」。**
   *
   * `deepResearchStatus` 真的会回 `idle`：demo 模式一律不叫模型（`ensureDeepResearch`
   * 第一件事就是挡它），议题不在这一份库里也是 idle。并进「在跑」的后果是屏幕上有一块
   * 东西永远在流，而后台一件事都没发生 —— 那是这块屏幕最不该出的一种错。
   *
   * `null` 是「还没问到」，和 `idle` 也分得开：前者三百毫秒后自己会有答案，后者是答案。
   */
  const status = task?.status ?? null;
  const running = status === "running";
  const openable = status === "done" || status === "failed";

  return (
    <>
      <button
        type="button"
        disabled={!openable}
        onClick={() => setOpen(true)}
        /* 读屏念的是**此刻能做什么**，不是这块东西叫什么。点不动的那三档它照旧念得到
           里面那两行字（按钮的内容），所以这里只需要把「点开会发生什么」说清楚。 */
        aria-label={status === "done" ? "打开这一轮深度研究的报告" : undefined}
        className={cn(
          /*
           * `relative` + `overflow-hidden` 是那道马赛克的前提：它是一层绝对定位的兄弟，
           * 铺满这块的内框，圆角跟着这块走（`border-radius: inherit`）。
           */
          "relative w-full overflow-hidden rounded-xl border px-4 py-3.5 text-left",
          "transition-colors duration-fast ease-swift",
          /*
           * 底一律是纸色 —— **四种状态同一块白**。在跑那一档靠上面那道光说话，好了
           * 那一档靠边框和右边那枚箭头说话；换底色的话，同一块东西看起来像四样东西。
           */
          "bg-paper",
          openable
            ? "cursor-pointer border-hairline-strong hover:bg-neutral-wash"
            : "cursor-default border-hairline",
        )}
      >
        {/*
         * **只有真的在跑的时候才流。** 这道光说的是「后台此刻在办这件事」——
         * 还没问到（`null`）和压根没起跑（`idle`）都不许流：一块在流的底是一句
         * 断言，而那两种情况下我们说不出这句话。
         *
         * 画法是 `.mosaic-flow` + `.mosaic-on-paper`（globals.css）—— 和首页那张会议卡
         * 在办、议题卡在研究时是**同一道光**，只是落在纸色的面上要换成墨色（白光扫白纸
         * 看不见）。压在内容底下（内容那一层 `relative`），并且 `pointer-events: none`。
         */}
        {running ? <span aria-hidden className="mosaic-flow mosaic-on-paper" /> : null}

        <span className="relative flex items-center gap-3">
          {running ? <TianshuThinkingMark className="size-[20px] flex-none" /> : null}
          <span className="min-w-0 flex-1">
            <span className="block text-md font-medium text-ink">
              {status === "done"
                ? "深度研究 · 结果已就绪"
                : status === "failed"
                  ? "这一轮深度研究没跑成"
                  : status === "idle"
                    ? "深度研究还没起跑"
                    : "深度研究进行中"}
            </span>
            <span className="meta mt-0.5 block text-ink-faint">
              {status === "done" ? (
                "点开读这一轮的报告原文"
              ) : status === "failed" ? (
                // 原话来自那次失败，不是这里编的。
                (task?.error ?? "没留下原因")
              ) : status === "idle" ? (
                "这条议题手上还没有一轮在跑 —— 报告落库之前这里点不开"
              ) : (
                <ResearchStepLine
                  step={task?.step}
                  startedAt={task?.startedAt}
                  queuePosition={task?.status === "queued" ? task.queuePosition : undefined}
                  fallback={task === null ? "正在问这一轮到哪了" : "刚起跑，还没报出步骤"}
                />
              )}
            </span>
          </span>
          {openable ? (
            <ArrowUpRight className="size-4 flex-none text-ink-faint" aria-hidden />
          ) : null}
        </span>
      </button>

      {/*
       * 参谋当时为什么把它转出去 —— **摆在这块外面，不摆在里面。**
       *
       * 摆进去的话，这一句会跟着上面那三行状态一起被按钮的 hover 和 disabled 管着，
       * 而它不是这颗按钮的一部分：它是他刚读过的那段回复的一句脚注，此刻只是被再说
       * 一遍好让这块东西有出处。
       */}
      <p className="meta mt-1.5 text-ink-faint">转手理由：{why}</p>

      {open ? (
        <ResearchWindow
          issueId={issueId}
          onClose={() => setOpen(false)}
          onQuote={(text) => {
            onQuote(text);
            // 引完就关：他拿这句话是要接着问，而问的地方在这扇窗底下。
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 这一轮深研跑到哪了。
 *
 * 五秒一问，**跑完就不问了**。走定时器而不是 `useResource`：那一层的重验证全关着
 * （理由写在 `use-resource.ts`），而这里要的正是「服务端自己在推进的一件事」——
 * 同 `ReportPane` 里那一段，两处是同一个做法。
 *
 * `null` 是「还没问到」，不是「不在跑」：屏幕上那两句话分得开（见上面 `fallback`）。
 */
function useDeepStatus(issueId: string): TaskState | null {
  const [task, setTask] = useState<TaskState | null>(null);
  const settled = task?.status === "done" || task?.status === "failed";

  useEffect(() => {
    if (settled) return;
    let alive = true;
    const read = () => {
      void api
        .deepResearchStatus(issueId)
        .then((st) => alive && setTask(st))
        .catch(() => {});
    };
    read();
    const t = setInterval(read, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [issueId, settled]);

  return task;
}

/**
 * 报告本身 —— **一扇盖住半屏的浮窗**，不是对话流里展开的一大段。
 *
 * ## 为什么是浮窗
 *
 * 一份深研报告是四节判断、几十条证据台账、一份装配清单。把它就地展开进对话流，等于
 * 在他刚读的那几轮之间插进十屏东西 —— 往回翻找刚才那句话要滚过整份报告。而浮窗是
 * 「去读一份东西，读完回来」，位置一点没动。
 *
 * ## 里面是同一个 `ReportPane`
 *
 * 不另写一份报告渲染。左栏那一份已经认得四类正文（几条链路各自的原件、还在跑的那一条、
 * 承接研究、知识关系）、认得划词引用、认得跑挂了怎么说 —— 抄一份过来的代价不是几百行，
 * 是同一份报告在同一个产品里长出两种样子，而其中一种迟早会漏掉新加的那一类。
 *
 * ## 这里不给「打回重研」
 *
 * `allowRework={false}`。这扇窗只在议题研究那一页开得出来（转深研要这条议题手上真有
 * 一份报告，那是议事对话层的四道闸之一），而那一页左栏的报告栏上已经有那颗键。同一块
 * 屏幕上摆两颗「丢掉现有报告、起一轮十几分钟、花一笔真钱」的键，是在制造一次误按。
 */
function ResearchWindow({
  issueId,
  onClose,
  onQuote,
}: {
  issueId: string;
  onClose: () => void;
  onQuote: (text: string) => void;
}) {
  /*
   * 和议题研究那一页同一个 SWR key —— 同一份缓存，开这扇窗不会多取一次报告列表，
   * 左栏刚取回来的那一份这里直接就有。
   */
  const reportsRes = useResource<IssueReport[]>(`reports:${issueId}`, () =>
    api.listReports(issueId),
  );
  const reports = reportsRes.data;
  const [picked, setPicked] = useState<string | null>(null);
  /*
   * 选中哪一栏**算出来，不在效应体里改状态**：列表还没到的那一瞬什么都不在里面，
   * 照它下结论会把他正读的那一栏顶掉（同 `advisor-view.tsx` 那一段的理由）。
   * 默认落在主源那一份上；这一轮还没装配好时落在占位的 `agent` 上，那时正文是
   * 「深度研究还在装配」加一块走着的表。
   */
  const tab = picked && reports?.some((r) => r.key === picked) ? picked : "agent";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  /* 盖住全屏的东西一律 portal 到 body：祖先一旦有 transform，fixed 的基准就不是视口了。 */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="这一轮深度研究的报告"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 走 `.floating-thick`（唯一允许阴影和半透明的那一档）。高度取死的 86vh 而不是
          跟着内容长：报告有长有短，跟着内容长的话，换一栏页签整扇窗会自己跳一次大小。 */}
      <div className="floating-thick animate-panel flex h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl">
        <header className="flex h-12 flex-none items-center gap-2 border-b border-hairline px-5">
          <span className="meta font-medium text-ink">深度研究报告 · {issueId}</span>
          <button
            type="button"
            onClick={onClose}
            className="meta ml-auto rounded-md border border-hairline-strong px-3 py-1 font-medium text-ink transition-colors duration-fast hover:bg-neutral-wash"
          >
            关闭
          </button>
        </header>

        <div
          className="relative flex min-h-0 flex-1 flex-col"
          /* 那条悬浮的磨砂页签长条压在正文上、不占流里的高度，第一行往下让这么多。
             和议题研究那一页同一个数 —— 同一条长条不该在两处离正文远近不同。 */
          style={{ "--pane-inset-top": "3.5rem" } as React.CSSProperties}
        >
          {/* 一轮深研同时跑几条独立链路，各写各的一份。页签只在真有第二份时才出现 ——
              一排只有一格的单选，说的是「你没有选择」，那就不该占一条长条的位置。 */}
          {reports && reports.length > 1 ? (
            <PaneTabBar signature={`${tab}:${reports.map((r) => r.key).join(",")}`}>
              {reports.map((r) => (
                <PaneTab
                  key={r.key}
                  active={tab === r.key}
                  {...(r.pending && !r.pending.step && !r.pending.error
                    ? { disabled: true, title: r.pending.note }
                    : { onClick: () => setPicked(r.key) })}
                >
                  {r.label}
                </PaneTab>
              ))}
            </PaneTabBar>
          ) : null}

          <ReportPane
            issueId={issueId}
            reportsRes={reportsRes}
            tab={tab}
            /*
             * 链路图不在这扇窗里 —— 它是左栏那一页的东西，这里给空。给空的后果只有一个：
             * 报告里那几处划线句点不出「对应节点亮起来」，而那个节点在这扇窗背后，
             * 亮了他也看不见。
             */
            nodes={[]}
            onOpenNode={() => {}}
            anchorFocus={null}
            onQuote={onQuote}
            allowRework={false}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
