import type { CSSProperties } from "react";
import s from "./foundation.module.css";

// 从天枢沿斗身，再沿斗柄向摇光；保持紧凑、安静的品牌记号。
const stars = [[83, 8], [88, 25], [65, 29], [58, 14], [40, 10], [24, 15], [8, 27]];

export function OnboardingProgress({ current, total, complete = false }: { current: number; total: number; complete?: boolean }) {
  return <div className={s.progress} role="status" aria-live="polite">
    <span className={s.srOnly}>{`第 ${current} 步，共 ${total} 步`}</span>
    {complete ? <svg className={s.constellation} width="96" height="36" viewBox="0 0 96 36" aria-hidden="true">
      <path d="M83 8 88 25 65 29 58 14 83 8 M58 14 40 10 24 15 8 27" />
      {stars.map(([cx, cy], index) => <circle key={index} cx={cx} cy={cy} r="2.5" style={{ "--star-order": index } as CSSProperties} />)}
    </svg> : <div className={s.dots} aria-hidden="true">{Array.from({ length: total }, (_, index) =>
      <span key={index} data-current={current === index + 1} data-past={current > index + 1} />)}</div>}
  </div>;
}
