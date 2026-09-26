import type { CSSProperties } from "react";
import s from "@/styles/context-mark.module.css";

export type ContextMarkKind = "issue" | "signal" | "monthly" | "meeting";

/** 工作区的对象标记：三个色块区分议题 / 信号 / 月度 / 会议（clark 同一份几何）。 */
export function ContextMark({ kind, className = "", style }: { kind: ContextMarkKind; className?: string; style?: CSSProperties }) {
  return (
    <span className={`${s.mark} ${s[kind]} ${className}`} style={style} data-context-mark={kind} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
