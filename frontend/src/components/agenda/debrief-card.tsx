"use client";

import Link from "next/link";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { useState, type CSSProperties, type ReactElement } from "react";

import { api } from "@/lib/data/client";
import type { DebriefPoint, DebriefTodo, MeetingDebrief } from "@/lib/data/types";
import { cn } from "@/lib/utils";
import { AssignMenu } from "./assign-menu";

/**
 * 这一场会的颜色。
 *
 * 抄的是 `slot-chip` 里那一句，**但这里自己留一份**：那一句取的是「这一场在所有会里排
 * 第几」（`toneOf`），而这张卡拿到的是外面已经算好的一个档位。同一个式子服务两个来源，
 * 改其中一边就得在另一边加一个开关 —— 一句四个字符的表达式不值得为它引一条依赖。
 */
const meetVar = (tone: number): CSSProperties =>
  ({ "--meet": `var(--meet-${["a", "b", "c", "d"][((tone % 4) + 4) % 4]})` }) as CSSProperties;

/** 卡面上摊开的、和折起来收着的，是同一份东西的两截。这里是它在编辑态里的形状。 */
type DebriefDraft = {
  summary: string;
  points: { text: string; boundary?: string }[];
  todos: { text: string; owner?: string; due?: string }[];
  open: string[];
};

/**
 * 一场战略会散了之后，落在**某一件议题**上的那份提炼，连着它的三个动作。
 *
 * ## 卡面上为什么只有概述和要点
 *
 * 真实复盘的骨架是四段：一句核心观点 → 一张要点/判断/边界的表 → 未决与风险 → 下一步
 * 任务。四段全摊在卡面上是一屏读三分钟的东西，而他此刻要做的判断只有一个：**这场会谈
 * 出来的，认不认。** 那个判断靠前两段的前半截就够 —— 一句概述说清位移，几条要点说清定
 * 了什么。剩下的（每条要点的边界、还没定的事、完整待办）是他起了疑才要的东西，起疑之前
 * 它们只是在稀释那一句概述。
 *
 * 所以边界不在卡面上。**边界和要点长得一样长**，摊出来之后一条要点变成两行，五条要点就
 * 是十行 —— 而那十行里有五行说的是「这一条没说什么」。那是核对的材料，不是决定的材料。
 *
 * ## 为什么两颗键永远都在
 *
 * `consensus.reached` 是 A7 读完转写判出来的一个事实（这次谈拢了没有），它**只决定谁默
 * 认显眼**：谈拢了，`无需再议` 是实心的；没谈拢，`还需再议` 是实心的。两颗永远都在，
 * 而且都按得动。
 *
 * 做成「没达成共识就不给那一颗」的那一版是错的：那是让一个模型的判断替他关掉一条路。他手
 * 上有屏幕上没有的东西（会后那通电话、他自己心里的时间表），完全可能在 A7 说「没谈拢」
 * 的时候按下「无需再议」。反过来也一样。系统能做的是把判断摆出来、把默认设对，省掉他为了
 * 选一颗键而重读整份复盘；不是替他按。
 */
export function DebriefCard({
  debrief,
  issue,
  slotLabel,
  tone,
  busy,
  onConfirm,
  onReopen,
  onTogglePoint,
  onEditPoint,
  onAssign,
  onSave,
  href,
  detailHref,
  showTodoDestination,
  className,
}: {
  debrief: MeetingDebrief;
  /** 这一份是哪件议题的。 */
  issue: { id: string; title: string };
  /**
   * 这场会什么时候开的，人话（`昨天下午`）。**可以不给** —— 会后那一栏是按会分组的，
   * 时间已经写在每一组的抬头上，卡上再写一遍就是同一行小字在相邻两行里出现两次。
   */
  slotLabel?: string;
  /** 这场会的颜色档，0..3。 */
  tone: number;
  /** 有写操作在飞。飞着的时候按钮要按不动。 */
  busy?: boolean;
  /** 无需再议 —— 认了，这件议题就此进入已部署。 */
  onConfirm: () => void;
  /** 还需再议 —— 退回研究中，等着排下一场会。 */
  onReopen: () => void;
  /**
   * 勾掉 / 取消勾掉一条要点。
   *
   * **勾不是确认，也不是确认的前置**（理由整段写在 `DebriefPoint.checked` 上）——
   * 所以它和 `onConfirm` 是两件互不相干的事，不要在这里替他把两者串起来。
   */
  onTogglePoint: (pointId: string) => void;
  /**
   * 就地改一条要点的字 —— 他认为这一条总结得有出入。
   *
   * 和 `onSave` 是两件事，不是它的简写：`onSave` 是他把整份重写一遍（概述、要点、待办、
   * 未决一起），这一颗只动某一条的一句话，别的一个字不碰。落到数据层怎么走、以及它会
   * 顺手动到什么，写在 `saveDebriefPointText` 上。
   */
  onEditPoint: (pointId: string, text: string) => void;
  /**
   * 把一条任务派给某个 DRI（`null` = 撤掉）。**不给就没有那颗下拉**（详见 `DebriefPoints`）。
   */
  onAssign?: (pointId: string, driId: string | null) => void;
  /** 就地改完之后保存。 */
  onSave: (patch: DebriefDraft) => void;
  /** 点进去看这件议题的完整记录。 */
  href: string;
  /** 这一份在那一场会上的详细内容，单独一页（`/meetings/[slotId]/[issueId]`）。 */
  detailHref: string;
  /**
   * 每条待办后面写一句「它去了哪儿」（详见 `todoDestination`）。
   *
   * 默认 `false`，跟 `DebriefPoints.readOnly` 是同一个形状：**由座位那一侧主动打开，
   * 不给的一侧原样不动。** 现在只有秘书那一页（`/sec/debriefs` → `DebriefColumn`
   * → 这张卡）打开它；一号位那一侧的会议详情页（`/meetings/[slotId]/[issueId]`）
   * 自己渲染待办那一节，根本不经过这张卡，所以那一页一个像素都不会变。
   *
   * 为什么要一个开关、而不是索性所有地方都标：**这句标注只在「摊的是全集」的地方才
   * 说得通。** 它说的是「这一条被派到哪儿去了」，而这句话要有意义，前提是屏幕上这一叠
   * 里没有一条被过滤掉过——否则「还没人接」的那几条完全可能只是没落到这一屏上，标注
   * 反而把一个子集说成了全集。哪一处是全集是页面的性质，所以由页面来开这个开关。
   */
  showTodoDestination?: boolean;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const reached = debrief.consensus.reached;

  return (
    /*
     * 一块**会色的面**（`.meet-face` + `.meet-lit`），不是一张纸。
     *
     * 这张卡说的不是「这是一件什么事」，是「这一件在那一场会上被谈过了」—— 而屏幕上回答
     * 「哪一场」的手段只有一个：整块换成那场会的颜色。它和排会面板里那一场用的是同一个色
     * 档，所以他在两屏之间来回时不用重新找。
     *
     * `.card` 在这里只贡献几何（圆角 16、内边距 14、`--r`/`--p` 两个变量给里面的东西
     * 算同心圆角用）—— 面和环由后写的 `.meet-face` 盖掉。没有阴影、没有抬高：这一屏上
     * 唯一允许浮着的东西是顶栏那颗胶囊。
     */
    <div style={meetVar(tone)} className={cn("card meet-face meet-lit dither px-3.5 py-3", className)}>
      {/* `.meet-lit` 那道光是绝对定位的伪元素，会盖在没有定位的兄弟上面 —— 正文不给
          `relative` 的话，一整块字都是从那层光底下透出来的。 */}
      <div className="relative">
        {/*
         * 抬头一行：**这是什么、什么时候的事、谈拢了没有。**
         *
         * 三样都是身份，不是内容，所以并成一行小字，一行都不多占。左边那颗点是会色，和
         * 面上那 6% 是同一个变量 —— 面太淡的时候（浅色主题下确实淡）它是唯一一处满色。
         */}
        <div className="meta flex items-center gap-1.5 [color:var(--meet-fg-dim)]">
          <span className="tabular-nums">{issue.id}</span>
          {slotLabel ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{slotLabel}</span>
            </>
          ) : null}

          {/*
           * 共识那一枚。**一个词加一档颜色，不是一句话。**
           *
           * 写成「本场会议未就该议题达成共识」的那一版占掉整整一行，而它说的事在底下那排
           * 键上已经用「哪一颗是实心的」说过一遍了 —— 一件事在一张卡上说两遍，弱的那一遍
           * 会把强的那一遍稀释掉。
           *
           * 没谈拢用 `--judgment`（琥珀）不用 `--counter`（玫红）：玫红在这套语义色里是
           * 反证、是出事了，而「这次没谈拢」是一件很常见的、正常的事 —— 一件议题本来就常
           * 常要开几次会。琥珀说的是「这里还需要你」，那正是它的意思。
           */}
          {/*
           * **不用 `--confirmed` / `--judgment` 那两个语义色。** 它们是为纸面调的，压在这块
           * 深色渐变上一个都过不了 4.5。改成同一族字色的两档：达成是满色，没达成多一圈淡底。
           * 「哪一颗键是实心的」已经把这件事说过一遍，这一枚只是让他扫的时候不必读到底下。
           */}
          <span
            className={cn(
              "ml-auto shrink-0 rounded-[4px] px-1.5 font-medium [color:var(--meet-fg)]",
              reached || "[background:color-mix(in_oklab,white_16%,transparent)]",
            )}
          >
            {reached ? "共识" : "分歧"}
          </span>
        </div>

        <p className="mt-1.5 text-base leading-relaxed [color:var(--meet-fg)]">{issue.title}</p>

        {editing ? (
          /*
           * 改字。**一整块纯文本，不是一堆输入框。**
           *
           * 逐条给输入框的那一版试过了：五条要点加三条待办是八个框，改一个字要先点中一个
           * 框，而他此刻手上的事是「这句话不对，我重写一下」。一整块文本让他像改一段草稿
           * 那样改 —— 顺手把两条并成一条、把一条拆成两条，都不用先想「该点哪个框」。
           *
           * 格式就是它显示出来的样子，规则整段写在 `debriefToText` 上。
           */
          <textarea
            autoFocus
            rows={8}
            aria-label={`改这份会后提炼 · ${issue.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            /* 摁下去不冒泡到外面那张卡：会后那一叠上按住卡片是「甩」（翻到下一张），
               而他在这里按住是要选中一段文字。不拦这一下，选字会把卡片甩走。 */
            onPointerDown={(e) => e.stopPropagation()}
            className="report scroll-slim concentric field-sizing-content mt-2.5 max-h-72 w-full resize-none overflow-y-auto border border-current/25 bg-black/15 px-3 py-2 text-sm leading-relaxed [color:var(--meet-fg)] outline-none transition-colors duration-fast focus:border-current/50"
          />
        ) : (
          <>
            {/*
             * 概述 —— **他读的第一行。**
             *
             * 比要点重一档（15px 对 13px）。同号的话这一句会被读成「第一条要点」，而它不是
             * 要点：要点说的是会上定了什么，这一句说的是这件事在这场会上位移到了哪儿。
             */}
            <p className="mt-2 text-md leading-relaxed [color:var(--meet-fg)]">{debrief.summary}</p>

            {/*
             * 要点那份 checklist。整块的理由和两颗键的做法写在 `DebriefPoints` 上。
             *
             * 边界只在展开之后给（`showBoundary={open}`）：卡面要回答的是「这几条我认不
             * 认」，边界是他追问时才要的东西，而追问已经是展开之后的事了。
             */}
            <DebriefPoints
              points={debrief.points}
              showBoundary={open}
              busy={busy}
              onToggle={onTogglePoint}
              onEditText={onEditPoint}
              onAssign={onAssign}
              className="mt-2.5"
            />

            {open && (
              /*
               * 展开出来的两段用 `animate-rise`（`--dur-base` + `--ease-brand`）—— 全站
               * 转场就那几个时长，这里不自己发明一个。
               *
               * 上面那条发丝线是必须的：它上面是**会上定下来的**，它下面是会上没定的和要
               * 有人去做的。不划这一条，读起来像要点后面又接了几条要点。
               */
              <div className="animate-rise mt-3 space-y-3 border-t border-current/20 pt-3">
                {debrief.open.length > 0 && (
                  <section>
                    <h3 className="meta [color:var(--meet-fg-dim)]">未决</h3>
                    <ul className="mt-1 space-y-1">
                      {debrief.open.map((q, i) => (
                        <li key={i} className="flex gap-2 text-sm leading-relaxed">
                          <span aria-hidden className="shrink-0 [color:var(--meet-fg-dim)]">
                            ?
                          </span>
                          <span className="min-w-0 [color:var(--meet-fg)]">{q}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {debrief.todos.length > 0 && (
                  <section>
                    <h3 className="meta [color:var(--meet-fg-dim)]">下一步</h3>
                    <ul className="mt-1 space-y-1">
                      {debrief.todos.map((t) => {
                        const dest = showTodoDestination ? todoDestination(t) : null;
                        return (
                          <li
                            key={t.id}
                            className="flex items-baseline gap-2 text-sm leading-relaxed"
                          >
                            {/* 记号本身就是「这一条要有人去做」。不用复选框：一个勾不动的
                                复选框是屏幕在假装它能被勾掉，而执行那一头此刻不在这里。 */}
                            <span aria-hidden className="shrink-0 [color:var(--meet-fg-dim)]">
                              →
                            </span>
                            <span className="min-w-0 [color:var(--meet-fg)]">{t.text}</span>
                            {dest ? (
                              /*
                               * 去向那一句。**它把原来那格里的人名顶掉了，不是挤在它旁边。**
                               *
                               * 原来这一格写的是 `owner · due`，而去向里已经带着那个名字
                               * （「已归 张三」）—— 两样并排就是同一个名字在同一行上出现
                               * 两次，弱的那一遍会把强的那一遍稀释掉（同「共识」那一枚上的
                               * 规矩）。期限不重复，所以留着，跟在后面。
                               */
                              <span className="meta ml-auto flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
                                {/*
                                 * 没人接的那一条**多一圈淡底、字色满**，别的两种是一档淡字。
                                 *
                                 * 不用 `--counter`（玫红）那类语义色：这张卡压在会色渐变上，
                                 * 那几个色一个都过不了 4.5（整段理由写在上面「共识 / 分歧」
                                 * 那一枚上）。所以照抄它的解法 —— 同一族字色的两档，要人看见
                                 * 的那一档加一圈底。
                                 *
                                 * 加这一档是有意的：另外两种说的是「这条已经有着落了」，
                                 * 扫过去就行；这一种说的是「这条现在谁也没在管」，而秘书在
                                 * 这一页上唯一非做不可的事就是把它派出去。三种长得一样重的
                                 * 话，她得逐条读完才知道哪几条要动手 —— 那正是这句标注本来
                                 * 要替她省掉的。
                                 */}
                                <span
                                  className={
                                    dest.unrouted
                                      ? "rounded-[4px] px-1.5 font-medium [color:var(--meet-fg)] [background:color-mix(in_oklab,white_16%,transparent)]"
                                      : "[color:var(--meet-fg-dim)]"
                                  }
                                >
                                  {dest.text}
                                </span>
                                {t.due ? (
                                  <>
                                    <span aria-hidden className="[color:var(--meet-fg-dim)]">
                                      ·
                                    </span>
                                    <span className="[color:var(--meet-fg-dim)]">{t.due}</span>
                                  </>
                                ) : null}
                              </span>
                            ) : t.owner || t.due ? (
                              /* 人和期限**只在会上真说了才有**，两个都没有就什么都不显示。
                                 这里绝不写「未指定」：那四个字会长得像一个叫「未指定」的人。 */
                              <span className="meta ml-auto shrink-0 whitespace-nowrap [color:var(--meet-fg-dim)]">
                                {[t.owner, t.due].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

                <Link
                  href={href}
                  className="meta meet-btn-quiet inline-flex items-center gap-1 rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast"
                >
                  完整记录
                </Link>
              </div>
            )}
          </>
        )}

        <div className="mt-3 flex items-center gap-3">
          {editing ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onSave(parseDebriefDraft(draft));
                  setDraft(null);
                }}
                className="meet-btn-primary inline-flex h-8 items-center rounded-lg px-3.5 text-sm font-medium transition-colors duration-fast ease-swift disabled:opacity-40"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="meta meet-btn-quiet rounded-[3px] transition-colors duration-fast"
              >
                取消
              </button>
            </>
          ) : (
            <>
              {/*
               * 这两颗的顺序**不跟着共识变**：`无需再议` 永远在左，`还需再议` 永远在右。
               * 变的只有谁是实心的。位置一换，他会在两张相邻的卡片上按到不同的东西 ——
               * 而这一叠卡片正是一张接一张翻过去的。
               *
               * 左边这颗从前叫「确认」。改口的理由：**这两颗答的是同一个问题** ——
               * 这件事还要不要再谈一次。「确认 / 还需再议」是两个不同层面的词摆在一起，
               * 他得先把「确认」翻译成「不用再谈了」才能和右边那颗比；换成一对反义词之后，
               * 两颗并排本身就是那个问题的两个答案，不用读第二遍。
               *
               * 底下发生的事一个字没变：这一下仍然是这份提炼的封口，这件议题就此进入
               * 已部署（`onConfirm`）。
               */}
              <button
                type="button"
                disabled={busy}
                onClick={onConfirm}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg px-3.5 text-sm transition-colors duration-fast ease-swift disabled:opacity-40",
                  reached ? "meet-btn-primary font-medium" : "meet-btn-ghost",
                )}
              >
                无需再议
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onReopen}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg px-3.5 text-sm transition-colors duration-fast ease-swift disabled:opacity-40",
                  reached ? "meet-btn-ghost" : "meet-btn-primary font-medium",
                )}
              >
                还需再议
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(debriefToText(debrief))}
                className="meta meet-btn-quiet rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast disabled:opacity-40"
              >
                编辑
              </button>

              {/*
               * 详细内容 —— **一条路，不是第四种处置。**
               *
               * 它和左边那三颗并排，但故意不长成键：那三颗按下去这份提炼就变了（认了、
               * 退回、改字），这一条只是把他带到 `/meetings/[slotId]/[issueId]` 去看会议
               * 原文、完整摘要和参会的人。做成第四颗一样重的键，他扫这一排的时候要先分辨
               * 「哪几颗会改东西」——而那正是这一排本来一眼就该说清的事。
               *
               * 所以它是一个带下划线的链接，和「编辑」同一档轻：形状说清它只是走一趟。
               */}
              <Link
                href={detailHref}
                className="meta meet-btn-quiet rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast"
              >
                详细内容
              </Link>

              {/*
               * 展开**不跟着 `busy` 变灰**。上面三颗会改数据，飞着的时候按不动是对的；
               * 而这一颗只是让他多看几行 —— 一次写在飞的时候连读都不让读，是把「系统正忙」
               * 变成了「你先别动」。
               */}
              {/*
               * 这一颗只有一个箭头，**没有字**。
               *
               * 它外面那一层（会后那一栏）在每一场会的抬头上也有一颗「展开」——那一颗展开的
               * 是这一叠卡片，这一颗展开的是这一张卡的细节。同屏两个一模一样的词指着两件
               * 不同的事，比少一个词糟得多。箭头指向本身就说得清「下面还有」。
               */}
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? "收起细节" : "展开细节"}
                onClick={() => setOpen((v) => !v)}
                className="meta meet-btn-quiet ml-auto inline-flex items-center gap-1 rounded-[3px] transition-colors duration-fast"
              >
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-3.5 transition-transform duration-base ease-brand",
                    open && "rotate-180",
                  )}
                />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 一条会后待办去了哪儿                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 会上定下来的这一条，散会之后落到谁头上了。
 *
 * ## 为什么这句话必须写在秘书这一页上，而不是一号位那一屏
 *
 * 一号位面板上摊的是**子集**，而且是故意的子集：要他拍板的，加上会上点了他名的。别的
 * 都不进他那一屏 —— 那正是这套东西存在的理由，他不该每天先从一堆不用他管的事里挑。
 *
 * 可子集有一个结构上的窟窿：**一条谁也没接的待办，和一条压根不该给他看的待办，在他那
 * 一屏上长得一模一样 —— 都是不在。** 也就是说，光看他那一屏，永远验不出「有没有哪一条
 * 掉在了地上」。
 *
 * 所以全集摆在秘书这一页：`/sec/debriefs` 上摊的是这几场会提炼出来的**每一条**，一条不
 * 滤。而全集本身还不够 —— 一叠不分去向的待办里，掉在地上的那一条和已经派出去的那一条
 * 仍然长得一样。补上这一句标注之后，两者在屏幕上才分得开：**「某件事没人去判断」这件事
 * 从此是看得见的，而不是一句没人能核对的承诺。**
 *
 * ## 三种去向，和它们的优先次序
 *
 * 1. **要他拍板** —— 这条是个选择，不是照着做的活。它此刻在他面板的上层。
 * 2. **已归某某** —— 会上点了名。点的是他自己也走这一支（`assignedTo` 这一版只判「是不
 *    是一号位」），写出来就是他的名字：它在他面板的下层，是一件已经有主的执行项。
 * 3. **还没人接** —— 上面两样都不是。DRI 面板这一轮还没有，所以这几条就停在这一页上等
 *    人派。这是一笔明账，不是一个 bug。
 *
 * 次序不能倒过来：一条既要他拍板、会上又顺口点了别人名的待办，先算「要他拍板」。理由和
 * 兜底是同一条 —— 宁可多摆一条到他面前，也不许一条要他定的事因为旁边写了个名字就算完了。
 *
 * ## 为什么缺字段算「要他拍板」
 *
 * `principal` 是相三才加的，这之前落库的提炼一条都没有。**缺字段一律当 `needed: true`**，
 * 跟这条链路上别处一个口径：拿不准的往他那儿送，不往地上掉。反过来兜底成 `false` 的话，
 * 库里所有老记录会一夜之间集体变成「还没人接」或者「已归某某」—— 前者是凭空造出一堆假
 * 警报，后者更糟：它等于替一场没读过的会宣布「这条不用他管」。
 */
function todoDestination(t: DebriefTodo): { text: string; unrouted: boolean } {
  /* `??` 不是 `||`：`needed: false` 是一个真答案（模型读完转写判的「这条不用他管」），
     不能和「这条记录里压根没有这个字段」混成一档。 */
  const needsPrincipal = t.principal?.needed ?? true;
  if (needsPrincipal) return { text: "等一号位拍板", unrouted: false };

  /* `assignedTo.name` 优先于 `owner`：前者是那个名字在人表里认出来之后的写法，后者是转写
     里的原话（可能是「我」「我来」这种第一人称）。屏幕上要的是人名，不是当时那句话。 */
  const name = t.assignedTo?.name ?? t.owner;
  if (name) return { text: `已归 ${name}`, unrouted: false };

  /*
   * **不写「待分派」。** 那三个字是一个流程状态的名字 —— 读起来像这条正待在某个环节里
   * 排队，而屏幕上真实的情况是：没有那个环节，也没有人在推它，它就停在这儿。用大白话说
   * 「还没人接」，它才读得出是一个没合上的口子，而不是一格填好的状态。
   *
   * 也不写「无人认领」这类看着像名词的词：这一格紧挨着人名出现（另外两种就在写名字），
   * 一个名词短语很容易被扫成「一个叫这个的人」—— 同一条坑写在下面 `t.owner` 那一支上。
   */
  return { text: "还没人接", unrouted: true };
}

/* -------------------------------------------------------------------------- */
/* 要点那份 checklist：每一条两颗键                                            */
/* -------------------------------------------------------------------------- */

/**
 * 会上定下来的那几条，一条一行，每一行两颗键。
 *
 * ## 为什么它是一份**真的** checklist
 *
 * 上一版是一颗 1px 的圆点加一行文本 —— 读起来是「这里有几句话」，而它实际上是「这里有
 * 几件要他逐条过的事」。一场会谈出五条，他会一条一条看过去；给每一条一个能勾的方框，
 * 那个过程就在屏幕上留下痕迹，中途被打断回来也知道看到哪儿了。
 *
 * **勾不是确认，也不是确认的前置**（理由整段写在 `DebriefPoint.checked` 上）。所以勾掉
 * 的那一条只是压淡加一道删除线：不消失，也不解锁任何东西。
 *
 * 不用原生 `<input type="checkbox">` —— 它在深底上的样子各浏览器自己发挥，而这一格必须
 * 和整张卡是同一套材质。`role="checkbox"` + `aria-checked` 把语义补回来。
 *
 * ## 第二颗：改这一条
 *
 * 勾说的是「这条总结得没错」，那就必须有一条路说「这条总结得有出入」。没有它，他遇到一条
 * 措辞不对的要点只有两个选择：把整份重写一遍（底下那颗「编辑」），或者干脆不勾 —— 而
 * 「没勾」在屏幕上和「还没看到这一条」长得一模一样。
 *
 * 这一颗**不给字，给一支笔**：这张卡底下已经有一颗叫「编辑」的键（改的是整份），同屏两个
 * 「编辑」指着两件不同的事，比少一个词糟得多 —— 同一条理由写在那颗箭头上。
 *
 * ## 为什么抽出来
 *
 * 它现在长在两处：首页那张卡上，和 `/meetings/[slotId]/[issueId]` 那一页上。两处各写一遍
 * 的话，上面那几条规矩迟早只在其中一处成立 —— 而两处看起来一模一样，屏幕上分不出来是
 * 哪一处退化了。
 */
export function DebriefPoints({
  points,
  showBoundary,
  busy,
  onToggle,
  onEditText,
  onAssign,
  readOnly,
  className,
}: {
  points: DebriefPoint[];
  /**
   * 边界跟着一起显示吗。
   *
   * **没有就是没有** —— 会上没划出边界的那一条，这里一个字都不加。写一个「无」会让它
   * 看起来像会上专门确认过「这条没有边界」，那是替一场会说了它没说过的话。
   */
  showBoundary: boolean;
  /** 有写操作在飞。飞着的时候两颗键都要按不动。 */
  busy?: boolean;
  onToggle: (pointId: string) => void;
  onEditText: (pointId: string, text: string) => void;
  /**
   * 把这一条派给谁（`null` = 撤掉）。**不给就不显示那颗下拉。**
   *
   * 已经确认过的那一份不给：那一下是这份提炼的封口，之后它是一条历史记录 ——
   * 数据层也会挡（`assignDebriefPoint`），但一颗按下去必定报错的键本来就不该在屏幕上。
   */
  onAssign?: (pointId: string, driId: string | null) => void;
  /**
   * 只读 —— 座位在这一侧不管改这几条要点，而不是这一次调用刚好没接改的回调。
   *
   * 默认 `false`：`DebriefColumn` 现在只有一处调用方——秘书那一侧的 `/sec/debriefs`
   * （`sec-debriefs-view.tsx`），它和它底下的 `DebriefCard` 从来不传这个 prop，
   * 所以那一页的行为原样不动。首页右栏那一叠已经在相二撤掉、换成了动态面板
   * （`DynamicPanel`），不再用 `DebriefColumn`。
   *
   * 为真时勾选、改字、派人那颗下拉三样入口都不渲染 —— **不是渲染成 disabled**：一颗按
   * 不动的键要他先想一遍「为什么摁不动」，比这里干脆没有那颗键更难懂。文字、边界、和
   * 已经派给谁这三样仍然要读得到，所以勾选状态和指派人名换成不能点的展示，不是整段消失。
   *
   * 这个 prop 不读 cookie、不看登录态判断 —— 调用方（`MeetingDebriefView`）从路由收
   * 一个布尔值透传下来，因为「这一份改不改得动」是页面挂在哪个座位下面的性质，不是运行
   * 时才知道的状态（哪一个路由渲染这个组件，在构建时就定了）。
   */
  readOnly?: boolean;
  className?: string;
}): ReactElement | null {
  /* 一次只改一条。改第二条之前先落一次盘 —— 攒着几条一起提交，中间任何一次失败都说不清
     是哪几条没进去。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (points.length === 0) return null;

  const start = (p: DebriefPoint) => {
    setEditing(p.id);
    setDraft(p.text);
  };

  return (
    <ul className={cn("space-y-0.5", className)}>
      {points.map((p) =>
        /* 只读那一侧永远走下面「摊开的一行」那一支 —— `editing` 本来就只会被下面那支
           里的笔（这里不渲染）设成 `p.id`，这一句是双保险，不是真的会分岔。 */
        !readOnly && editing === p.id ? (
          <li key={p.id} className="px-1 py-1">
            <textarea
              autoFocus
              rows={2}
              aria-label={`改这一条 · ${p.text}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              /* 摁下去不冒泡到外面那张卡：会后那一叠上按住卡片是「甩」（翻到下一张），
                 而他在这里按住是要选中一段文字。 */
              onPointerDown={(e) => e.stopPropagation()}
              className="report scroll-slim concentric field-sizing-content max-h-40 w-full resize-none overflow-y-auto border border-current/25 bg-black/15 px-2.5 py-1.5 text-sm leading-relaxed [color:var(--meet-fg)] outline-none transition-colors duration-fast focus:border-current/50"
            />
            <div className="mt-1.5 flex items-center gap-3">
              {/* 改空不给存：空文本到了数据层会被当成「这一条删了」滤掉，而他此刻做的是
                  改一句话 —— 一条要点凭空消失，屏幕上不会有任何东西提示他刚删了什么。 */}
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => {
                  onEditText(p.id, draft.trim());
                  setEditing(null);
                }}
                className="meet-btn-primary inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors duration-fast ease-swift disabled:opacity-40"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="meta meet-btn-quiet rounded-[3px] transition-colors duration-fast"
              >
                取消
              </button>
            </div>
          </li>
        ) : (
          <li key={p.id} className="flex items-start gap-1">
            {/*
             * 勾选那一格。**只读时换成一个不能点的容器，不是把 `<button>` 加上
             * `disabled`。** 一颗按不动的勾选框要他先想一遍「为什么按不下去」，比这里
             * 干脆没有一颗能按的东西更难解释 —— 这一条规矩整段写在 `readOnly` 的注释上。
             *
             * 勾没勾这件事本身仍然要读得到，而且是**对屏幕阅读器**也要读得到，不只是
             * 视觉上看得见。上一版这里换成一个裸 `<span>`，勾选状态只留在了看得见颜色
             * 变化的人那一边——读屏软件拿到的是一段没有语义的文字，分不出这一条是勾过
             * 还是没勾过，跟"读不到"没有区别。所以这里保留 `role="checkbox"` 和
             * `aria-checked`，只用 `aria-disabled` 说明摁不动，而不是连角色和状态一起
             * 摘掉。容器也从 `<span>` 换成 `<div>`：上一版的 `<span>` 直接包了一个
             * `<div>`，不合规；`<button>` 同样只能放短语内容，也不能拿来给这层非法嵌套
             * 开脱。写操作那一支因此把文字组也换成 `<span>`，两边都不再靠浏览器容错。
             */}
            {readOnly ? (
              <div
                role="checkbox"
                aria-checked={Boolean(p.checked)}
                aria-disabled="true"
                className="flex min-w-0 flex-1 gap-2 rounded-md px-1 py-1 text-left text-sm leading-relaxed"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                    p.checked
                      ? "border-transparent [background:var(--meet-fg)]"
                      : "border-current/45",
                  )}
                >
                  {p.checked ? (
                    <Check
                      className="size-2.5 [color:var(--meet-deep,var(--meet))]"
                      strokeWidth={3}
                    />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className={cn("[color:var(--meet-fg)]", p.checked && "font-semibold")}>
                    {p.text}
                  </span>
                  {showBoundary && p.boundary ? (
                    <span className="mt-0.5 block [color:var(--meet-fg-dim)]">{p.boundary}</span>
                  ) : null}
                </span>
              </div>
            ) : (
              <button
                type="button"
                role="checkbox"
                aria-checked={Boolean(p.checked)}
                disabled={busy}
                onClick={() => onToggle(p.id)}
                /* 摁下去不冒泡：外面那一层可能是一张能甩的卡片。 */
                onPointerDown={(e) => e.stopPropagation()}
                className="flex min-w-0 flex-1 gap-2 rounded-md px-1 py-1 text-left text-sm leading-relaxed transition-colors duration-fast hover:[background:color-mix(in_oklab,white_8%,transparent)] disabled:opacity-60"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-fast",
                    p.checked
                      ? "border-transparent [background:var(--meet-fg)]"
                      : "border-current/45",
                  )}
                >
                  {p.checked ? (
                    <Check
                      className="size-2.5 [color:var(--meet-deep,var(--meet))]"
                      strokeWidth={3}
                    />
                  ) : null}
                </span>
                <span className="min-w-0">
                  {/*
                   * 勾上之后是**加重，不是划掉**。
                   *
                   * 划线加压淡说的是「这一条作废了」——那是待办清单的语言：做完的事从眼前
                   * 退下去。而这里勾的意思正相反：**这一条总结得没错，我认了它**。认下的
                   * 结论是这份提炼里最硬的那几条，它们该更清楚，不该更淡。
                   *
                   * 所以勾上之后加粗、颜色不退。没勾的那几条也不压淡 —— 没勾不等于不同意，
                   * 只是还没看到那儿。
                   */}
                  <span className={cn("[color:var(--meet-fg)]", p.checked && "font-semibold")}>
                    {p.text}
                  </span>
                  {showBoundary && p.boundary ? (
                    <span className="mt-0.5 block [color:var(--meet-fg-dim)]">{p.boundary}</span>
                  ) : null}
                </span>
              </button>
            )}

            {/* 笔一直在，不是划过去才出现：只在 hover 时露出来的键，在他扫这一列的时候
                等于不存在，而「这条说得不对」正是扫的过程中冒出来的念头。
                只读时这支笔整支都不画——改字是这一格唯一的用处，没有别的信息要保留。 */}
            {readOnly ? null : (
              <button
                type="button"
                disabled={busy}
                aria-label={`改这一条 · ${p.text}`}
                title="改这一条"
                onClick={() => start(p)}
                onPointerDown={(e) => e.stopPropagation()}
                className="meet-btn-quiet mt-[3px] flex-none rounded-[3px] p-1 transition-colors duration-fast disabled:opacity-40"
              >
                <Pencil aria-hidden className="size-3" />
              </button>
            )}

            {/*
             * 派给谁。**挨着那支笔，在同一列上。**
             *
             * 这两颗是同一类动作：一条任务摆在他眼前，他要么改它的措辞，要么决定它归谁。
             * 派人不放进展开层里 —— 一场会提炼出五条任务，指派是他在这张卡上要做的**主要
             * 的事**（识别任务模型做得了，派给谁做不了），藏在展开里等于让主要动作多一步。
             *
             * 没派的时候只有一个小人加号：一行任务后面挂一句「未指派」，读起来像那里站着
             * 一个叫「未指派」的人（同 `todos` 那一段上的规矩）。
             *
             * **只读时这颗下拉换成一句纯文字。** 已经派给谁仍然是「读得到」那三样之一
             * （文字、边界、指派），只是这一侧没有派人的入口——所以派了就写名字，没派
             * 什么都不写（不写「未指派」，理由同 `todos` 那一段）。
             */}
            {readOnly ? (
              p.assignee ? (
                <span className="meta mt-[3px] max-w-[7.5rem] flex-none truncate [color:var(--meet-fg-dim)]">
                  {p.assignee.name}
                </span>
              ) : null
            ) : onAssign ? (
              <AssignMenu
                value={p.assignee ?? null}
                disabled={busy}
                label={p.text}
                onPick={(driId) => onAssign(p.id, driId)}
              />
            ) : null}
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * 把某一条要点的字改掉，落库。
 *
 * 一层壳，包着数据层那个只动一条的方法（`api.updateDebriefPoint`）：id、边界、以及别的
 * 条上他刚勾的记号，一样都不碰。
 *
 * ## 它为什么不走 `api.updateDebrief`
 *
 * 那一条收的是四段各自的**整份**，落库时按下标重建 `points` —— 于是改一句话的代价是
 * 整份要点的 id 全换一遍。第一版就是那么写的，附带一个自己补勾的兜底（改完再把原来
 * 勾着的那几条按位置勾回去）。那个兜底能用，但它是在替数据层的形状打补丁：屏幕上这支笔
 * 的语义是最窄的那一种 ——「这一句总结得有出入，我改一下」—— 它不该有能力动到别的条，
 * 而「有没有能力」不该由调用方小心翼翼地绕过去。
 *
 * 数据层补上那个方法之后，兜底连同它的用例一起删了。
 */
export async function saveDebriefPointText(
  debrief: MeetingDebrief,
  pointId: string,
  text: string,
): Promise<void> {
  await api.updateDebriefPoint(debrief.slotId, debrief.issueId, pointId, text);
}

/* -------------------------------------------------------------------------- */
/* 改字：一整块文本和它的两条来回                                              */
/* -------------------------------------------------------------------------- */

/**
 * 把一份提炼摊成他能直接改的一整块文本。
 *
 * ## 格式
 *
 * ```
 * 这件事在这场会上收敛到什么程度        ← 第一行，不带记号，是概述
 * · 会上定下来的一条｜它在哪儿到头       ← `｜` 后面是边界，没有边界就没有 `｜`
 * → 谁要去做的一件事｜张三 · 下周三      ← `｜` 后面是人和期限，两个都没有就没有 `｜`
 * ? 会上没定、下一轮要回答的一件事
 * ```
 *
 * ## 为什么第一行不带记号
 *
 * 给它也配一个记号（比如 `# `）的话，四种记号里有三种是他从没见过的符号，而它们之间的
 * 区别要靠记。不带记号的那一行天然就是「最上面那句话」—— 他不用学，删掉它、重写一句，
 * 位置对了含义就对了。
 *
 * ## 解析规则（`parseDebriefDraft`）
 *
 * - 第一条非空行**不带记号**时是概述；带记号说明他把概述整句删了，那这份就没有概述。
 * - `·` `•` `*` `-` 是要点，`→` `>` 是待办，`?` `？` 是未决。
 * - **认不出记号的行按要点收。** 丢一行的代价是他写的东西凭空消失，而那比归错类严重
 *   得多 —— 归错了他一眼看得见，也一秒改得回来；丢了他要等到下次翻记录才发现。
 * - 待办后面那段附注按 `·` 切成人和期限；只写了一段时按人收（会上点了名没给期限，比
 *   给了期限没点名常见得多）。
 *
 * 两个方向是无损的：`parseDebriefDraft(debriefToText(d))` 还原 `d` 的四段内容。`id` 不
 * 进文本 —— 它是数据层的东西，屏幕上没有它的位置，写进去只会被他误删。
 */
export function debriefToText(d: MeetingDebrief): string {
  return [
    d.summary,
    ...d.points.map((p) => [`· ${p.text}`, p.boundary].filter(Boolean).join("｜")),
    ...d.todos.map((t) =>
      [`→ ${t.text}`, [t.owner, t.due].filter(Boolean).join(" · ")].filter(Boolean).join("｜"),
    ),
    ...d.open.map((q) => `? ${q}`),
  ].join("\n");
}

/** 把那一整块文本读回四段。规则整段写在 `debriefToText` 上 —— 认不出的行按要点收。 */
export function parseDebriefDraft(text: string): DebriefDraft {
  let summary = "";
  let first = true;
  const points: { text: string; boundary?: string }[] = [];
  const todos: { text: string; owner?: string; due?: string }[] = [];
  const open: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    /* 空行不承载内容，丢掉。它是他打字时的呼吸，不是一条空要点。 */
    if (!line) continue;

    const marked = /^[·•*\-→>?？]/.test(line);
    if (first) {
      first = false;
      /* 第一条非空行没带记号 —— 那就是概述。带了记号说明他把概述删了，往下照常收。 */
      if (!marked) {
        summary = line;
        continue;
      }
    }

    if (/^[→>]\s*/.test(line)) {
      const [body, note] = line.replace(/^[→>]\s*/, "").split("｜");
      const [owner, due] = (note ?? "").split("·").map((s) => s.trim());
      const t = body.trim();
      if (!t) continue;
      todos.push({ text: t, ...(owner ? { owner } : {}), ...(due ? { due } : {}) });
      continue;
    }

    if (/^[?？]\s*/.test(line)) {
      const q = line.replace(/^[?？]\s*/, "").trim();
      if (q) open.push(q);
      continue;
    }

    const [body, note] = line.replace(/^[·•*\-]\s*/, "").split("｜");
    const t = body.trim();
    if (!t) continue;
    const boundary = (note ?? "").trim();
    points.push({ text: t, ...(boundary ? { boundary } : {}) });
  }

  return { summary, points, todos, open };
}
