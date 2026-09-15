"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ResearchStepLine } from "@/components/research-step-line";
import { api, cardSourceLabel } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import type { Card, DomainSummary } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 潜在议题卡片。
 *
 * ## 卡上没有按钮，整张卡就是一个入口
 *
 * 上一版卡上挂着三颗处置键（自动深研 / 深研并指派 / 待定）。删掉了，理由是**这一屏
 * 不是处置台，是清单**：一号位扫这一屏是在决定「哪几条值得我点进去」，不是在决定
 * 「这条怎么办」。把处置键摆在这里，等于要求他在还没读预研、还没问过一句话的情况下
 * 就拍板 —— 而那正是 Sensor 出卡门槛想避免的：**未经思考的快速处置。**
 *
 * 处置动作全部移到详情页，而且在那里它们是有依据的：他已经读过参谋的判断、
 * 看过支持信息、可以随时展开预研原文，也可以先问几句再决定。
 *
 * ## 卡上没有溯源徽章
 *
 * 也删掉了。这一屏要的是**内容**：出了什么事、对我们什么影响、所以要问什么。
 * 溯源是核对用的，而核对发生在详情页 —— 在清单上摆一排徽章，只会把那三拍
 * 切成六段。出处照样存着（`Card.refs`），详情页里看。
 *
 * ## 四拍，问句在最上面
 *
 *   meta      坐标与影响面      他先滤掉不相干的那两块
 *   大字·粗   所以要问什么      ← 整张卡最响的一行
 *   小字·灰   发生了什么        具体、可核、带日期
 *   中字·墨   会对我们造成什么   影响
 *
 * 问句原来压在卡的最底下，读法是「先看三段材料，再看结论」。换到最上面，是因为这一屏
 * 他要做的判断只有一个：**这条值不值得我点进去**。那个判断由问句决定，不由材料决定 ——
 * 材料是他决定要看之后才读的东西。一屏四张卡，他现在扫四行大字就能选，而不是读完
 * 十二段小字。
 *
 * 没有小标题。这四段本来是一句连贯的话，加上标签之后眼睛每读一段要先读标签再切回
 * 正文，一张卡切四次；而这一屏他只花五分钟。区分靠字号、颜色和留白。
 */

/**
 * demo 那一层三块生意的名字。
 *
 * 词元云集自己的八个域不在这里 —— 名字向数据层要（`listDomains`，和首页左下那份是
 * 同一份，key 也是同一个，所以一屏几张卡只问一次）。原来这张表是唯一的来源，于是
 * 那八个域落在这一行上全是「D-01」这种编号；编号不是一号位脑子里的名字。
 *
 * BIZ-* 留在这里兜底：`listDomains` 只返回词元云集的八个域，演示那一场的卡片挂的是
 * BIZ-*，要不到名字就会退回 id。
 */
const DEMO_DOMAIN_LABEL: Record<string, string> = {
  "BIZ-AIDC": "AIDC",
  "BIZ-TK": "词元云集",
  "BIZ-FDD": "房懂懂",
};

export function CardFourPart({ card }: { card: Card }) {
  const caughtToday = card.createdAt.startsWith(api.today);
  const domains = useResource<DomainSummary[]>("domains", () => api.listDomains());
  const domainLabel = (id: string) =>
    domains.data?.find((d) => d.id === id)?.name ?? DEMO_DOMAIN_LABEL[id] ?? id;

  // 还没接出判断的那几条（本体里确实不动摇任何在版判断）不写「动摇 」半句话。
  const shakes = (card.hypothesisRef ?? card.strategyRef).id;

  /*
   * 「发生了什么」这一段现在可能是一整篇文章 —— 一号位往「我自己有一件事」里贴了一篇
   * 他刚读到的东西，或者一个链接（正文抓回来落在同一个字段上）。所以这一段封了高度。
   *
   * 高度到顶之后底下那一截淡出去（`.text-fade` + `.glass-hem`），但**只在真的被截住时**
   * 才淡：量出来没截住还照样画一道渐变，那是把一段完整的话渲染成「后面还有」，而它
   * 后面什么都没有。所以量一次 —— 只有量得到才知道，字号、卡宽、语言都会改变答案。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 8);
    measure();
    // 卡宽会变（窗口缩放、侧栏开合），换行数跟着变，截没截住也跟着变。
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card.what]);

  /**
   * 预研还在跑 —— **这张卡此刻点不进去。**
   *
   * 两个理由，第二个更硬：
   *
   *   一，进去也没什么可读的：那一页的主体就是预研的产出，而它还没有。
   *   二，**进一件议题的页面会自动起一轮判断**（A5）。预研没跑完就进去，那一轮读到的
   *       是一份半成品 —— 花了一次真实的模型调用，换回一个基于残缺材料的判断，而屏幕上
   *       看不出它是在残缺材料上做的。
   *
   * 判据和下面那一格进度写的是同一件事：有一轮在跑（`preResearchStartedAt` 或
   * `preResearchStep`），而且既没跑完也没失败。跑完了、或者跑挂了，都照旧点得进去 ——
   * 后者尤其要能进：他得进去看为什么挂了。
   */
  const researching =
    !card.preResearchAt &&
    !card.preResearchFailed &&
    Boolean(card.preResearchStartedAt || card.preResearchStep);

  /*
   * 这一屏是一条一张、独立成块，所以它仍然是卡片 —— 但边由 `.card` 那道**半个物理
   * 像素**的发丝线环承担，不是 `border: 1px`（1px 在 2x 屏上是两个物理像素，比原生
   * 粗一倍）。hover 也不再加重描边：一块 3.5% 的墨色淡底，和清单里的行同一套语言。
   *
   * 点不进去的时候换成 `<div>`，**不是加一个 `pointer-events-none` 的 `<Link>`**：
   * 后者在读屏和键盘上仍然是一个链接，Tab 能走到它、念出来是「链接」，按下去什么都
   * 不发生 —— 那比不能点更糟。没有 hover 的淡底也是同一条：那块底说的是「这个能点」。
   */
  const shell = cn(
    "card group flex h-full flex-col overflow-hidden px-5 pt-4 pb-4 transition-colors duration-base",
    researching
      ? "cursor-default"
      : "hover:bg-[color-mix(in_oklab,var(--ink)_3.5%,var(--surface))]",
  );
  const body = (
    <>
      {/*
       * 时间坐标 + 谁递上来的 + 它动摇哪条判断 + 影响哪几块生意。
       *
       * 四种来源的可信度来源完全不同（见 `cardSourceLabel`），所以徽章上写的是那
       * 一种的名字，不是「来源」两个字 —— 他必须能一眼分开「外面变了」「有人押上
       * 名字告诉我」和「我自己刚才想到的」。
       */}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="meta text-ink-faint">{card.issueId}</span>
        <span className="meta rounded-[3px] bg-neutral-wash px-1.5 py-[1px] text-ink-muted">
          {cardSourceLabel(card.source)}
        </span>
        <span className="meta text-ink-faint">· {formatStamp(card.createdAt)}</span>
        {shakes ? <span className="meta text-ink-faint">· 动摇 {shakes}</span> : null}
        {/*
         * 碰到哪几个业务域。他扫这一屏的第一个动作是**把不相干的那几个滤掉**；没有这个
         * 标注，每条都得读完正文才知道跟他现在关心的那块有没有关系。
         * 跨域的那几条同时挂两三个 —— 跨域本身就是它值得被端上来的理由之一。
         */}
        {card.domainIds.map((d) => (
          <span
            key={d}
            className="meta rounded-[3px] bg-factual/12 px-1.5 py-[1px] font-medium text-factual"
          >
            {domainLabel(d)}
          </span>
        ))}
        {caughtToday && (
          <span className="meta rounded-[3px] bg-judgment px-1.5 py-[1px] font-medium text-solid-fg">
            今日新
          </span>
        )}
        {/*
         * 预研这一格说的是「点进去有什么」。四种答案是四句不同的话：
         *
         * 报告在、参谋判它不成立或者说法要先改 —— 那句结论就是这张卡此刻最要紧的
         * 事实，写成「预研已完成 · 进去追问」等于把它藏到详情页去。措辞跟详情页那条
         * 结论带（`signal-view.tsx` 的 `StatusStrip`）是同一套词，两页不各说一遍。
         *
         * 报告不在而那一轮挂了 —— 照实说没跑成。**失败不许伪装成等待**：写「进行中」
         * 他会一直等一个不会来的东西。
         *
         * 还在跑的那一档不再是「预研进行中…」三个字。三个字答不出他此刻真正在问的
         * 那句话 —— **它是在干活，还是卡住了**。写出「正在装配上下文 · 第 1/2 步 ·
         * 已 34 秒」之后，这一格从一句安抚变成一个可核对的事实：下次刷新它该往前走。
         *
         * 第四种：三样都没有 —— 没报告、没失败、也没有一轮在跑（demo 那一档不叫模型）。
         * 这一格照实说「没有预研」。**它绝不能借用「进行中」那一档**：一格呼吸的字
         * 代表一件没有任何人在做的事，他会一直等它。
         */}
        {card.preResearchAt || card.preResearchFailed ? (
          <span className="meta ml-auto text-ink-faint transition-colors duration-fast group-hover:text-ink-muted">
            {card.preResearchAt
              ? card.preResearchStatus === "invalid"
                ? "参谋判这条不值得继续投入 →"
                : card.preResearchStatus === "reframing_needed"
                  ? "参谋认为说法要先改 →"
                  : "预研已完成 · 进去追问 →"
              : "预研没跑成 · 进去看 →"}
          </span>
        ) : card.preResearchStartedAt || card.preResearchStep ? (
          <ResearchStepLine
            className="meta ml-auto"
            step={card.preResearchStep}
            startedAt={card.preResearchStartedAt}
            fallback="预研进行中"
          />
        ) : (
          <span className="meta ml-auto text-ink-faint transition-colors duration-fast group-hover:text-ink-muted">
            没有预研 · 进去看 →
          </span>
        )}
      </p>

      {/* 所以要问什么。整张卡最响的一行，而且是他第一眼落到的地方。 */}
      <p className="report mt-2.5 text-xl leading-relaxed font-medium tracking-[-0.01em] text-ink underline decoration-transparent underline-offset-[6px] transition-colors duration-fast ease-swift group-hover:decoration-hairline-strong">
        {card.headline}
      </p>

      {/*
       * 发生了什么。小字、灰：它最硬，但需要被扫，不需要被读。
       *
       * **一条都没有时整段不出现**，连那道分隔线也不画。有两种卡本来就没有这一段：他自己
       * 打的那一句话（那句已经在上面当标题了，同一句话在一张卡上出现两遍看着像坏了），和
       * 接不出正文的那几条信号。原来这里无条件渲染，于是屏幕上是一个空的带边框的方块 ——
       * 一道分隔线下面什么都没有，比不画那道线更像故障。
       */}
      {card.what.length > 0 && (
        <div className="relative mt-3.5 border-t border-hairline pt-3.5">
          <div
            ref={bodyRef}
            className={cn(
              // 六行到顶。这一屏是清单，一张卡吃掉半屏就没有清单了 —— 全文在详情页。
              "max-h-[8.5rem] space-y-1.5 overflow-hidden",
              clipped && "text-fade",
            )}
          >
            {card.what.map((w, i) => (
              <p key={i} className="text-sm leading-relaxed whitespace-pre-line text-ink-muted">
                {w.text}
              </p>
            ))}
          </div>
          {clipped && <span aria-hidden className="glass-hem" />}
        </div>
      )}

      {/*
       * 会对我们造成什么。中字、墨色。从上一段到这一段是从「外面的事实」跨到
       * 「我们的事」，字色加深就是这一跨；不需要写「影响」两个字。
       */}
      <p className="report mt-4 text-md leading-relaxed text-ink-muted">{card.why}</p>
    </>
  );

  /*
   * 两个壳写成两支，而不是把 `Link` 的 `href` 做成可空：Next 的 `LinkProps.href` 不接受
   * `undefined`，硬塞得靠 `as` 把类型闸打开 —— 而那道闸正是防「渲染出一个没有目的地的
   * 链接」的。
   */
  return researching ? (
    <div className={shell}>{body}</div>
  ) : (
    <Link href={`/signals/${card.issueId}`} className={shell}>
      {body}
    </Link>
  );
}
