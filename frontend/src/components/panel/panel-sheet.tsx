"use client";

import { useState, type ReactElement } from "react";
import type { ActionItem } from "@/lib/data/types";
import styles from "./panel.module.css";

/**
 * 面板的详情层（sheet）。原型给了两种：`PanelSheet` 照 `sheetHTML` + `itemBodyHTML` +
 * `relatedHTML`（`tianshu-dynamic-panel.html` 498-540 行），`TranscriptSheet` 照
 * `transcriptHTML`（516-521 行）。`MeetingDetailSheet` 是相三加的第三种，原型没有
 * 对应页面——一号位那侧的会议卡改成纯展示之后，点开要有地方看这场会的详情。
 *
 * **这里只有 DOM 和类名，没有「哪一层在最上面、旧的怎么退场」这件事。** 原型里「只有
 * 一层」是靠给旧 sheet 加 `recede`、420ms 后摘掉来做的，那是一段跨时间的状态机
 * （现在开着哪一层、正在退场的是哪一层），这份状态天然属于持有它的那个组件——
 * 也就是 `dynamic-panel.tsx`（Task G），不属于这两个纯展示组件。这里如果自己再维护
 * 一份「上一层是谁」，就会和 G 手里那份状态出现两个真相源，谁赢谁输说不清。
 */

/**
 * `.sheet` 根节点上要放的公共 props：`className` 不在跨组契约里，是这里加的一个
 * 逃生舱口。契约把 `in` / `recede` 定成了两个跟 `sheet` 同级、需要**同一个节点**
 * 同时具备的类名（`panel.module.css` 里 `.sheet.in` / `.sheet.recede` 是复合选择器，
 * 不是祖先选择器），但 `PanelSheet` / `TranscriptSheet` 的签名里没有一个「现在是
 * 进场还是退场」的参数——那个状态在 G 那边，不在这两个组件里。所以这里默认拼上
 * `styles.sheet`，谁都不传也能单独长成完整的一张 sheet；G 需要叠加 `in` / `recede`
 * 时，只要多传一个 `className`（会跟 `styles.sheet` 拼在一起，不是替换掉它）。
 */
type SheetShellProps = { className?: string };

function sheetClassName({ className }: SheetShellProps): string {
  return className ? `${styles.sheet} ${className}` : styles.sheet;
}

/**
 * 一件 action item 的详情。
 *
 * 普通执行项没有主动作 pill，理由和 `PanelCard` 一样：这一版还没定右栏该开放哪些
 * 写操作，原型 `itemBodyHTML` 里那段 `纪要`/`action` 专属的按钮区（`.sh-acts`）
 * 整段不搬。**决策卡是例外**——`initialEditing`/`onSaveText` 这一对就是它的入口：
 * `PanelCard` 的「修改」把这个 sheet 直接打开到编辑态（见 `dynamic-panel.tsx`），
 * 这里只负责编辑框本身，不决定「谁能编辑」。
 *
 * **这里不认议题。** 原来这一节是「它想到的」——同一场会的其他 action item，外加
 * 来源议题那一行。一号位当面撤了这个设计，这里不合适把它接回来：他要的是只看当前
 * 这件事，不是被牵去认一整份关系图。默认仍然不提议题/mission，真有必要时天枢会
 * 提一句，但「同一场会还有哪些别的事」不是那种必要——这一节现在只有 `judgement`
 * （`principal.reason`）一样东西——天枢对这件事本身的判断，不牵出别的对象。
 */
export function PanelSheet({
  item,
  judgement,
  onClose,
  className,
  initialEditing,
  onSaveText,
}: {
  /** 正在看的那一件。 */
  item: ActionItem;
  /** 天枢对这件决策的判断（`principal.reason`）。没有就不显示这一节——不编一句话顶上。 */
  judgement?: string;
  onClose: () => void;
  /** 打开时直接进编辑态——`PanelCard` 的「修改」按下去那一刻为 true。 */
  initialEditing?: boolean;
  /** 保存新措辞。没有这个 prop 就不画编辑框，即便 `initialEditing` 传了 true。 */
  onSaveText?: (text: string) => Promise<void>;
} & SheetShellProps): ReactElement {
  const [editing, setEditing] = useState(Boolean(onSaveText && initialEditing));
  const [draft, setDraft] = useState(item.text);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    if (!onSaveText) return;
    const text = draft.trim();
    if (!text || text === item.text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveText(text);
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "没有保存成功，请再试一次。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={sheetClassName({ className })}
      // sheet 不锁全屏：顶上还留着一条 feed，那条本身也能点（原型「实时层穿透
      // sheet」的前提）。`aria-modal="false"` 照实说明这一点——写成 true 会让读屏
      // 软件把 feed 那部分从可达范围里摘掉，而这里恰恰要它留着。
      role="dialog"
      aria-modal="false"
      aria-label={`${item.text} 的详情`}
    >
      <div className={styles.shHead}>
        <span className={styles.shChip}>任务</span>
        <span className={styles.shSp} />
        <button
          type="button"
          className={styles.shBtn}
          aria-label="关闭"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={styles.shBody}>
        {editing && onSaveText ? (
          <div>
            <textarea
              className={styles.shEditInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              autoFocus
            />
            {saveError ? <p className={styles.shEditError}>{saveError}</p> : null}
            <div className={styles.shEditActions}>
              <button
                type="button"
                className={styles.shEditSave}
                disabled={saving || draft.trim().length === 0}
                onClick={() => void handleSave()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                className={styles.shEditCancel}
                onClick={() => {
                  setDraft(item.text);
                  setSaveError(null);
                  setEditing(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.shTitle}>{item.text}</div>
        )}
        <div className={styles.shMeta}>
          {item.due ? `${item.slotLabel} · ${item.due} 之前` : item.slotLabel}
        </div>
        <p className={styles.shP}>{item.debriefSummary}</p>
        {judgement ? (
          <section className={styles.resident}>
            <div className={styles.resH}>
              <i aria-hidden="true" />
              天枢的判断
            </div>
            <p className={styles.shP}>{judgement}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 对话记录那一层。原型 `id==='transcript'` 时走的就是这条内容。
 */
export function TranscriptSheet({
  turns,
  onClose,
  className,
}: {
  turns: { role: "user" | "agent"; text: string }[];
  onClose: () => void;
} & SheetShellProps): ReactElement {
  return (
    <div
      className={sheetClassName({ className })}
      role="dialog"
      aria-modal="false"
      aria-label="对话记录"
    >
      <div className={styles.shHead}>
        <span className={styles.shSp} />
        <button
          type="button"
          className={styles.shBtn}
          aria-label="关闭"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={styles.shBody}>
        <div className={styles.shTitle}>对话记录</div>
        {turns.length === 0 ? (
          <p className={styles.shP}>还没有对话。点底部那颗键开始。</p>
        ) : (
          // `tr`/`m` 同上面 `.rel` 内部的 k/t/s，一样要走 `styles` 对象——原因见那边
          // 的注释：CSS Modules 哈希的是文件里的每一个类选择器，不看它嵌套得有多深，
          // 裸字符串在这份样式表里永远连不上。
          <div className={styles.tr}>
            {turns.map((turn, i) => (
              // 这份记录只会在末尾追加、不会重排或删除中间项，用下标当 key 不会
              // 引发错位；转写本身也没有更稳定的天然 id 可用（契约里的类型就是
              // `{role, text}`，没有 id 字段）。
              <div key={i} className={`${styles.m} ${turn.role === "user" ? styles.user : styles.agent}`}>
                <small>{turn.role === "user" ? "你" : "天枢"}</small>
                {turn.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 一条已确认的判断，或者一条 Agent 还没请他确认的判断——两节共用的一行形状。 */
type MeetingSheetJudgement = { issueId: string; issueTitle: string; label?: string; statement: string };

/**
 * 一号位点开的会议详情。**两节，都是真数据，取不到就照实说没有。**
 *
 * `loading` 由 `dynamic-panel.tsx` 统一给一个总的——两节的数据是并着取的同一批
 * 请求，拆成两个各自的 loading 只会让两节先后跳出来，反而不像「一次问完」。
 */
export function MeetingDetailSheet({
  slotLabel,
  attending,
  issueCount,
  confirmed,
  keyPoints,
  loading,
  onClose,
  className,
}: {
  slotLabel: string;
  attending: string[];
  issueCount: number;
  confirmed: MeetingSheetJudgement[];
  keyPoints: MeetingSheetJudgement[];
  loading: boolean;
  onClose: () => void;
} & SheetShellProps): ReactElement {
  return (
    <div
      className={sheetClassName({ className })}
      role="dialog"
      aria-modal="false"
      aria-label={`${slotLabel}的会议详情`}
    >
      <div className={styles.shHead}>
        <span className={styles.shChip}>会议</span>
        <span className={styles.shSp} />
        <button type="button" className={styles.shBtn} aria-label="关闭" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={styles.shBody}>
        <div className={styles.shTitle}>{slotLabel}</div>
        <div className={styles.shMeta}>
          {attending.length > 0 ? `${attending.join(" · ")} · ` : ""}
          {issueCount} 件
        </div>

        <MeetingSheetSection
          title="已确认的判断"
          loading={loading}
          rows={confirmed}
          empty="这几件议题目前没有已经确认的判断。"
        />
        <MeetingSheetSection
          title="Agent 认为需要讨论的"
          loading={loading}
          rows={keyPoints}
          empty="这几件议题目前没有还待确认的判断。"
        />
      </div>
    </div>
  );
}

function MeetingSheetSection({
  title,
  loading,
  rows,
  empty,
}: {
  title: string;
  loading: boolean;
  rows: MeetingSheetJudgement[];
  empty: string;
}) {
  return (
    <section className={styles.resident}>
      <div className={styles.resH}>
        <i aria-hidden="true" />
        {title}
      </div>
      {loading ? (
        <div className={styles.thinking}>在读…</div>
      ) : rows.length > 0 ? (
        rows.map((r, i) => (
          <div key={`${r.issueId}-${i}`} className={`${styles.rel} ${styles.relStatic}`}>
            <div>
              <div className={styles.t}>{r.label ?? r.statement}</div>
              <div className={styles.s}>
                {r.issueId} · {r.issueTitle}
                {r.label ? ` · ${r.statement}` : ""}
              </div>
            </div>
          </div>
        ))
      ) : (
        <p className={styles.shP}>{empty}</p>
      )}
    </section>
  );
}
