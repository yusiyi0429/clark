import type { ReactElement } from "react";

import type { DomainSummary, IssueSummary } from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 已部署 —— 右边那一大块的全部内容（左边一列不动，只有这一块换掉）。
 *
 * ## 这一栏只回答三个问题
 *
 * 一件议题走到这一档，意思是**方向定了、任务交出去了，压在 DRI 身上，不再压在一号位
 * 身上**。他不会每天读它。他隔一段时间来一趟，来的时候要能就地答出三句话：
 *
 *   ① 这件事当时定的是什么      标题 + `monitoringNote` 那一句 + 上过几次会
 *   ② 现在谁在跑，跑到哪了      承接人（点名的 / 域的 DRI）+ 那份承接研究回没回
 *   ③ 什么条件会把它重新打开    `monitoringNote` 里的布控那一句，以及最上面那条「已重开」带
 *
 * ## 上一版为什么不行
 *
 * 上一版（`/deployed` 那一页）做的全部事情是**搬家**：把已部署从主屏那份清单里挪出来，
 * 然后照着议题栏的样子摆了一份朴素清单 —— 编号、标题、`monitoringNote`、更新时间。它
 * 诚实，但它一个问题都没回答：三件已部署的议题在屏幕上长得完全一样，而它们之间唯一
 * 值得区分的事情（有没有哪一件的布控条件已经动了）根本没有画出来。他扫完那一页只知道
 * 「这里有三件」，不知道「今天要不要为其中哪一件停一下」。
 *
 * ## 按什么组织：按「盯着的条件有没有动静」
 *
 * 只分两带，而且**只有上面那一带有抬头**：
 *
 *   已重开   `state === "Reopened"`，或者身上真有一轮深研在跑
 *   （其余）  不给抬头
 *
 * 为什么是这个：已部署这一档的存在理由就是第三个问题 —— 已部署不等于结束，出现某个
 * 新事实它就该回到他桌上。那么这一栏的第一刀就该切在「那件事发生了没有」上。切完之后
 * 上面那一带通常是空的（空了就整带不出现），于是这一栏在绝大多数日子里是一份平铺的
 * 档案 —— 那正是它该有的样子；而真有一件被打回来的时候，它自己会长在最上面，不用他找。
 *
 * **为什么不按业务域**：域这一刀已经由左边那一列切了（`domainId` 就是它传进来的）。
 * 在这里再按域分一次组，是同一把筛子在一屏上出现两遍；而且他切到某个域之后，这一栏
 * 的分组会全部塌成一组 —— 一个大部分时候只有一组的分组不是分组。
 *
 * **为什么不按定下来的时间**：`IssueSummary` 上根本没有 `decidedAt`（只有 `updatedAt`
 * 和 `ageDays`），拿 `updatedAt` 冒充「什么时候定的」是错的 —— 一件刚被打回、又跑了
 * 一轮深研的议题，它的 `updatedAt` 是昨天，而它定下来是三个月前。按那个分组，屏幕上
 * 会出现「本月定的」里躺着一件今年五月定的事。时间在这一栏里只当尾注（每行右下角那
 * 一个时刻），不当骨架。
 *
 * ## 为什么这一档的存在感要低于在办那一栏
 *
 * 在办那一栏（`IssueColumn`）用的是**块**：纸色浮在托盘上，每一件都有自己的边界，
 * 已排会的那几件甚至是深色实心的重块。那套画法是给「要被单独拿起来、单独处置」的东西
 * 用的（globals.css 里 `.list-block` 那段写的判据）。已部署没有一件需要他拿起来 ——
 * 它是**可查的**，不是要处理的。所以这里用**行**：直接坐在托盘上，行与行之间一条内缩
 * 的发丝线，没有块、没有阴影、没有深色重块、没有呼吸点、没有任何一颗按钮。标题也跟着
 * 降一档（`text-base` 而不是在办那栏的 `text-md`）—— 同一条判断的两处落实：扫一遍的
 * 东西不用挑一件的字号。
 *
 * 反过来说，做错了在屏幕上是什么样：只要这一栏出现了纸块、出现了动作键、出现了一颗
 * 在跑的呼吸点，它就变成了第二个议题栏 —— 而那意味着「部署」这个动作没有替他消掉任何
 * 打扰，只是把同一堆事换了个地方再摆一遍。
 *
 * ## 一处必须说清的天花板
 *
 * 第一个问题真正要的是「会后确认下来的那句话」，而**那句话不在 `IssueSummary` 上**
 * （摘要上的 `debrief` 只挂还没确认的那一份，确认过的就摘掉了；`Closure` 的正文更是
 * 只在议题详情里）。这一栏手上唯一能承载它的字段是 `monitoringNote`，而那一格在两条
 * 路径上写的是两种东西：会后写回那条路写的是「已布控 2 条 Re-open Trigger」（答的是
 * 第三个问题），而定下来时人手写的那条写的是「总体战略定位与阶段路径已确认，进入闭环
 * 验证。」（答的是第一个问题）。
 *
 * 所以它**原样摆在标题底下、占整行**，不塞进某一列：塞进「重开条件」那一列，另一半
 * 内容就被安到了错的标题下面；而这一栏没有列头（见下面那段），错位不会被任何一个字
 * 纠正过来。要读那句拍板原话，整行点进 `/issues/${id}`。
 *
 * ## 没有列头，也没有状态标签
 *
 * 三个区一路对齐往下排，对齐本身就说清了哪一列是什么，不需要在头上再写三个词
 * （`Card` 那段注释写的是同一条：区分靠字号和留白，不靠标签）。状态标签同理 ——
 * 这一栏里的每一件都是「已部署」，再给每行盖一枚 `Decided` / `Monitoring` 的章，
 * 说的是同一件事的两种拼法。唯一被画出来的状态是「已重开」，而它是一条带，不是一枚章。
 */
export function DeployedPane({
  issues,
  domains,
  domainId,
  loading,
  selectedId,
  onSelect,
}: {
  /** 已部署的那些（调用方已经筛好：`settled && state !== "Closed" && state !== "Dismissed"`）。 */
  issues: IssueSummary[];
  /** 域的名字表。 */
  domains: DomainSummary[];
  /** 左栏此刻选中的域；`null` = 不按域看（看全部）。 */
  domainId: string | null;
  /** 数据还在路上。true 时出骨架。 */
  loading?: boolean;
  /** 右半边此刻摊开的是哪一件。 */
  selectedId: string | null;
  onSelect: (issueId: string) => void;
}): ReactElement {
  /*
   * 域这一刀在这里落，不在调用方 —— 左边那一列切域的时候，这一块必须跟着走。不跟着走
   * 的话，他在这一屏上点八个域，屏幕右半边一个像素都不动，那一列在这一屏上就成了死的。
   *
   * 认的是 `i.domainId === domainId` 这一条，不做任何回退：一件没有域的已部署议题
   * （手动立的议题刚进来时确实没有域）在某个具体的域下就是不该出现，把它塞进任何一个
   * 域都是编。他要看全部，左边那一列自己有「总览」那一格（传进来是 `null`）。
   */
  const scoped = domainId === null ? issues : issues.filter((i) => i.domainId === domainId);

  const domainName = (id: string | undefined) =>
    id ? domains.find((d) => d.id === id)?.name : undefined;
  /*
   * 指派人没点名时，承接这件事的默认就是域负责人 —— 这跟数据层 `findDomainDri` 是同一条
   * 口径，不是这一栏自己发明的关系。两者在屏幕上仍然分得开：点名的那个人拿满墨色，
   * 域的 DRI 退一档（见下面 `Owner`）。
   */
  const domainDri = (id: string | undefined) =>
    id ? domains.find((d) => d.id === id)?.driName || undefined : undefined;

  /*
   * 「动了没有」的判据只认两条能核对的事实：
   *
   *   `state === "Reopened"`     它真的被重开了。
   *   `research.state === "running"`  身上有一轮深研在跑。
   *
   * 第二条不是凑数：一件已经部署的议题不会无缘无故起深研，只有被打回才会（`store.ts`
   * 的 `reopenDeepResearch`，那条路顺手把 `monitoringNote` 写成「已打回 · 第二轮深度
   * 研究进行中」）。所以两条说的是同一件事的两个时刻，归同一带。
   *
   * 不把 `nextActionForUser` 或 `debrief` 算进来：那两样在这一屏上各自有归宿（会后待
   * 确认的那几份摊在首页右栏），在这里再数一遍，就是同一件事在两个地方各要他一次注意力。
   */
  const stirred = (i: IssueSummary) => i.state === "Reopened" || i.research.state === "running";

  /* 两带内部都按最近有动静排。这一栏上「新」的唯一含义就是「刚有过回音」。 */
  const byRecency = (a: IssueSummary, b: IssueSummary) => b.updatedAt.localeCompare(a.updatedAt);
  const reopened = scoped.filter(stirred).sort(byRecency);
  const quiet = scoped.filter((i) => !stirred(i)).sort(byRecency);

  return (
    /*
     * 整块就是首页右半边那块托盘本身（同一个 `--r`、同一块 `--list-ground`）—— 它替下的
     * 正是那块托盘里的两栏，换一套圆角或者换一档底色，从两颗点走过来的那一下会读成
     * 「跳到了另一个产品」。
     *
     * `--p: 0.5rem` 是给下面每一行的 `.concentric` 用的：8px 的内圆角 = 16 − 8。行不缩进
     * 到这个内边距里的话，最上和最下那一行的 hover 淡底会把托盘的两个圆角削平。
     */
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-2xl bg-list-ground [--p:0.5rem] [--r:1rem]">
      <header className="flex h-10 items-center px-1">
        {/* 抬头和左右两栏同高同字号（`h-10` / `text-md`）—— 这一块换掉的是它们，
            标题栏的位置在切换的那一帧里不该动。件数跟在标题后面，不单独靠右：靠右
            会把居中的标题挤偏，而那一下看起来像整块换了对齐方式。 */}
        <div className="mx-auto flex items-baseline gap-2">
          <h2 className="text-md font-medium text-ink">已部署</h2>
          <span className="meta tabular-nums text-ink-faint">{scoped.length} 件</span>
        </div>
      </header>

      <div className="scroll-slim min-h-0 overflow-y-auto px-2 pb-2">
        {loading ? (
          <PaneSkeleton />
        ) : scoped.length === 0 ? (
          <p className="meta px-1.5 py-2 text-ink-faint">
            {domainId === null ? "现在没有已部署的议题。" : "这个域下没有已部署的议题。"}
          </p>
        ) : (
          <>
            {reopened.length > 0 && (
              <section>
                {/*
                 * 整块灰底上唯一一处带色的字。
                 *
                 * `--factual` 在全站的含义是「系统真的观测到 / 真的在跑」（雷达那颗点、
                 * 深研在跑那颗点用的都是它），而一条布控条件被打中正是这个意思。一个词
                 * 的色量，足够让眼睛第一下就落在这里 —— 这一栏平时不该有任何东西抢眼，
                 * 所以真有事的那一天它必须是唯一抢眼的那一处。
                 */}
                <header className="flex items-baseline gap-2 px-1.5 pt-1.5 pb-1">
                  <span className="meta font-medium text-factual">已重开</span>
                  <span className="meta tabular-nums text-ink-faint">{reopened.length} 件</span>
                </header>
                {reopened.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    domainLabel={domainId === null ? domainName(issue.domainId) : undefined}
                    driName={domainDri(issue.domainId)}
                    selected={issue.id === selectedId}
                    onSelect={() => onSelect(issue.id)}
                  />
                ))}
              </section>
            )}

            {/*
             * 剩下那几件不给抬头。
             *
             * 给它们扣一个「监测中」之类的头是错的：这一栏的标题已经写着「已部署」，再写
             * 一遍等于同一句话说两次；而且那几件里 `state` 有的是 `Decided`、有的是
             * `Monitoring`，任何一个统称都会在其中一半上说得不准。上面那一带有抬头是
             * 因为它真的是从这份清单里**挑出来的一批**，剩下的不是一批，它就是这份清单。
             *
             * 两带之间靠一段留白分开（`mt-5`），不靠线：线会把这一栏读成两张表。
             */}
            <section className={cn(reopened.length > 0 && "mt-5")}>
              {quiet.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  domainLabel={domainId === null ? domainName(issue.domainId) : undefined}
                  driName={domainDri(issue.domainId)}
                  selected={issue.id === selectedId}
                  onSelect={() => onSelect(issue.id)}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 一件已部署的议题 —— 一行                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 三个区，从左往右就是那三个问题：这件事是什么 / 谁在跑 / 什么时候有过动静。
 *
 * 中间和右边两区**定宽**（`shrink-0`），左边那区吃掉剩下的。定宽是为了让整栏的人名列
 * 和时间列各自对齐成一条 —— 他扫这一栏最常做的两件事就是「这块地归谁」和「哪件最久
 * 没动了」，而那两件事只有在列对齐的时候才是一眼，不然是一行一行地找。
 *
 * 区与区之间不画竖线。竖线会把这一栏变成一张表格，而表格的墨量属于「要逐格核对」的
 * 东西；这一栏是扫的。对齐已经把列分出来了，再补一道线就是同一件事画两遍。
 */
function IssueRow({
  issue,
  domainLabel,
  driName,
  selected,
  onSelect,
}: {
  issue: IssueSummary;
  /** 域名。只在「总览」下给 —— 已经切到某个域时，每行重复同一个词是纯噪音。 */
  domainLabel?: string;
  /** 这个域的 DRI。他没点过名时，承接这件事的默认就是这个人。 */
  driName?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    /*
     * 这一行**不再是链接，是一个选择**。
     *
     * 上一版整行点进去就是 `/issues/[id]` —— 那时右边没有第二半，唯一能做的事就是离开
     * 这一屏。现在右边是这一件交出去之后的样子，所以这一下的含义变成「摊开它」，
     * 而进议题研究的那条路挪进了右半边的抬头（一个出口，不是每行一个）。
     *
     * 用 `<button>` 而不是给 `<div>` 挂 onClick：这一列是键盘上真的要能走一遍的东西
     * （Tab 到某一行、回车摊开它），而那两样只有真正的按钮天然带着。
     */
    <button
      type="button"
      aria-current={selected}
      onClick={onSelect}
      className={cn(
        "row row-link concentric flex w-full items-start gap-5 px-3.5 py-3 text-left",
        /* 选中的那一行底色比 hover 再深一档 —— 它要在指针移开之后仍然认得出来。 */
        selected && "bg-[color-mix(in_oklab,var(--ink)_7%,transparent)]",
      )}
    >
      {/* ① 这件事当时定的是什么 */}
      <div className="min-w-0 flex-1">
        <div className="meta flex items-baseline gap-2 text-ink-faint">
          <span className="shrink-0">{issue.id}</span>
          {domainLabel ? <span className="truncate">{domainLabel}</span> : null}
        </div>
        <p className="clamp-2 mt-0.5 text-base leading-relaxed text-ink">{issue.title}</p>
        {/*
         * 那一句原样摆着，占整行。
         *
         * 它是这一栏手上唯一一句「当时定了什么 / 此刻在盯什么」的话，而它在两条路径上
         * 写的是两种东西（文件头最后一段）。没有就不写 —— 补一句「已部署」是把标题上
         * 那三个字再说一遍，而屏幕上凭空多出来的一行会让人以为那是这件议题自己的内容。
         */}
        {issue.monitoringNote ? (
          <p className="clamp-2 mt-1 text-sm leading-relaxed text-ink-muted">
            {issue.monitoringNote}
          </p>
        ) : null}
      </div>

      {/* ② 现在谁在跑，跑到哪了 */}
      <Owner issue={issue} driName={driName} />

      {/* ③ 什么时候有过动静 */}
      <div className="w-[6.5rem] shrink-0 text-right">
        <span className="meta block tabular-nums text-ink-faint">
          {formatStamp(issue.updatedAt)}
        </span>
        {/*
         * 上过几次会。这是这一栏能拿出来的、最接近「它是怎么定下来的」的可核对事实
         * （`meetingsHeld` 数的是会后确认真的落过几次），所以它跟着时刻走，属于履历
         * 那一列，不跟标题挤在一起。
         *
         * 零次不写。一件已部署却一次会都没上过的议题是有的（他自己拍的），那时这一格
         * 空着是实话；写「上会 0 次」等于用一个零去暗示他漏了什么。
         */}
        {issue.meetingsHeld > 0 ? (
          <span className="meta block tabular-nums text-ink-faint">
            上会 {issue.meetingsHeld} 次
          </span>
        ) : null}
      </div>
    </button>
  );
}

/**
 * 承接这件事的人。
 *
 * 三档，靠**亮度**分，不靠在旁边写字解释是哪一档：
 *
 *   点名派出去的（`assigneeName`）  满墨色 —— 有一个人把名字押在上面了
 *   域的 DRI（没点过名）            退一档 —— 这是位置带来的责任，不是一次指派
 *   两样都没有                      「未指派」，再淡一档
 *
 * 「未指派」是这一格唯一允许出现的编出来的词，而它编的是**空本身**：没有人接这件事
 * 是一个要被看见的事实，留白说不出这句话 —— 留白只会读成「这个字段还没加载出来」。
 * 除此之外一个字都不补：没有 DRI 就不许猜一个人名放上去。
 *
 * 底下那一行只在真点过名的时候出现，写那份承接研究回没回（`handoff`）—— 「跑到哪了」
 * 这半个问题，摘要上能答的就是它。域 DRI 那一档没有这一行：`handoff` 整个是从
 * `assigneeName` 算出来的（`store.ts` 的 `handoffStatus`），没点名时它一律是
 * `unassigned`，在那一档下面写「等回传」是在报一个根本没发生过的交接。
 */
function Owner({ issue, driName }: { issue: IssueSummary; driName?: string }) {
  const named = issue.assigneeName;
  const person = named ?? driName;

  return (
    <div className="w-[9.5rem] shrink-0">
      <span
        className={cn(
          "block truncate text-sm leading-relaxed",
          named ? "text-ink" : person ? "text-ink-muted" : "text-ink-faint",
        )}
      >
        {person ?? "未指派"}
      </span>
      {issue.handoff.state !== "unassigned" ? (
        <span className="meta block text-ink-faint">
          {issue.handoff.state === "done" ? "已回传" : "等回传"}
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 骨架。几何照着真行来：同样的左右内边距、同样的三区、同样的行高，数据落下来的时候
 * 这一块不重排（`ColumnSkeleton` 那一条，同一个理由）。
 *
 * 三条横杠对着的是编号、标题、`monitoringNote` 那三行 —— 不给中间和右边那两列摆杠：
 * 那两列本来就常有空的一格（没 DRI、没上过会），骨架上摆满，等真数据落下来反而是
 * 一次「东西变少了」。
 */
function PaneSkeleton() {
  return (
    <div aria-live="polite">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="row concentric px-3.5 py-3">
          <span className="skeleton block h-2.5 w-20" />
          <span className="skeleton mt-2 block h-4 w-[46%]" />
          <span className="skeleton mt-2.5 block h-3 w-[62%]" />
        </div>
      ))}
    </div>
  );
}
