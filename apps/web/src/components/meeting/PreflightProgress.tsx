"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { TPreflightProgress } from "@warmap/contracts";
import s from "@/styles/meeting-workspace.module.css";

/**
 * 会前预审的过程（v4）：每一步由服务端按实际步骤写入（读了哪份材料、对照了哪场会、查了哪一节企业知识、
 * 判断到第几道待决题、形成了哪条结论），页面每两秒取一次；刷新或离开再回来，从库里接着显示。
 * 运行中整段展开；完成或失败后收成一行「预审过程 · 用时 · 几步」，可点开看每一步的时间点。
 */

/** 「1 分 05 秒」「42 秒」。 */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

/** 一步相对开始的时间点：「0:04」「2:15」。 */
export function offsetText(startedAt: string, at: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function StepList({ progress }: { progress: TPreflightProgress }) {
  return (
    <ol className={s.progressList}>
      {progress.steps.map((step) => (
        <li key={step.key} className={s.progressStep} data-state={step.state} data-kind={step.kind}>
          <span className={s.progressTime}>{offsetText(progress.startedAt, step.at)}</span>
          <span className={s.progressMark} aria-hidden="true">
            {step.state === "active" ? <Loader2 size={12} /> : <Check size={12} />}
          </span>
          <span className={s.progressText}>
            {step.label}
            {step.detail ? <small>{step.detail}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PreflightProgress({ progress, status }: { progress: TPreflightProgress | undefined; status: "pending" | "running" | "ready" | "failed" }) {
  const running = status === "running";
  const now = useNow(running);
  if (!progress || !progress.steps.length) return null;
  const end = progress.finishedAt ? Date.parse(progress.finishedAt) : running ? now : Date.parse(progress.updatedAt);
  const elapsed = durationText(end - Date.parse(progress.startedAt));
  if (running && !progress.finishedAt) {
    const active = [...progress.steps].reverse().find((step) => step.state === "active");
    return (
      <section className={s.progressPanel} aria-label="预审进度" aria-live="polite">
        <header className={s.progressHead}>
          <small>预审进度</small>
          <span>已用 {elapsed} · {progress.steps.filter((step) => step.state === "done").length} 步已完成</span>
        </header>
        {active ? <p className={s.progressNow}>{active.label}</p> : null}
        {progress.thought ? <p className={s.progressThought}><small>思考要点</small>{progress.thought}</p> : null}
        <StepList progress={progress} />
      </section>
    );
  }
  return (
    <details className={s.progressRecord}>
      <summary>预审过程 · 用时 {elapsed} · {progress.steps.length} 步</summary>
      <StepList progress={progress} />
    </details>
  );
}
