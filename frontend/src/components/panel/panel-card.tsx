"use client";

import type { ActionItem } from "@/lib/data/types";
import styles from "./panel.module.css";

/**
 * 面板 feed 里的一张卡 —— 一件会后归了一号位自己的 action item。
 *
 * 照原型 `cardHTML`（`tianshu-dynamic-panel.html` 450-462 行）的骨架搬。原型卡片上
 * 那颗主动作 pill（`.c-act` / `.pill`）曾经整段没搬——右栏那一版只解决「装什么」，
 * 一颗按下去会改数据的键不该先长出来。这条规则现在只对**普通执行项**成立：
 * `principal.needed` 为 true 且还没 `decidedAt` 的那些不是任务，是等他表态的会议
 * 决策，一号位当面要求它必须能就地确认或修改，所以这一种卡片下方长出「确认」
 * 「修改」两颗键（见下方 `.cardActions`）；拍过板之后（`decidedAt` 有值）就退回
 * 普通卡的样子。要不要给其余的 action item 也配主动作，仍然留给以后。
 *
 * 整张卡是一个真正的 `<button type="button">`，不是套了 `onClick` 的 `<div>`：这是
 * 右栏这一版**唯一**能进详情层（sheet）的入口，没有第二条路，所以键盘必须够得着——
 * `<div onClick>` 对着 Tab 键是不可见的。下方那两颗键是它的兄弟节点、不是子节点：
 * `<button>` 不能嵌 `<button>`。
 */
export function PanelCard({
  item,
  isNew,
  onOpen,
  onConfirm,
  onEdit,
  confirming,
}: {
  item: ActionItem;
  /** 新进场的那一张，播 `.isNew`（原型 `.card.new`）那段入场动画。 */
  isNew?: boolean;
  onOpen: (id: string) => void;
  /** 「确认」——只有还没拍板的决策卡（`principal.needed && !decidedAt`）会渲染这颗键，才会被调用。 */
  onConfirm?: (item: ActionItem) => void;
  /** 「修改」——同上。 */
  onEdit?: (item: ActionItem) => void;
  /** 这条正在确认中：按钮换文案、禁用重复点击。 */
  confirming?: boolean;
}) {
  // `decidedAt` 一旦有值，这条已经拍过板了——即便 `principal.needed` 还是 true
  // （那是 A7 提炼时判的性质，事后不改），这张卡也已经不是「等他表态」的那一种，
  // 两颗键要跟着收起来，否则确认过后卡片停在原地看起来像是白点了一下。
  const isDecision = item.principal.needed && !item.decidedAt;
  return (
    <div className={isDecision ? `${styles.cardUnit} ${styles.cardDecision}` : styles.cardUnit}>
      <button
        type="button"
        className={isNew ? `${styles.card} ${styles.isNew}` : styles.card}
        // 浏览器里 <button> 的默认 text-align 是 center（原型这里用的是 <div>，
        // 没有这个问题）。卡片内部靠 flex 摆位，不靠文本居中，这里显式改回来，
        // 免得标题、摘要这些多行文字被居中，panel.module.css 不该为了一次
        // 元素替换去照顾这种浏览器默认值。
        style={{ textAlign: "left" }}
        onClick={() => onOpen(item.id)}
      >
        {/*
         * 这一版右栏只装 action item 一种东西，图标恒是「任」—— 照原型 KIND_G 的口径，
         * 一个字认出卡片属于哪一类（纪要「纪」、信号「信」……，任务是「任」）。data-k
         * 属性照样带上完整的「任务」两个字：这不是一处装饰，`.c-ic[data-k="任务"]`
         * 那条渐变色选择器认的就是这个属性值，万一将来这一栏混进别的种类，颜色已经
         * 按 data-k 分好了，不用回来再补。
         */}
        <div className={styles.cIc} data-k="任务">
          任
        </div>
        <div className={styles.cBody}>
          <div className={styles.cTop}>
            {/* 只说「任务」，不带 issueId：默认不在这块面板上提议题——
                这件事归哪个议题/mission，只在真有必要说清楚时才由天枢提一句，这里不是那种情况。 */}
            <span className={styles.cKind}>任务</span>
            <span className={styles.cTime}>{item.slotLabel}</span>
          </div>
          <div className={styles.cTitle}>{item.text}</div>
          {/*
           * 副标题曾经是这件事的出处——那件议题的标题。一号位当面要求这块面板不许
           * 再提议题，这里不合适把它接回来：他要看的是这件事本身，不是它挂在哪个
           * 议题/mission 下面——默认仍然不提，只在真有必要时才提一句，而副标题这个
           * 位置说的正是「它挂在哪里」，不是「这条内容本身」。现在这里换成会后摘要，
           * 一行截断——理由同原来，长短不可控，规格要求停在一行，这条截断规则不属于
           * `.cSum` 类名本身，所以就地内联。
           */}
          <div
            className={styles.cSum}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.debriefSummary}
          </div>
        </div>
      </button>
      {isDecision ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.cardActionConfirm}
            disabled={confirming}
            onClick={() => onConfirm?.(item)}
          >
            {confirming ? "确认中…" : "确认"}
          </button>
          <button type="button" className={styles.cardActionEdit} onClick={() => onEdit?.(item)}>
            修改
          </button>
        </div>
      ) : null}
    </div>
  );
}
