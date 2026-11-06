/**
 * 状态图标（新首页设计 5.4.2「状态图标」，树、事件行、开工后的几步共用）：
 * 进行中（含验收中、重做中）LoaderCircle 1.1 秒一圈 · 等你 8px 强调色实心圆 · 已排队 Circle · 已完成 Check ·
 * 失败（程序层面）X 危险色 · 已停止（你停的）Square。图标带 aria-label，内容就是状态词；减少动态效果时转圈不转。
 */
import { Check, Circle, LoaderCircle, Square, X } from "lucide-react";
import h from "@/styles/home.module.css";

export type IconState = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
const LABEL: Record<IconState, string> = { queued: "已排队", running: "进行中", waiting: "等你", done: "已完成", failed: "失败", stopped: "已停止" };
export const ICON = { size: 16, strokeWidth: 1.8, "aria-hidden": true } as const;

export function StateIcon({ state, label }: { state: IconState; label?: string }) {
  return (
    <span className={h.state} data-state={state} role="img" aria-label={label ?? LABEL[state]}>
      {state === "running" ? <LoaderCircle {...ICON} /> : state === "waiting" ? <i /> : state === "done" ? <Check {...ICON} />
        : state === "failed" ? <X {...ICON} /> : state === "stopped" ? <Square {...ICON} /> : <Circle {...ICON} />}
    </span>
  );
}
