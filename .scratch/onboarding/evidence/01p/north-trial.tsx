import type { CSSProperties } from "react";
import s from "./foundation.module.css";

// 从天枢沿斗身，再沿斗柄向摇光；保持紧凑、安静的品牌记号。
const stars = [[125, 13], [133, 41], [97, 48], [86, 24], [60, 18], [35, 27], [11, 48]];

export function OnboardingProgress({ current, total, complete = false }: { current: number; total: number; complete?: boolean }) {
  return <div className={s.progress} role="status" aria-live="polite">
    <span className={s.srOnly}>{`第 ${current} 步，共 ${total} 步`}</span>
    {complete ? <svg className={s.constellation} width="144" height="60" viewBox="0 0 144 60" aria-hidden="true">
      <path d="M125 13 133 41 97 48 86 24 125 13 M86 24 60 18 35 27 11 48" />
      {stars.map(([cx, cy], index) => <circle key={index} cx={cx} cy={cy} r="2.5" style={{ "--star-order": index } as CSSProperties} />)}
    </svg> : <div className={s.dots} aria-hidden="true">{Array.from({ length: total }, (_, index) =>
      <span key={index} data-current={current === index + 1} data-past={current > index + 1} />)}</div>}
  </div>;
}
