"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { ALL_ISSUES, ConsoleShell } from "@/components/agenda/console-shell";
import { DayBoard } from "@/components/agenda/day-board";
import { meetStyle } from "@/components/agenda/tone";
import { AsyncBoundary } from "@/components/async-boundary";
import { agendaCompareBy, slotLabel, UNRANKED } from "@/lib/data/agenda";
import { api, ApiError } from "@/lib/data/client";
import type { DayHalf, DomainSummary, IssueSummary, MeetingSlot } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 编排会议 —— **左边一列议题，右边一天的日程，中间靠拖。**
 *
 * ## 它换的是右边那块地方，不是整屏
 *
 * 这一页复用的是一号位那套 `ConsoleShell`（左边那一列：雷达、八块生意、字标），换的
 * 只是右边那块呈现区。**这不再是"和主屏共用同一个壳"那句话原来想说的事**——2026-09-02
 * 这一页从 `(tkos)/schedule` 搬到了 `/sec/schedule`，从一号位主屏点进来这条路已经不
 * 存在了，旧注释说的"不让他觉得跳到了另一个产品"因此无从谈起。
 *
 * 现在的路是反过来的：秘书从 `/sec` 自己的壳（品牌栏 + 编排会议/纪要审阅两个入口）
 * 点进这一页，看到的却是一号位控制台那套雷达和八块业务域——**这恰恰是旧注释想避免
 * 的那种"跳到另一个产品"的感觉，只是方向换了边**。之所以还这么接着用，是省一次重写
 * （`ConsoleShell` 现成、这一页的拖拽交互本来就要一块够大的落区），不是因为它对秘书
 * 这一侧是对的。这是一笔明账，记在 `src/app/sec/schedule/page.tsx` 里：等这一侧的
 * 东西多起来、值得有自己的布局时再改。
 *
 * 它仍然是一条路由而不是首页上的一个开关：这一页要的东西（一整天的日程、翻页、参会
 * 范围）在一屏里摆不下，而拖拽正需要一块够大的落区。
 *
 * ## 域只筛左边那一列，不筛右边那一天
 *
 * 左边问的是「我此刻在排哪一块的事」，按域筛是对的。**右边那一天整天不筛** —— 一场会
 * 本来就可能横跨两个域（那正是一号位的会该有的样子），按域筛的话同一场会在格子里会缺
 * 几件，而缺的那几件恰好是他此刻要决定的。
 *
 * ## 拖：落区亮起来，不画插入线
 *
 * 上一版在议题之间画一条插入线（那时的落点是「插到第几件之前」）。粒度换成上午/下午之后
 * 落点不再是一条缝，是**一整块面积** —— 所以由格子自己亮（`.drop-zone[data-over]`）。
 * 会内的先后顺序此刻由拖进去的次序决定，够用：一场会三五件，谁先谈是会上的事。
 */
export function ScheduleView({
  /**
   * 「完成编辑」按下去之后回哪儿。默认 `"/"`——这一页原本就活在一号位主屏底下，
   * 编辑完回主屏是唯一的意思。
   *
   * 现在它也在 `/sec/schedule` 下被秘书用：`src/app/sec/schedule/page.tsx` 传的是
   * `"/sec"`。这个按钮是整页唯一的主动作，也是唯一的出口——秘书按下它心里想的是
   * "我编完了"，不是"我要去一号位控制台"；默认值不能改（改了一号位那条路就断了），
   * 所以出口只能靠调用方按自己的地界传进来。
   */
  doneHref = "/",
}: {
  doneHref?: string;
} = {}) {
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const slotsRes = useResource<MeetingSlot[]>("slots", () => api.listSlots());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());

  const [date, setDate] = useState(api.today);
  /* 域的选中态由这一页自己拿着（同 `DeployedView`）：壳只负责画出来、把点击交回来。 */
  const [domainId, setDomainId] = useState(ALL_ISSUES);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);

  /*
   * 日程板上要摆的那一份：在办的全部，**包括会已经开完的那几件** —— 他往回翻一天，
   * 昨天那一格上该看得见当时排了什么。
   */
  const issues = useMemo(
    () => (issuesRes.data ?? []).filter((i) => i.state !== "Candidate" && !i.settled),
    [issuesRes.data],
  );
  /*
   * 左边那一列要摆的那一份：**再减掉会已经开完的**。
   *
   * 这一页做的事是「安排接下来」，而一场已经开完的会不在「接下来」里 —— 它在等纪要，
   * 那件事现在是秘书的活，在 `/sec/debriefs` 做（相二把首页右栏那一叠撤了，换成了
   * 动态面板：`DynamicPanel`）。留在这儿的话，他昨天开过的那两件今天还摆在待排清单
   * 里，看着像还没安排过。
   */
  const schedulable = useMemo(() => issues.filter((i) => !i.slot?.ended), [issues]);
  const slots = slotsRes.data ?? [];
  const domains = domainsRes.data ?? [];

  const rank = useMemo(() => {
    const m = new Map(schedulable.map((i) => [i.id, i.agendaRank] as const));
    return (id: string) => m.get(id) ?? UNRANKED;
  }, [schedulable]);
  const sorted = useMemo(() => {
    const inDomain =
      domainId === ALL_ISSUES
        ? schedulable
        : schedulable.filter((i) => i.domainId === domainId);
    return [...inDomain].sort(agendaCompareBy(rank));
  }, [schedulable, rank, domainId]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      await Promise.all([issuesRes.mutate(), slotsRes.mutate()]);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "这一下没成。");
    } finally {
      setBusy(false);
    }
  };

  /* ---- 拖 ------------------------------------------------------------------ */

  const zones = useRef(new Map<DayHalf, HTMLElement>());
  /**
   * 正在拖的那一件。
   *
   * `w` / `grabX` / `grabY` 是按下去那一刻量的：浮卡要和原卡一样宽、而且要停在手指
   * 按住它的**那一点**上。不量的话，卡会在按下去的一瞬间跳到指针的左上角 —— 那一下
   * 看起来像卡片自己弹了一下，而他什么都没做。
   */
  const [drag, setDrag] = useState<{
    issueId: string;
    x: number;
    y: number;
    live: boolean;
    fromX: number;
    fromY: number;
    w: number;
    grabX: number;
    grabY: number;
  } | null>(null);
  const [over, setOver] = useState<DayHalf | null>(null);

  const hitTest = (x: number, y: number): DayHalf | null => {
    for (const [half, el] of zones.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return half;
    }
    return null;
  };

  const onDown = (issueId: string) => (e: React.PointerEvent) => {
    if (busy || e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({
      issueId,
      x: e.clientX,
      y: e.clientY,
      fromX: e.clientX,
      fromY: e.clientY,
      live: false,
      w: r.width,
      grabX: e.clientX - r.left,
      grabY: e.clientY - r.top,
    });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.fromX;
    const dy = e.clientY - drag.fromY;
    /*
     * 四个像素之内不算拖 —— 这一块同时还是「点进这件议题」的链接，而按下去那一瞬间手指
     * 必然会动一两个像素。没有这道门槛，每一次点击都会先触发一次拖拽。
     */
    if (!drag.live && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!drag.live) {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* 抓不住就不抓，拖动照常。 */
      }
    }
    setDrag({ ...drag, x: e.clientX, y: e.clientY, live: true });
    setOver(hitTest(e.clientX, e.clientY));
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    const half = over;
    setDrag(null);
    setOver(null);
    if (!d.live) return;
    if (half) {
      void run(() => api.scheduleIssue(d.issueId, { date, half }));
    } else {
      /*
       * 松手时不在任何一个格子里 = **把它撤出日程**。
       *
       * 只对本来就排着的那几件生效。没排过的拖到空处应该什么都不发生 —— 那一下是一次
       * 落空，而不是一个动作。
       */
      const moved = schedulable.find((i) => i.id === d.issueId);
      if (moved?.slot) void run(() => api.unscheduleIssue(d.issueId));
    }
  };

  /* ---- 画 ------------------------------------------------------------------ */

  const dragged = drag?.live ? sorted.find((i) => i.id === drag.issueId) ?? null : null;

  return (
    <ConsoleShell
      current="issues"
      domains={domains}
      domainId={domainId}
      onPickDomain={setDomainId}
      /* 左栏那一列的数按全量算，和另外两屏同一个口径（见 `ConsoleShell`）。 */
      issues={issuesRes.data ?? []}
      /* 这一页嵌在 `SecLayout` 的 `<main>` 里，头顶还压着秘书那一侧的品牌栏——不能
         再照默认那样管自己要一整个视口，得吃 `SecLayout` 分给这一段的那一份高度。
         细账见 `console-shell.tsx` 里 `heightClass` 的注释。 */
      heightClass="h-full"
      showLogout={false}
    >
      <section
        className="relative grid h-full grid-cols-2 divide-x divide-hairline overflow-hidden rounded-2xl bg-list-ground [--r:1rem]"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* 左：议题 */}
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <header className="flex h-10 items-center px-1">
            <Link
              href={doneHref}
              className="inline-flex h-8 items-center rounded-lg bg-solid px-3 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90"
            >
              完成编辑
            </Link>
            <h2 className="mx-auto pr-16 text-md font-medium text-ink">议题</h2>
          </header>

          <div className="scroll-slim min-h-0 space-y-2 overflow-y-auto p-2 [--p:0.5rem]">
            {failure ? (
              <p role="alert" className="meta px-1 text-counter">
                {failure}
              </p>
            ) : null}
            <AsyncBoundary resource={issuesRes} skeleton={<Skeleton />}>
              {() =>
                sorted.length === 0 ? (
                  <p className="meta px-1 py-2 text-ink-faint">
                    {domainId === ALL_ISSUES
                      ? "现在没有在办的战略议题。"
                      : "这一块现在没有要排的议题。"}
                  </p>
                ) : (
                  sorted.map((issue) => (
                    <IssueChip
                      key={issue.id}
                      issue={issue}
                      today={api.today}
                      /* 拖起来之后原位只留一块压淡的占位：清单不塌陷，他松手时那一行
                         还在原地。真正跟着手指走的是下面那块浮卡。 */
                      placeholder={drag?.live === true && drag.issueId === issue.id}
                      onPointerDown={onDown(issue.id)}
                    />
                  ))
                )
              }
            </AsyncBoundary>
          </div>
        </div>

        {/* 右：这一天。**不按域筛** —— 一场会横跨两个域是常态（见文件头）。 */}
        <DayBoard
          date={date}
          today={api.today}
          slots={slots}
          issues={issues}
          domains={domains}
          over={over}
          busy={busy}
          onDate={setDate}
          onZoneRef={(half, el) => {
            if (el) zones.current.set(half, el);
            else zones.current.delete(half);
          }}
          onEndMeeting={(slotId) => void run(() => api.endMeetingSlot(slotId))}
          onInvite={(slotId) => setInviting(slotId)}
        />

        {inviting ? (
          <InvitePanel
            slot={slots.find((s) => s.id === inviting)!}
            domains={domains}
            issues={issues}
            busy={busy}
            onClose={() => setInviting(null)}
            onToggle={(domainId, on) =>
              void run(() => api.inviteDomain(inviting, domainId, on))
            }
          />
        ) : null}
      </section>

      {/*
       * 手上那张卡。**它必须坐在这两栏外面。**
       *
       * 上一版是原卡自己 `transform` 挪位，靠 `.agenda-row[data-dragging]` 那个
       * `z-index: 20` 浮起来。那个 z-index 从来没生效过 —— 卡外面套着两层 `overflow`
       * （左列的 `overflow-y-auto`、这一块的 `overflow-hidden`），所以卡一过中缝就被
       * **裁掉**，而被裁掉的东西没有层级可言。屏幕上的样子是：拖到右半边，卡断在
       * 分隔线上。
       *
       * `fixed` 不受祖先 `overflow` 裁剪（也不建立在它们的裁剪盒里），所以这一块天然
       * 压在整屏上面。`pointer-events-none` 是必须的：它跟着指针走，挡在指针底下的话
       * 落区那一侧的命中判定会打在它自己身上。
       */}
      {dragged && drag ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.x - drag.grabX,
            top: drag.y - drag.grabY,
            width: drag.w,
          }}
        >
          <IssueChip issue={dragged} today={api.today} ghost />
        </div>
      ) : null}
    </ConsoleShell>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 左列里的一件议题。**排上会的仍然是深色重块** —— 和主屏同一套画法，所以他不用在两屏
 * 之间重新学一遍「深色 = 定了时间」。
 *
 * 三种画法，同一份内容：
 *
 *   平时        坐在清单里，`cursor-grab`，右边一枚抓握纹
 *   `placeholder` 它此刻在手上 —— 原位留一块压淡的，清单不塌陷
 *   `ghost`     手上那一块，由 `ScheduleView` 摆进一层 `fixed` 里（见那边）
 */
function IssueChip({
  issue,
  today,
  placeholder = false,
  ghost = false,
  onPointerDown,
}: {
  issue: IssueSummary;
  today: string;
  placeholder?: boolean;
  ghost?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const slot = issue.slot;
  return (
    <div
      onPointerDown={onPointerDown}
      style={slot ? meetStyle(slot.seq) : undefined}
      className={cn(
        "agenda-row concentric group relative touch-none px-3.5 py-2.5 select-none",
        slot ? "meet-face dither" : "list-block",
        !slot && !issue.readyForMeeting && "opacity-45",
        placeholder && "opacity-30",
        ghost ? "cursor-grabbing shadow-e2" : "cursor-grab",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn("meta", slot ? "[color:var(--meet-fg-dim)]" : "text-ink-faint")}>
          {issue.id}
        </span>
        {/* 写整句（`明天上午`），不只写「上午」—— 右边那块板一次只显示一天，而左边这一列
            里的会可能排在别的日子。只写半天的话，一件排在后天上午的议题在今天这一屏上
            看起来就像已经排进了眼前这一格。 */}
        {slot ? (
          <span className="meta [color:var(--meet-fg-dim)]">{slotLabel(slot, today)}</span>
        ) : null}
        {/* 前期调研没做完的那几件整块压淡 —— 这就是「还不能排会」那句话本身。 */}
      </div>
      <span
        className={cn(
          "clamp-2 mt-0.5 block text-sm leading-relaxed",
          slot ? "[color:var(--meet-fg)]" : "text-ink",
          /* 给右边那枚纹路让出位置，标题不压到它下面。 */
          "pr-5",
        )}
      >
        {issue.title}
      </span>
      <Grip on={slot ? "meet" : "paper"} />
    </div>
  );
}

/**
 * 卡片右沿那枚抓握纹。
 *
 * 两件事：一是**这一屏和主屏不一样**——他从首页点进编排之后，两屏的左半边长得很像，
 * 一走神就会忘了自己在哪一边；二是**这张卡能拖**，而拖拽在屏幕上本来是没有痕迹的
 * 能力，不给暗示就只能靠他自己试。
 *
 * **整张卡照旧都能拖，这枚纹路不是唯一的把手。** 只有它能拖会让「按住卡片中间拖不动」
 * 变成一个新毛病 —— 那正是拖拽最常见的坏法。
 *
 * 六个点自己画，不用图标库里那枚 `GripVertical`：那个是描边的竖线，在 12px 上两条线
 * 各不足 1px，渲染出来是一团灰。这里要的是六个实心的小点，`currentColor` 跟着卡面
 * 的颜色走（深色那几块用 `--meet-fg-dim`，纸色那几块用 `--ink-faint`）。
 */
function Grip({ on }: { on: "meet" | "paper" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-1/2 right-2 grid -translate-y-1/2 grid-cols-2 gap-[3px]",
        /* 平时半透明 —— 它是暗示，不是控件。指针压到这张卡上时加深一档。 */
        "opacity-50 transition-opacity duration-fast group-hover:opacity-90",
        on === "meet" ? "[color:var(--meet-fg-dim)]" : "text-ink-faint",
      )}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="size-[3px] rounded-full bg-current" />
      ))}
    </span>
  );
}

/**
 * 参会范围。
 *
 * **默认一个都不用勾**：到场的域由这场会上那几件议题算出来。这一层只补一种情况 ——
 * 某个域的 DRI 要来，但他手上没有议题在议程上。所以议题贡献的那几个在这里是**灰的、
 * 勾不掉的**：它们不是一个选择，是一个事实。
 */
function InvitePanel({
  slot,
  domains,
  issues,
  busy,
  onClose,
  onToggle,
}: {
  slot: MeetingSlot;
  domains: DomainSummary[];
  issues: IssueSummary[];
  busy: boolean;
  onClose: () => void;
  onToggle: (domainId: string, on: boolean) => void;
}) {
  const fromIssues = new Set(
    slot.issueIds
      .map((id) => issues.find((i) => i.id === id)?.domainId)
      .filter(Boolean) as string[],
  );
  return (
    <div
      role="dialog"
      aria-label="参会范围"
      className="floating-thick animate-panel absolute top-16 right-8 z-30 w-64 rounded-xl p-3"
    >
      <div className="flex items-center pb-2">
        <span className="text-sm font-medium text-ink">参会范围</span>
        <button
          type="button"
          onClick={onClose}
          className="meta ml-auto rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          关闭
        </button>
      </div>
      <ul className="space-y-0.5">
        {domains.map((d) => {
          const auto = fromIssues.has(d.id);
          const on = auto || slot.extraDomainIds.includes(d.id);
          return (
            <li key={d.id}>
              <button
                type="button"
                disabled={auto || busy}
                onClick={() => onToggle(d.id, !on)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast",
                  auto
                    ? "cursor-default text-ink-faint"
                    : on
                      ? "bg-wash-hover text-ink"
                      : "text-ink-muted hover:bg-wash-hover hover:text-ink",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    on ? "bg-solid" : "bg-hairline-strong",
                  )}
                />
                <span className="min-w-0 truncate">{d.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-live="polite" className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="list-block concentric px-3.5 py-2.5">
          <span className="skeleton block h-2.5 w-20" />
          <span className="skeleton mt-2 block h-3.5 w-[78%]" />
        </div>
      ))}
    </div>
  );
}
