import { Check, Minus } from "lucide-react";
import s from "./step-list.module.css";

export type StepStatus = "done" | "active" | "pending" | "stopped";
export type Step = { id: string; label: string; status: StepStatus; result?: string };

/**
 * Agent 处理时的步骤（已定设计第 6 节第 2 条）：纯展示。
 * 做完的打勾，当前的高亮，没开始的置灰；某一步有结果就直接跟在后面。只用图标、状态色和短标签表达，不加说明句。
 * 排在对话进度行之下，和阶段文字对齐，字号与颜色都比正文低一级，不抢正文。
 */
export function StepList({ steps, className, id }: { steps: Step[]; className?: string; id?: string }) {
  if (!steps.length) return null;
  return (
    <ol id={id} className={className ? `${s.list} ${className}` : s.list} data-testid="step-list">
      {steps.map((step) => (
        <li key={step.id} className={s.step} data-status={step.status} aria-current={step.status === "active" ? "step" : undefined}>
          <span className={s.mark} aria-hidden>
            {step.status === "done" ? <Check size={11} strokeWidth={2.4} />
              : step.status === "stopped" ? <Minus size={11} strokeWidth={2.4} />
              : <i className={s.dot} />}
          </span>
          <span className={s.label}>{step.label}</span>
          {step.result ? <span className={s.result}>{step.result}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** 正文开始后步骤收起成「✓ N 步」，挂在这条回答的「用时」一行；点一下展开步骤列表。className 由宿主给（与同一行的其他开关同一样式）。 */
export function StepToggle({ steps, open, onToggle, className, controls }: { steps: Step[]; open: boolean; onToggle: () => void; className?: string; controls?: string }) {
  const done = steps.filter((step) => step.status === "done").length;
  if (!done) return null;
  return (
    <button type="button" className={className ? `${s.toggle} ${className}` : s.toggle} aria-expanded={open} aria-controls={open ? controls : undefined}
      onClick={onToggle} data-testid="step-toggle">
      <Check size={11} strokeWidth={2.4} aria-hidden />{done} 步
    </button>
  );
}
