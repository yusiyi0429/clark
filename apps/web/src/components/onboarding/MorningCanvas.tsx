import type { CSSProperties } from "react";
import s from "./foundation.module.css";

/** 首屏就有的晨光；只移动光的位置，不改变页面的布局。 */
export function MorningCanvas({ progress = 0, className = "" }: { progress?: number; className?: string }) {
  return <div className={`${s.canvas} ${className}`} style={{ "--morning-progress": progress } as CSSProperties} aria-hidden="true" data-morning-canvas>
    <div className={s.lightPosition}><div className={s.blueLight} /><div className={s.cyanLight} /></div>
  </div>;
}
