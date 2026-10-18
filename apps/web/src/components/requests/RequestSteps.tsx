"use client";

import { Check } from "lucide-react";
import type { TRequestStep } from "@warmap/contracts";
import s from "./requests.module.css";

/**
 * Agent 多步处理的步骤（参照 GitHub Actions 的步骤列表）：做完打勾、当前那一步呼吸点高亮、没开始置灰；
 * 某一步有了结果就写在它下面。圆点沿用对话进度行的呼吸节奏。另一条工作流的通用 StepList 合并后替换这里。
 */
export function RequestSteps({ steps, label }: { steps: TRequestStep[]; label: string }) {
  return (
    <ol className={s.steps} aria-label={label}>
      {steps.map((step) => (
        <li key={step.label} className={s.step} data-status={step.status} aria-current={step.status === "current" ? "step" : undefined}>
          <span className={s.stepIcon} aria-hidden="true">{step.status === "done" ? <Check size={12} strokeWidth={3} /> : null}</span>
          <span className={s.stepText}>
            <span>{step.label}</span>
            {step.result ? <small>{step.result}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 等服务端回来之前：前 done 步已做完（如卡上提问时「定位待办」），下一步进行中，其余置灰。 */
export function runningSteps(labels: string[], done = 0): TRequestStep[] {
  return labels.map((label, index) => ({ label, status: index < done ? "done" : index === done ? "current" : "pending", result: null }));
}
