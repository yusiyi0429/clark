/**
 * 状态图标（新首页设计第 3 节左栏）：进行中是转圈，等你是强调色的小圆点，已排队是空心圈，已完成是淡色的勾，没过（失败）是叉。
 * 16px、线宽 1.5；转圈在「减少动态效果」时不转。
 */
import { Check, Circle, LoaderCircle, X } from "lucide-react";
import h from "@/styles/home.module.css";

export type IconState = "queued" | "running" | "waiting" | "done" | "failed";
const LABEL: Record<IconState, string> = { queued: "已排队", running: "进行中", waiting: "等你", done: "已完成", failed: "没过" };
const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export function StateIcon({ state }: { state: IconState }) {
  return (
    <span className={h.state} data-state={state} role="img" aria-label={LABEL[state]}>
      {state === "running" ? <LoaderCircle {...ICON} /> : state === "waiting" ? <i /> : state === "done" ? <Check {...ICON} /> : state === "failed" ? <X {...ICON} /> : <Circle {...ICON} />}
    </span>
  );
}
