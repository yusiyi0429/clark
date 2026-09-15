"use client";

import type { ShowcaseItem } from "./fixtures";
import { KIND_GLYPH, KIND_LABEL } from "./fixtures";
import styles from "@/components/panel/panel.module.css";

export function ShowcaseSheet({
  item,
  onClose,
  className,
}: {
  item: ShowcaseItem;
  onClose: () => void;
  /** S1 挂 in/recede 这类进出场类名用；不归这个组件管，只负责接住并拼进根节点。 */
  className?: string;
}) {
  return (
    <div
      className={className ? `${styles.sheet} ${className}` : styles.sheet}
      role="dialog"
      aria-modal="false"
      aria-label={`${item.title} 的详情`}
    >
      <div className={styles.shHead}>
        <span className={styles.shChip}>
          {KIND_GLYPH[item.kind]} {KIND_LABEL[item.kind]}
        </span>
        <span className={styles.shSp} />
        <button type="button" className={styles.shBtn} aria-label="关闭" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={styles.shBody}>
        <div className={styles.shTitle}>{item.title}</div>
        <div className={styles.shMeta}>
          {item.time} · {item.from}
        </div>
        {item.body.map((p, i) => (
          <p key={i} className={styles.shP}>
            {p}
          </p>
        ))}

        {item.detailHref ? (
          // 出口，不是「它想到的」里的一条：单独一个满宽按钮，字面写清楚去哪。
          <a
            href={item.detailHref}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginTop: 6,
              padding: "13px 16px",
              borderRadius: 16,
              background: "linear-gradient(135deg, #4cc9f0, #2a8fd8)",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14.5,
              textDecoration: "none",
            }}
          >
            查看此议题的详细报告
            <span aria-hidden="true">→</span>
          </a>
        ) : null}

        <section className={styles.resident}>
          <div className={styles.resH}>
            <i aria-hidden="true" />
            它想到的
          </div>
          {item.related.length > 0 ? (
            item.related.map((r, i) => (
              <div key={i} className={`${styles.rel} ${styles.relStatic}`}>
                <span className={styles.k}>{r.kind}</span>
                <div>
                  <div className={styles.t}>{r.title}</div>
                  <div className={styles.s}>{r.why}</div>
                </div>
              </div>
            ))
          ) : (
            <p className={styles.shP}>暂时没想到相关的。</p>
          )}
        </section>
      </div>
    </div>
  );
}
