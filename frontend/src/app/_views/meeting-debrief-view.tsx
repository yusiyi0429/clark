"use client";

import Link from "next/link";
import { useState } from "react";

import { AsyncBoundary } from "@/components/async-boundary";
import { DebriefPoints, saveDebriefPointText } from "@/components/agenda/debrief-card";
import { meetStyle } from "@/components/agenda/tone";
import { Panel, PanelEmpty, PanelHead, PanelSection } from "@/components/panel";
import { bySlotTime, domainsOfSlot, slotLabel } from "@/lib/data/agenda";
import { api, ApiError } from "@/lib/data/client";
import type {
  DomainSummary,
  IssueSummary,
  MeetingDebrief,
  MeetingSlot,
} from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * 一件议题在一场会上的那一份，详细内容（`/meetings/[slotId]/[issueId]`）。
 *
 * ## 为什么是单独一页，不是卡内展开
 *
 * 首页那张卡是**处置面**：一句概述、几条要点、三颗键，它存在的全部理由是扫一眼就能决定
 * 认不认。要核对的东西（这一场交上来的全文、每条要点的边界、还没定的事、到场的是谁）
 * 全都是长的 —— 塞进卡内展开，那一栏就从「今天有几件要拍板」变成一摞打开的文档，而摞卡
 * 那个做法（一场只占一张卡的高度）也就白做了。
 *
 * 所以它有自己的地址：他起了疑才来，来了就是读，读完退回去按那颗键。
 *
 * ## 四节的顺序就是他核对的顺序
 *
 *   会议原文     这场会到底说了什么 —— 一切的底。
 *   摘要总结     模型从那份原文里提出来的一句话、还没定的事、谈拢了没有。
 *   checklist    会上定下来的那几条，逐条勾 / 逐条改。
 *   参会的 DRI   刚才那场会是谁在场。
 *
 * **要点只画一遍**：它是 checklist 那一节的内容，摘要那一节里不再重复列一次。同一份五条
 * 要点在一页上出现两遍，他会去比对两处有没有出入 —— 而那两处本来就是同一份东西。
 */
export function MeetingDebriefView({
  slotId,
  issueId,
  readOnly = false,
}: {
  slotId: string;
  issueId: string;
  /**
   * 这一页在这个座位下面改不改得动。**由挂它的路由传，不在这里读 cookie 判。**
   *
   * 「一号位这一侧只读」是相二定的：排会和审纪要相一就搬去了秘书那一侧，一号位保留的
   * 是看得到会议细节，不是替秘书按键（详见 `docs/superpowers/specs/2026-09-02-两个
   * 空间与动态面板-design.md` 的「只读」那一段）。哪一路由挂这个组件在构建时就定了，
   * 不是运行时才知道的一件事——同一个组件将来给秘书那一侧的等价页面用时传 `false`
   * 就是了，不需要在组件内部猜「现在是谁在看」。
   */
  readOnly?: boolean;
}) {
  const res = useResource(`meeting-debrief:${slotId}:${issueId}`, async () => {
    /*
     * 按 (slotId, issueId) 取那一份，**不走 `listDebriefs`**。
     *
     * 那一条答的是「还压在他那儿的有哪几份」（两个出口都空才进得去），而这一页问的是
     * 另一件事：这件议题在那一场会上被提炼成了什么 —— 他确认完之后仍然要答得出来。
     * 拿 `listDebriefs` 去答，已确认和已退回的那几份会落到一个空页上。
     */
    const [debrief, slots, issues, domains] = await Promise.all([
      api.getDebrief(slotId, issueId),
      api.listSlots(),
      api.listIssues(),
      api.listDomains(),
    ]);
    return { debrief, slots, issues, domains };
  });

  return (
    <Panel>
      <AsyncBoundary resource={res} skeleton={<DetailSkeleton />}>
        {(data) => {
          const debrief = data.debrief;
          if (!debrief) {
            return (
              <>
                <PanelHead eyebrow={slotId} title={issueId} />
                {/*
                 * 读的是 `getDebrief`，它不看两个出口 —— 所以查不到就是**真的没有这一份**：
                 * 这场会上没有这件议题、或者那一轮提炼压根没跑出东西来。不再需要那句
                 * 「要么已确认要么已退回」的两可说法（上一版读 `listDebriefs` 时才分不出）。
                 */}
                <PanelEmpty
                  title="这一场会上没有这件议题的提炼。"
                  note="要么这件议题不在那场会上，要么那一轮没提炼出东西来。"
                >
                  <Link
                    href={`/issues/${issueId}`}
                    className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
                  >
                    去看这件议题
                  </Link>
                </PanelEmpty>
              </>
            );
          }

          return (
            <DebriefDetail
              debrief={debrief}
              slot={data.slots.find((s) => s.id === slotId)}
              seq={seqOfSlot(data.slots, slotId)}
              issues={data.issues}
              domains={data.domains}
              onRefresh={() => res.mutate()}
              readOnly={readOnly}
            />
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 这场会的颜色档。
 *
 * 和议题栏、日程板、会后那一栏同一个口径：**按时间序数第几场**（`toneOf` 那边写着为什么
 * 不用哈希）。这一页因此和他刚才点过来的那张卡是同一块颜色 —— 换了个地址不用重新认
 * 「这是哪一场」。
 */
const seqOfSlot = (slots: MeetingSlot[], slotId: string): number => {
  const i = [...slots].sort(bySlotTime).findIndex((s) => s.id === slotId);
  return i < 0 ? 0 : i;
};

/**
 * 这一场交上来那份材料的全文。**空白当没有** —— 一块空的阅读区和「还没交过材料」
 * 在屏幕上长得一样，而它们要他做的事不同。
 */
const transcriptOf = (slot?: MeetingSlot): string | undefined => {
  const raw = slot?.transcript;
  return raw && raw.trim() ? raw : undefined;
};

function DebriefDetail({
  debrief,
  slot,
  seq,
  issues,
  domains,
  onRefresh,
  readOnly,
}: {
  debrief: MeetingDebrief;
  slot?: MeetingSlot;
  seq: number;
  issues: IssueSummary[];
  domains: DomainSummary[];
  onRefresh: () => Promise<unknown>;
  /** 透传给「要做的事」那一节的 `DebriefPoints`——说明整段写在 `MeetingDebriefView` 上。 */
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /* 和会后那一栏同一份写法：一次写在飞的时候键按不动，失败就在原地说一句。 */
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

  const issue = issues.find((i) => i.id === debrief.issueId);
  const transcript = transcriptOf(slot);

  return (
    <>
      <PanelHead
        eyebrow={
          <>
            {debrief.issueId}
            {" · "}
            {slot ? slotLabel(slot, api.today) : "已开完的会"}
            {" · "}
            {debrief.consensus.reached ? "共识" : "分歧"}
          </>
        }
        title={issue?.title ?? debrief.issueId}
        sub={debrief.consensus.reason}
        actions={
          <Link
            href={`/issues/${debrief.issueId}`}
            className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
          >
            议题
          </Link>
        }
      />

      {failure ? (
        <p role="alert" className="meta mb-4 text-counter">
          {failure}
        </p>
      ) : null}

      <PanelSection title="会议原文">
        {transcript ? (
          /*
           * 全文自己占一块、自己滚（`max-h-[70vh]`），**不摊平**。
           *
           * 摊平的那一版试过：一场两小时的会转写出来是几千字，底下三节要滚很久才见得到 ——
           * 而他点进来多半正是为了拿原文去核对下面那几条要点，两处离得越远越难核。70vh
           * 已经是一屏的绝大部分，读起来和整页滚没有区别，代价只是这一块的滚动条自己管。
           *
           * 断行按**每一个换行**切，不按空行：转写出来是一句一行的说话轮次，按空行切会把
           * 整场会并成一大坨。
           */
          <div className="scroll-slim max-h-[70vh] overflow-y-auto rounded-lg border border-hairline bg-paper px-4 py-3.5">
            <article className="report space-y-2.5 text-md text-ink">
              {transcript
                .split(/\n+/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
            </article>
          </div>
        ) : (
          /*
           * 没有全文就照实说没有，**不写一句「暂无内容」了事**：他要知道的是「这一份摘要
           * 底下压着的原文我看不看得到」，而那两种原因（材料还没交 / 交了但这一版还读不出来）
           * 对他是两回事。
           */
          <PanelEmpty
            title={slot?.transcribedAt ? "这一场的全文这一版读不出来。" : "这一场还没交过材料。"}
            note={
              slot?.transcribedAt
                ? `提炼是 ${slot.audioName ?? "交上来那份材料"} 出的，但全文还没落到会议表上 —— 这一页只能等它。`
                : "底下那几条是从这场会的提炼里来的，原文不在库里。"
            }
          />
        )}
      </PanelSection>

      {/*
       * 摘要那一节只有三样：一句概述、还没定的事、谈拢了没有。
       *
       * **要点不在这里**，它是下一节那份 checklist（理由写在文件头上）。
       */}
      <PanelSection title="此议题的会议摘要总结">
        <p className="report text-md leading-relaxed text-ink">{debrief.summary}</p>

        {debrief.open.length > 0 && (
          <div className="mt-5">
            <h3 className="meta text-ink-faint">未决</h3>
            <ul className="mt-1.5 space-y-1.5">
              {debrief.open.map((q, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-ink">
                  <span aria-hidden className="shrink-0 text-ink-faint">
                    ?
                  </span>
                  <span className="min-w-0">{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {debrief.todos.length > 0 && (
          <div className="mt-5">
            <h3 className="meta text-ink-faint">下一步</h3>
            <ul className="mt-1.5 space-y-1.5">
              {debrief.todos.map((t) => (
                <li
                  key={t.id}
                  className="flex items-baseline gap-2.5 text-sm leading-relaxed text-ink"
                >
                  <span aria-hidden className="shrink-0 text-ink-faint">
                    →
                  </span>
                  <span className="min-w-0 flex-1">{t.text}</span>
                  {/* 人和期限**只在会上真说了才有**。这里绝不写「未指定」：那四个字会长得
                      像一个叫「未指定」的人。 */}
                  {t.owner || t.due ? (
                    <span className="meta shrink-0 whitespace-nowrap text-ink-faint">
                      {[t.owner, t.due].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </PanelSection>

      {/*
       * checklist 那一节坐在**会色的面**上，和首页那张卡是同一块颜色（`meetStyle(seq)`）。
       *
       * 两个理由：一是那几颗键的颜色全部从 `--meet-fg` / `--meet-deep` 上取（见
       * `.meet-btn-*`），离开这块面它们在纸上是看不见的浅色；二是这一节和卡上那一份是
       * 同一个东西，同一块颜色让他不必怀疑「我在这儿勾的，卡上会不会不算」。
       *
       * `.card` 只贡献几何（圆角、内边距、`--r`/`--p`），面由后写的 `.meet-face` 盖掉 ——
       * 和 `DebriefCard` 那一处同一句。
       */}
      {/*
       * 标题从「checklist」改成「要做的事」：这一段装的已经不是会上定下来的结论，是会上
       * 达成共识、接下来要部署下去的那几件（见 `a7/debrief.ts` 文件头）。名字不跟着改的话，
       * 屏幕上还在说它是一份核对清单，而他在上面做的是派活。
       */}
      <PanelSection title="要做的事" count={debrief.points.length || undefined}>
        {debrief.points.length === 0 ? (
          <PanelEmpty
            title="这场会在这件议题上没有定下要做的事。"
            note="那是一个诚实的结果，不是缺失 —— 上面那句概述和「未决」说的就是这一场走到了哪儿。"
          />
        ) : (
          <div style={meetStyle(seq)} className="card meet-face meet-lit dither px-3.5 py-3">
            <div className="relative">
              {/* 边界在这一页上一直摊开：这里是核对面，而边界正是「这一条管到哪儿为止」——
                  他点进来要读的就是它。卡面上收着的理由写在 `DebriefCard` 上。 */}
              <DebriefPoints
                points={debrief.points}
                showBoundary
                busy={busy}
                /*
                 * 只读时这一页在一号位那一侧不渲染改数据的入口（`readOnly` 整段理由写在
                 * `MeetingDebriefView` 上）。下面这几个回调仍然照常传——只读之后它们没有
                 * 入口可以触发，留着比在这里另分一条只读时不传的路径更简单：`DebriefPoints`
                 * 自己按 `readOnly` 决定要不要画那几颗键，这一层不需要重复判一遍。
                 */
                readOnly={readOnly}
                onToggle={(pointId) =>
                  void run(() =>
                    api.toggleDebriefPoint(debrief.slotId, debrief.issueId, pointId),
                  )
                }
                onEditText={(pointId, text) =>
                  void run(() => saveDebriefPointText(debrief, pointId, text))
                }
                /*
                 * 已经确认过的那一份不给派人：确认那一下是这份提炼的封口，之后它是一条
                 * 历史记录（数据层也挡，见 `assignDebriefPoint`）。这一页和首页那张卡
                 * 不同 —— 它连已确认、已退回的那几份也打得开。
                 */
                onAssign={
                  debrief.confirmedAt
                    ? undefined
                    : (pointId, driId) =>
                        void run(() =>
                          api.assignDebriefPoint(
                            debrief.slotId,
                            debrief.issueId,
                            pointId,
                            driId,
                          ),
                        )
                }
              />
            </div>
          </div>
        )}
      </PanelSection>

      <PanelSection title="参会的 DRI">
        <Attending slot={slot} issues={issues} domains={domains} />
      </PanelSection>
    </>
  );
}

/**
 * 刚才那场会是谁在场。
 *
 * 参会的域**是算出来的**：会上那几件议题各自属于哪个域，并集就是参会域（`domainsOfSlot`，
 * 口径整段写在那边），域上挂着 DRI 的名字。所以这一页不另存一份名单，也就不会出现「这里
 * 写着 FE 到场、会上却没有 FE 的议题」这种在屏幕上看不出来的不一致。
 *
 * **算不出来就说算不出来。** 两种算不出来的情况各有各的说法，而两种都绝不编一个人名 ——
 * 在这条链路上编一个负责人是最坏的错：他会照着那个名字去问一件那个人根本不知道的事。
 */
function Attending({
  slot,
  issues,
  domains,
}: {
  slot?: MeetingSlot;
  issues: IssueSummary[];
  domains: DomainSummary[];
}) {
  if (!slot) {
    return (
      <PanelEmpty
        title="这一场在会议表里查不到，到场的是哪几个域算不出来。"
        note="多半是这场会后来被撤了（提炼还留着，它记得自己出自哪一场）。这里不猜一份名单。"
      />
    );
  }

  const domainOfIssue = (issueId: string) => issues.find((i) => i.id === issueId)?.domainId;
  const attending = domainsOfSlot(slot, domainOfIssue).flatMap((id) => {
    const d = domains.find((x) => x.id === id);
    return d ? [d] : [];
  });

  if (attending.length === 0) {
    return (
      <PanelEmpty
        title="这场会上没有一件议题派了 DRI，所以算不出有哪个域到场。"
        note="参会的域是从议题的域算出来的；议题还没派人，这一栏就是空的。"
      />
    );
  }

  return (
    <ul className="border-t border-hairline">
      {attending.map((d) => (
        <li key={d.id} className="flex items-baseline gap-3 border-b border-hairline py-2.5">
          <span className="meta w-10 flex-none text-ink-faint">{d.code}</span>
          <span className="min-w-0 flex-1 text-sm text-ink">{d.name}</span>
          <span className="text-sm text-ink">{d.driName}</span>
        </li>
      ))}
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-3 block h-4 w-[68%]" />
      <span className="skeleton mt-2.5 block h-2.5 w-56" />
      <span className="skeleton mt-7 block h-52 w-full rounded-lg" />
      <div className="mt-7 space-y-2">
        {[100, 94, 88].map((w, i) => (
          <span key={i} className="skeleton block h-3.5" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
