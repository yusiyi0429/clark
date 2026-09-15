"use client";

import { useMemo, useState, type CSSProperties } from "react";

import { bySlotTime, domainsOfSlot, slotLabel } from "@/lib/data/agenda";
import { api, ApiError } from "@/lib/data/client";
import type { DomainSummary, IssueSummary, MeetingSlot } from "@/lib/data/types";
import { TianshuMark } from "@/components/brand/tianshu-mark";
import { cn } from "@/lib/utils";
import { DebriefCard, saveDebriefPointText } from "./debrief-card";
import { meetStyle } from "./tone";

/**
 * 待确认的会议纪要 —— 首页右半屏的右边一列。
 *
 * ## 按会分组，不是一条长清单
 *
 * 一场会过了三件议题就出三份提炼。它们是同一场会的产物，所以摞在一起：抬头写这场会
 * 什么时候开的，底下是那几张卡。分开摊成一条长清单的话，他要自己把「这三张是同一场」
 * 认回来 —— 而那正是分组本来就该替他做的事。
 *
 * ## 摞着，展开才铺开
 *
 * 收起时只露最上面那一张，后面几张各露一条边。一场会三件、三场会九件，摊开是九块内容
 * 压在首页上，而它们是**待处理的**，不是要读的。摞起来之后每一场只占一张卡的高度，
 * 而且每一次只逼他做一个决定：这一件，认不认。
 *
 * ## 这一栏只装一种东西：**已经提炼完、等他确认的**
 *
 * 上一版这里装两截：会到点了但纪要还没进来的（挂着「上传纪要 / 未召开」两颗键），和已经
 * 提炼完等他确认的。理由是「这一栏自己就是那个提醒 —— 会开完了它就在这儿，纪要一天不来
 * 它一天不走」。
 *
 * **那条被推翻了。** 一件还没交材料的事和一份已经摆在他面前的摘要，要他做的动作根本不是
 * 同一类：前者是「去把东西弄来」（催人、找录音、或者承认这场会没开），后者是「读一眼，
 * 认不认」。混在一栏里，这一栏就回答不了「我现在有几件要拍板」—— 而那是它唯一要回答的
 * 问题。缺材料的那几场因此留在中间那一栏，跟着议题本身走。
 *
 * 所以分组只看 `debrief.slotId`：没有提炼的议题在这里连一行都不占。
 *
 * ## 卡面只有概述和要点
 *
 * 一张卡上他要读的就两样：一句概述，几条要点。边界、未决、待办、完整记录全在卡自己的
 * 展开里（见 `DebriefCard`）。这一条是这一栏存在的前提 —— 要是必须读完整份复盘才敢按
 * 确认，那这一栏就只是把「点进去读文档」换了个地方。
 */
export function DebriefColumn({
  issues,
  slots,
  domains,
  today,
  onRefresh,
  showTodoDestination,
}: {
  /**
   * 候选议题。**只有带 `debrief` 的那几件会落到这一栏上**，别的原样忽略 ——
   * 所以外面传进来一份「会开完的」还是一份「全部的」都不影响这一栏的内容。
   */
  issues: IssueSummary[];
  /** 会议表 —— 抬头那一行要它写日期，颜色也要它排序。 */
  slots: MeetingSlot[];
  /** 域的名字表，用来把抬头上那几枚域标写出来。和议题栏同一份写法。 */
  domains: DomainSummary[];
  today: string;
  onRefresh: () => Promise<unknown>;
  /**
   * 每张卡上的待办后面写一句「它去了哪儿」。**原样透传给 `DebriefCard`，这一层不解释
   * 它的含义**（整段理由写在那边的同名 prop 和 `todoDestination` 上）。
   *
   * 默认 `false`，和 `DebriefPoints.readOnly` 是同一个形状：由页面那一层主动打开。这一栏
   * 自己判断不了该不该标 —— 那一句成不成立取决于「摊在屏幕上的是不是全集」，而这一栏摊
   * 的是外面递进来的那一份 `issues`，全不全只有递的人知道。
   */
  showTodoDestination?: boolean;
}) {
  const [openSlots, setOpenSlots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /* 颜色按时间序取，和议题栏、日程板同一个口径（`toneOf`）。 */
  const seqOf = useMemo(() => {
    const ordered = [...slots].sort(bySlotTime);
    const m = new Map(ordered.map((s, i) => [s.id, i] as const));
    return (slotId: string) => m.get(slotId) ?? 0;
  }, [slots]);

  const domainName = useMemo(() => {
    const m = new Map(domains.map((d) => [d.id, d.name] as const));
    return (id: string) => m.get(id);
  }, [domains]);
  const domainOfIssue = useMemo(() => {
    const m = new Map(issues.map((i) => [i.id, i.domainId] as const));
    return (id: string) => m.get(id);
  }, [issues]);

  /*
   * 按会分组，一场一块。**键取的是提炼上那个 `slotId`** —— 它记的是「这一份是哪一场会
   * 谈出来的」，会后来撤了它也还在，所以这一栏不会因为一次撤会把已经提炼好的东西弄丢。
   *
   * 一块里只有一种议题：等他确认的。会到点了、材料还没交的那几件不在这里（理由整段写在
   * 文件头上），所以这里不再分档。
   */
  const groups = useMemo(() => {
    const by = new Map<string, IssueSummary[]>();
    for (const i of issues) {
      const slotId = i.debrief?.slotId;
      if (!slotId) continue;
      const g = by.get(slotId) ?? [];
      g.push(i);
      by.set(slotId, g);
    }
    return [...by.entries()]
      .map(([slotId, list]) => ({ slotId, slot: slots.find((s) => s.id === slotId), list }))
      .sort((a, b) => {
        /*
         * **只按会议时间倒序：刚散的那一场在最上面。**
         *
         * 上一版先按「等纪要的排前面」分两档，理由是那是还没喂进来的东西。那条规则
         * 被推翻了：一号位在这一栏上找东西的方式是**按时间回想**（「刚才那场会」
         * 「昨天下午那场」），而不是按「这一场缺不缺材料」。分两档之后，今天刚开完的
         * 那场会可能被压在上周某一场的下面 —— 而他此刻要处理的几乎总是最近这一场。
         *
         * 取不到 slot 的那几块（会撤了、库里没这一场）退回按 slotId 倒序 —— slotId 是
         * `日期-半天` 拼出来的，字典序和时间序同向。
         */
        if (a.slot && b.slot) return bySlotTime(b.slot, a.slot);
        return b.slotId.localeCompare(a.slotId);
      });
  }, [issues, slots]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      await onRefresh();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "这一下没成。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-10 items-center px-1">
        <h2 className="mx-auto text-md font-medium text-ink">待确认的会议纪要</h2>
      </header>

      <div className="scroll-slim min-h-0 space-y-4 overflow-y-auto p-2 [--p:0.5rem]">
        {failure ? (
          <p role="alert" className="meta px-1 text-counter">
            {failure}
          </p>
        ) : null}

        {groups.length === 0 ? (
          <EmptyColumn />
        ) : (
          groups.map(({ slotId, slot, list }) => {
            const open = openSlots.includes(slotId);
            const seq = seqOf(slotId);
            /*
             * 抬头上那几枚域标。和议题栏那一块同一个来源（`domainsOfSlot`）—— 参会的域
             * 是从会上那几件议题各自的域算出来的，不是另存一份。
             *
             * 会已经开过了，这一行答的是「刚才那场会是谁在场」；他一屏上可能同时压着两三
             * 场会的纪要，而时间加件数分不开「昨天下午那场谈钱的」和「昨天下午那场谈人的」。
             */
            const domainIds = slot
              ? domainsOfSlot(slot, domainOfIssue)
              : ([...new Set(list.map((i) => i.domainId).filter(Boolean))] as string[]);
            const names = domainIds.map((id) => domainName(id)).filter(Boolean);
            return (
              <section key={slotId}>
                <header className="flex items-center gap-2 px-1 pb-2">
                  <span
                    style={meetStyle(seq)}
                    className="meta inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-px [background:var(--meet)] [color:var(--meet-fg)]"
                  >
                    {slot ? slotLabel(slot, today) : "已开完的会"}
                  </span>
                  {names.length > 0 ? (
                    <span className="meta truncate text-ink-muted">{names.join(" · ")}</span>
                  ) : null}
                  <span className="meta flex-none text-ink-faint">{list.length} 件</span>
                  {list.length > 1 && (
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenSlots((prev) =>
                          prev.includes(slotId)
                            ? prev.filter((x) => x !== slotId)
                            : [...prev, slotId],
                        )
                      }
                      className="meta ml-auto flex-none rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
                    >
                      {open ? "收起" : "展开"}
                    </button>
                  )}
                </header>

                <div className="space-y-2">
                  {open || list.length === 1 ? (
                    list.map((issue) => (
                      <Card
                        key={issue.id}
                        issue={issue}
                        seq={seq}
                        busy={busy}
                        run={run}
                        showTodoDestination={showTodoDestination}
                      />
                    ))
                  ) : (
                    <Stack
                      list={list}
                      seq={seq}
                      busy={busy}
                      run={run}
                      showTodoDestination={showTodoDestination}
                    />
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 这一栏空着的时候。
 *
 * **空是常态，不是缺数据**：没有会刚开完、或者刚开完的那几场都认过了，这一栏就该是空的。
 * 原来它是左上角一行 12px 的灰字（「没有等着确认的。」），于是这一栏空着时读起来像
 * 「这块地方坏了 / 还没做完」—— 一整栏的空白配一句缩在角落里的小字，是加载失败的样子。
 *
 * 两件事分开摆：
 *
 *   **那句话**居中偏上（`top-1/4`）。这一栏没有内容时视线落点在上四分之一附近，不在
 *   正中 —— 正中是给「这里本该有一大块东西」用的，而这里本来就不该有东西。
 *
 *   **那枚标记**压在右下角，一小半探到栏外，颜色压成一档几乎看不见的灰。它不是插图，
 *   是一块**署名**：这一栏空着的时候屏幕上没有任何东西说明这块地方归谁，而它旁边两栏
 *   都是满的。压这么淡是有意的 —— 它一旦够显眼，就变成了「这里有个东西要你看」，
 *   而这一栏此刻恰恰没有东西要他看。
 *
 * ## 那枚标记为什么曾经很难看
 *
 * 它是**真的那枚标志**，不是拿几何图形拼出来的近似：`TianshuMark` 的六条光路、三档线宽、
 * 双层枢纽核，逐笔照 `public/brand/tkos-tianshu-hub-spike-mark-v6.svg`（比对过：六条
 * `d` 一字不差，`stroke-width` 10/10/9/9/8/8 与两个圆 r58/r37 全都对得上）。
 *
 * 难看的是**上色的方式**，不是几何：第一版把品牌那两个变量覆盖成了一个**半透明**的灰。
 * 而这枚标志的每条光路都是 `fill` 加一道同色 `stroke` 画的 —— 半透明之下，描边压在填充
 * 上的那一圈会叠成两倍不透明度（0.07 叠 0.07 ≈ 0.135），于是每条光路都镶了一道深边；
 * 中心那两个同心圆同理，内核叠出一个环。放到 20rem 那么大，就是一团带毛边的东西。
 *
 * 所以颜色给**实色**，透明度加在整个 `<svg>` 上（`opacity`）—— 组同一次合成，描边和填充
 * 不再互相叠加。这样出来的才是一枚真正的纯灰版：一档灰、边是干净的、在什么底色上都对。
 *
 * 组件本身一个字不改：SVG 里读的就是那两个变量，在外面覆盖它们是它本来就留好的口子。
 */
function EmptyColumn() {
  return (
    /* `overflow-hidden`：标记探到栏外的那一小半要被裁掉，不能变成一条横向滚动条。 */
    <div className="relative h-full overflow-hidden">
      <p className="meta absolute top-1/4 left-1/2 -translate-x-1/2 text-ink-faint">
        暂无待确认项
      </p>
      {/* 20rem，右下各探出 4rem —— 两个方向各遮掉两成。 */}
      <TianshuMark
        className={cn(
          "pointer-events-none absolute -right-16 -bottom-16 size-80 opacity-[0.07]",
          "[--brand-bright:var(--ink)] [--brand-deep:var(--ink)]",
        )}
      />
    </div>
  );
}

/**
 * 摞着的那一叠。最上面那张是活的，后面几张只露一条边。
 *
 * 露边的做法是往下探几像素、横向收一点点 —— **不整体缩放**：整体缩放会把后面那张的高度
 * 也缩掉，于是几张卡的下沿间距不等，看起来像没对齐。只收横向，下沿的节奏就是常数。
 *
 * 最多露两条。第三条之后再露只是把这一格加高，而「后面还有」这句话两条就说完了。
 */
function Stack({
  list,
  seq,
  busy,
  run,
  showTodoDestination,
}: {
  list: IssueSummary[];
  seq: number;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  showTodoDestination?: boolean;
}) {
  return (
    <div className="relative">
      {list.slice(1, 3).map((i, n) => (
        <div
          key={i.id}
          aria-hidden
          className="deck-card deck-under absolute inset-x-0 top-0 h-full rounded-xl"
          style={
            {
              ...meetStyle(seq),
              /* 往下一层深一档。两层就到底 —— 「后面还有」这句话两条边就说完了。 */
              "--deck-mix": `${82 - n * 18}%`,
              transform: `translateY(${(n + 1) * 7}px) scaleX(${1 - (n + 1) * 0.024})`,
            } as CSSProperties
          }
        />
      ))}
      <div className="relative">
        <Card
          issue={list[0]}
          seq={seq}
          busy={busy}
          run={run}
          showTodoDestination={showTodoDestination}
        />
      </div>
    </div>
  );
}

function Card({
  issue,
  seq,
  busy,
  run,
  showTodoDestination,
}: {
  issue: IssueSummary;
  seq: number;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  showTodoDestination?: boolean;
}) {
  const d = issue.debrief;
  if (!d) return null;
  return (
    <DebriefCard
      debrief={d}
      issue={{ id: issue.id, title: issue.title }}
      tone={seq}
      busy={busy}
      href={`/issues/${issue.id}`}
      onConfirm={() => void run(() => api.confirmDebrief(d.slotId, d.issueId))}
      onReopen={() => void run(() => api.reopenDebrief(d.slotId, d.issueId))}
      onTogglePoint={(pointId) =>
        void run(() => api.toggleDebriefPoint(d.slotId, d.issueId, pointId))
      }
      onEditPoint={(pointId, text) => void run(() => saveDebriefPointText(d, pointId, text))}
      onAssign={(pointId, driId) =>
        void run(() => api.assignDebriefPoint(d.slotId, d.issueId, pointId, driId))
      }
      onSave={(patch) => void run(() => api.updateDebrief(d.slotId, d.issueId, patch))}
      detailHref={`/meetings/${d.slotId}/${d.issueId}`}
      showTodoDestination={showTodoDestination}
      className={cn(busy && "pointer-events-none")}
    />
  );
}
