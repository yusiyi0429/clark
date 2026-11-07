"use client";

/**
 * Task 详情里「预算」那一行（设计 11.3：「Task 详情里一行能改」）：自动 · 设预算 · 无上限。
 * 读 GET /api/me/tasks/:taskId/budget（没单独设过时是本人在「偏好」里的缺省，小字「沿用偏好」），改了 PUT 回去。
 * 自动、无上限点了就存；设预算填时长、本周额度百分比，点「存」才存，一项都没填对时停在输入框上。没存成在原处写「失败 · 重试」。
 */
import { useEffect, useRef, useState } from "react";
import type { TBudget, TBudgetMode } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { readTaskBudget, saveTaskBudget } from "@/lib/board/cloud";
import { MODES, budgetOf, limitsOf, type Limits } from "./PlanDecision";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";

export function TaskBudget({ taskId }: { taskId: string }) {
  const [mode, setMode] = useState<TBudgetMode | null>(null);
  const [limits, setLimits] = useState<Limits>({ hours: "", percent: "", money: "" });
  const [inherited, setInherited] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const hoursRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    void readTaskBudget(taskId).then((found) => {
      if (!alive) return;
      setMode(found?.budget.mode ?? "auto");
      if (found) { setLimits(limitsOf(found.budget)); setInherited(found.inherited); }
    }, () => { if (alive) setMode("auto"); });
    return () => { alive = false; };
  }, [taskId]);
  if (!mode) return null;
  const save = async (budget: TBudget) => {
    setBusy(true);
    setFailed(null);
    try { await saveTaskBudget(taskId, budget); setInherited(false); }
    catch (error) { setFailed(failureOf(error, () => void save(budget))); }
    finally { setBusy(false); }
  };
  const pick = (next: TBudgetMode) => {
    setMode(next);
    if (next === "set") { requestAnimationFrame(() => hoursRef.current?.focus()); return; }
    void save({ mode: next, hours: null, weeklyPercent: null, money: null });
  };
  const store = () => {
    const budget = budgetOf("set", limits);
    if (!budget) { hoursRef.current?.focus(); return; }
    void save(budget);
  };
  return (
    <div className={x.mode} data-testid="task-budget">
      <SegmentedSwitch label="预算" segments={MODES} selected={mode} onSelect={pick} />
      {mode === "set" ? (
        <span className={x.limits}>
          <label><input ref={hoursRef} inputMode="decimal" value={limits.hours} aria-label="时长上限（小时）" onChange={(event) => setLimits({ ...limits, hours: event.target.value })} />小时</label>
          <label><input inputMode="numeric" value={limits.percent} aria-label="本周额度上限（百分比）" onChange={(event) => setLimits({ ...limits, percent: event.target.value })} />% 本周额度</label>
          <HeroButton variant="tertiary" size="sm" isDisabled={busy} onPress={store}>存</HeroButton>
        </span>
      ) : null}
      {inherited && !failed ? <span className={h.faint}>沿用偏好</span> : null}
      {failed ? <FailedLine inline {...failed} /> : null}
    </div>
  );
}
