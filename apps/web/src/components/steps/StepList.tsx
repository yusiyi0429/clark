import { Check, Minus } from "lucide-react";
import s from "./step-list.module.css";

export type StepStatus = "done" | "active" | "pending" | "stopped";
export type Step = { id: string; label: string; status: StepStatus; result?: string };

/**
 * Agent 处理时的步骤（已定设计第 6 节第 2 条）：纯展示。
 * 做完的打勾，当前的高亮，没开始的置灰；某一步有结果就直接跟在后面。只用图标、状态色和短标签表达，不加说明句。
 * 排在对话进度行之下，和阶段文字对齐，字号与颜色都比正文低一级，不抢正文。
 */
export function StepList({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ol className={s.list} data-testid="step-list">
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

/** 正文开始后步骤收起：进度行里只留一个勾和做完的步数。 */
export function StepCount({ steps }: { steps: Step[] }) {
  const done = steps.filter((step) => step.status === "done").length;
  if (!done) return null;
  return (
    <span className={s.count} data-testid="step-count" aria-label={`已完成 ${done} 步`}>
      <Check size={11} strokeWidth={2.4} aria-hidden />{done}
    </span>
  );
}
