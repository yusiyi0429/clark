"use client";

import { cn } from "@/lib/utils";
import type { DomainSummary } from "@/lib/data/types";

/**
 * 业务域选择器 —— 首页左下那一列。
 *
 * ## 它不是一块内容，是右边那份清单的**筛子**
 *
 * 上一版把它做成了一块完整的卡片：白面、一圈发丝线、一条 header 写着「业务域」、
 * 每格两行（编号 + 名字 + 数字，第二行 DRI）。八个域就是八块两行的东西加一个标题，
 * 一屏上它的体量和右边那份真正要读的清单差不多 —— 而它承载的信息只有一件：
 * **右边现在看的是哪个域。** 一个筛子占了跟被筛的东西一样多的注意力。
 *
 * 所以这一版拆掉的是：面、标题、编号、DRI。
 *
 *   面和标题  没有面就没有「这是另一块内容」。「业务域」三个字留给读屏
 *             （`aria-label`）—— 一号位看得见的是八块生意的名字，那八个名字自己
 *             就说明了这是什么，标题是给不认识这家公司的人写的。
 *   编号      `D3` 这种代号在他脑子里没有对应物，他记的是名字。而它排在名字左边，
 *             每一行的第一个字都是他不读的东西。
 *   DRI       域的负责人跟「看哪个域的议题」这个动作无关。真要找人是在议题里找
 *             （那件事的承接人），不是在筛子上。
 *
 * ## 弱，但要能看出它管着右边
 *
 * 未选中的域是**光秃的字**：没有面、没有边、没有彩色，一行一个名字加一个右对齐的
 * 灰数字。
 *
 * 选中的那一个换成**和右边议题清单里的块一模一样的东西**：纸色一块、没有环、
 * 同一个 8px 圆角（`.list-block`）。这是唯一用来表达关联的手段，也够了 —— 屏幕上
 * 出现了两处同一种物件，一处在左边孤零零一块，一处在右边摞成一叠，眼睛自己会把它们
 * 连起来。上一版靠一道彩色竖条指着当前项，那是在说「看这里」；换成同物件之后说的是
 * 「这一块和那一叠是一回事」，后者才是真的关系。
 *
 * 那圈发丝线环是 2026-08-26 去掉的，两边一起：右边那半屏原来是一块 `.card`（白面、
 * 一圈线），现在换成和这一列同一块凹底，块于是只靠「比底亮一档」站住 —— 亮度差已经
 * 画出了边界，再补一圈线是同一条边界画两遍。理由整段写在 `.list-block` 上。
 *
 * 8px 也不是挑出来的：整列坐在一块 `--r: 1rem`、内边距 `0.5rem` 的底上，同心公式
 * （`.concentric`）算出来内圆角正好 8px —— 右边议题板用的是同一个 `--r`、同一个
 * 内边距、同一条公式。两边的圆角不是「调成一样」，是**同一个算式的同一个结果**。
 *
 * ## 那块底
 *
 * 上一版连底都没有：九个灰名字直接摊在桌面上，右边那列数字又因为「0 不显示」几乎全空，
 * 于是一屏上它不是一列目录，是九个飘着的词 —— 弱化弱到把「这是一个东西」也弱掉了。
 *
 * 补的不是面，是**底**（`--list-ground`，往桌面里凹一档；那段写了为什么它在深色下
 * 换成黑）。底只做两件事：给这一列一个轮廓，让它成为一列；以及把选中那块白面托起来 ——
 * 白比底亮，抬升是算出来的，不用影子。加一圈边或者换成 `.card` 都会让它变回「另一块
 * 内容」，那正是这一版拆掉的东西。
 *
 * 每一格右边那个数字是这个域此刻**等他动**的量。口径由调用方给（议题数 / 上会数），
 * 形状必须一致。
 */
export function DomainNav({
  label,
  domains,
  activeId,
  onPick,
  countOf,
}: {
  /** 这一列的名字。**只给读屏**，不画在屏幕上。 */
  label: string;
  domains: DomainSummary[];
  activeId: string | null;
  onPick: (id: string) => void;
  /** 这一格右边那个数。返回 0 就不显示 —— 「0 件」在一号位眼里是一次没有内容的打扰。 */
  countOf?: (domain: DomainSummary) => number;
}) {
  /*
   * 这一节**没有 `flex-1`**：底贴着内容收，不撑到左栏底部。撑满的话八个域下面会拖出
   * 一大片空凹槽，那就从「一列筛子」变成「一块空面板」了。域多到一屏装不下时，
   * `min-h-0` 让这一节自己压缩、里面滚。
   */
  return (
    <section aria-label={label} className="flex min-h-0 flex-col">
      {/* `p-2` 不是留白：它是同心圆角公式里的 `--p`（配 `--r: 1rem` 得到里面那些块的
          8px），同时让凹底在选中那一块四周露出一圈 —— 那一圈底就是这一块的边界，
          底被那一块顶到边上的话，「它浮在底上」这句话就没地方说了。 */}
      <div className="scroll-slim min-h-0 space-y-px overflow-y-auto rounded-2xl bg-list-ground p-2 [--p:0.5rem] [--r:1rem]">
        {domains.map((d) => {
          const active = d.id === activeId;
          const count = countOf ? countOf(d) : d.openIssues;
          return (
            <button
              key={d.id}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(d.id)}
              className={cn(
                /*
                 * 选中态**换物件，不换高度**。两个状态的内边距、字号、行高全一样，
                 * 点来点去这一列不会自己抖 —— 变的只有「有没有那一圈边和那块白面」。
                 *
                 * 未选中项的 hover 走 `.row-link` 那一档（3.5% 的墨色填充，理由写在
                 * 那段上）。选中项不给 hover：它已经是当前的了，鼠标压上去再变一次
                 * 是在说「按我还能得到什么」，而按它什么都不会发生。
                 *
                 * 时长写成 `duration-[var(--dur-fast)]`：`duration-fast` 那个类
                 * 编译出来是空的（Tailwind v4 的 `duration-*` 认 `--transition-duration-*`，
                 * 这套 token 叫 `--dur-*`），全站上百处都在这么写，实际吃默认的 150ms。
                 */
                "concentric relative block w-full px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)]",
                // `.list-block` 自己就带纸色了，不用再补 `bg-surface`。
                active ? "list-block" : "row-link text-ink-muted hover:text-ink",
              )}
            >
              <span className="flex items-baseline gap-2">
                {/* `min-w-0` 是给 `truncate` 用的：flex 子项的 min-width 默认是 auto，
                    不清零的话名字长的那个域会把右边那个数字顶出去。 */}
                <span className={cn("min-w-0 truncate text-sm", active && "font-medium text-ink")}>
                  {d.name}
                </span>
                {count > 0 && (
                  <span
                    className={cn(
                      "meta ml-auto shrink-0 tabular-nums",
                      active ? "text-ink-muted" : "text-ink-faint",
                    )}
                  >
                    {count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
