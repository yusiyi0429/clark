"use client";

import type { ShowcaseItem } from "./fixtures";
import { KIND_GLYPH, KIND_LABEL } from "./fixtures";
import styles from "@/components/panel/panel.module.css";

// 顶档到底档的两端玻璃：顶档是深蓝玻璃（比 --dark-glass 更蓝更亮一档，
// 免得跟壁纸一样糊成近黑），底档就是卡片默认的浅玻璃（--glass）。中间按档位
// 线性插值，档位之间只挪深浅，不换色相，字色（白）在两端都读得清。
const DENSE = { r: 16, g: 40, b: 100, a: 0.62 };
const LIGHT = { r: 255, g: 255, b: 255, a: 0.13 };
// 契约的 KIND_ORDER 目前是 5 档（outcome/meeting/research/issue/signal），
// priority 0 对应最高档；卡片本身不关心这份表，只按跨组契约说好的“0 最深”走。
const MAX_TIER = 4;

function densityStyle(priority: number): { background: string; borderColor: string } {
  const t = Math.min(Math.max(priority, 0), MAX_TIER) / MAX_TIER;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const alpha = DENSE.a + (LIGHT.a - DENSE.a) * t;
  return {
    background: `rgba(${mix(DENSE.r, LIGHT.r)}, ${mix(DENSE.g, LIGHT.g)}, ${mix(DENSE.b, LIGHT.b)}, ${alpha.toFixed(2)})`,
    // 边框跟着一起变亮变暗，顶档的深玻璃配更亮的边框才勾得出轮廓。
    borderColor: `rgba(255, 255, 255, ${(0.3 - 0.14 * t).toFixed(2)})`,
  };
}

export function ShowcaseCard({
  item,
  priority,
  onOpen,
}: {
  item: ShowcaseItem;
  /** 0 = 最高优先档。底色随档位加深。 */
  priority: number;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={styles.card}
      style={{ textAlign: "left", ...densityStyle(priority) }}
      onClick={() => onOpen(item.id)}
    >
      <div className={styles.cIc}>{KIND_GLYPH[item.kind]}</div>
      <div className={styles.cBody}>
        <div className={styles.cTop}>
          <span>
            {/* 档位是这张卡的标题——比正文标题先读到，但字号仍压在它之下，
                不做成第二个大标题。 */}
            <span className={styles.cKind} style={{ fontWeight: 700, fontSize: 13, color: "var(--on-glass)" }}>
              {KIND_LABEL[item.kind]}
            </span>
            <span style={{ opacity: 0.7 }}> · {item.from}</span>
          </span>
          <span className={styles.cTime}>{item.time}</span>
        </div>
        <div className={styles.cTitle}>{item.title}</div>
        <div className={styles.cSum}>{item.summary}</div>
      </div>
    </button>
  );
}
