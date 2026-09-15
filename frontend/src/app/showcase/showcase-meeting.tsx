"use client";

import styles from "@/components/panel/panel.module.css";
import type { ShowcaseMeeting } from "./fixtures";

/**
 * 会议卡 —— 中栏，纯展示。第几次讨论用力度区分，不是统一的灰标：首次是安静的一行字，
 * 到第三次及以后收成一枚实心深底的号，逼着眼睛先看见「这件事已经绕了好几圈」。
 */
export function ShowcaseMeetingCard({
  meeting,
  onOpen,
}: {
  meeting: ShowcaseMeeting;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="list-block row-link block w-full overflow-hidden rounded-2xl px-3.5 py-3 text-left"
      aria-label={`${meeting.when}的会议 · 查看详情`}
    >
      <header className="flex items-baseline gap-2 pb-2">
        <span className="shrink-0 text-sm font-medium text-ink">{meeting.when}</span>
        <span className="meta shrink-0 whitespace-nowrap text-ink-faint">
          {meeting.topics.length} 件
        </span>
      </header>
      <div className="space-y-1.5">
        {meeting.topics.map((topic) => (
          <p key={topic.ref} className="flex items-baseline gap-2">
            <span className="meta shrink-0 text-ink-faint">{topic.ref}</span>
            <span className="min-w-0 flex-1 truncate text-sm leading-relaxed text-ink">
              {topic.title}
            </span>
            <RoundBadge round={topic.round} />
          </p>
        ))}
      </div>
    </button>
  );
}

function RoundBadge({ round }: { round: number }) {
  if (round <= 1) {
    return <span className="meta shrink-0 whitespace-nowrap text-ink-faint">首次讨论</span>;
  }
  if (round === 2) {
    return (
      <span className="meta shrink-0 whitespace-nowrap rounded-full bg-neutral-wash px-2 py-0.5 text-ink-muted">
        第 2 次讨论
      </span>
    );
  }
  return (
    <span className="meta shrink-0 whitespace-nowrap rounded-full bg-ink px-2 py-0.5 font-medium text-surface">
      第 {round} 次讨论
    </span>
  );
}

/**
 * 会议详情 sheet —— 右栏，和 `panel.module.css` 的玻璃 sheet 共一套类名。
 * `className` 由外面（S1）拼 `in`/`recede`，这里只负责拼进 `styles.sheet`。
 *
 * 两节不是同一种东西：已确认的判断是定了的事，用 `--confirmed`（青绿）；
 * Agent 认为要谈的是还悬着的事，用 `--judgment`（琥珀）—— 两个语义色本来就是
 * 这套界面里「已定」和「待定」各自的嗓音，这里直接借，不再造一套新的。
 */
export function ShowcaseMeetingSheet({
  meeting,
  onClose,
  className,
}: {
  meeting: ShowcaseMeeting;
  onClose: () => void;
  className?: string;
}) {
  return (
    <div
      className={className ? `${styles.sheet} ${className}` : styles.sheet}
      role="dialog"
      aria-modal="false"
      aria-label={`${meeting.when}的会议详情`}
    >
      <div className={styles.shHead}>
        <span className={styles.shChip}>会议</span>
        <span className={styles.shSp} />
        <button type="button" className={styles.shBtn} aria-label="关闭" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={styles.shBody}>
        <div className={styles.shTitle}>{meeting.when}</div>
        <div className={styles.shMeta}>{meeting.topics.length} 件</div>

        <ShowcaseSheetSection
          title="已确认的判断"
          kind="已定"
          accent="var(--confirmed)"
          rows={meeting.confirmed}
          empty="这几件议题目前没有已经确认的判断。"
        />
        <ShowcaseSheetSection
          title="Agent 认为需要讨论的"
          kind="待议"
          accent="var(--judgment)"
          rows={meeting.toDiscuss}
          empty="这几件议题目前没有还待确认的判断。"
        />
      </div>
    </div>
  );
}

function ShowcaseSheetSection({
  title,
  kind,
  accent,
  rows,
  empty,
}: {
  title: string;
  kind: string;
  accent: string;
  rows: string[];
  empty: string;
}) {
  return (
    <section className={styles.resident}>
      <div className={styles.resH}>
        <i aria-hidden="true" style={{ background: accent, boxShadow: "none" }} />
        {title}
      </div>
      {rows.length > 0 ? (
        rows.map((text, i) => (
          <div key={i} className={`${styles.rel} ${styles.relStatic}`}>
            <span className={styles.k} style={{ color: accent }}>
              {kind}
            </span>
            <div>
              <div className={styles.t}>{text}</div>
            </div>
          </div>
        ))
      ) : (
        <p className={styles.shP}>{empty}</p>
      )}
    </section>
  );
}
