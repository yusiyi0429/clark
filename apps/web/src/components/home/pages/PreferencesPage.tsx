"use client";

/**
 * 偏好（个人菜单「偏好」，设计 5.4.6、11.3、13.1、13.2）：两块，不写说明句。
 * - 新 Task：默认的预算模式，分段「自动 / 设预算 / 无上限」（SegmentedSwitch 的 doc 档），默认自动；Task 管线开工时的分段从这里取默认值（readBudgetDefault）。
 * - 通知：一行开关「飞书通知」，缺省开（B 的 /api/me/notification-settings）。改了马上变，没存上回到原值，原处「失败 · 重试」。
 */
import type { ReactNode } from "react";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine } from "@/components/work/DecisionBox";
import type { SecondaryPageProps } from "./index";
import { Loading, Row, Section, SwitchRow } from "./parts";
import { BUDGET_MODES, useBudgetDefault, useNotificationSettings, type BudgetMode, type Failure } from "./usePreferences";
import p from "@/styles/home-pages.module.css";

export function PreferencesPage(_props: SecondaryPageProps) {
  const budget = useBudgetDefault();
  const notify = useNotificationSettings();
  return <PreferencesView budgetMode={budget.mode} onBudget={budget.set} feishu={notify.feishu} onFeishu={notify.set} loadFailed={notify.loadFailed} saveFailed={notify.saveFailed} />;
}

/** 画出来的样子（不读不存）。feishu 为 null 是还在读。 */
export function PreferencesView({ budgetMode, onBudget, feishu, onFeishu, loadFailed, saveFailed }: {
  budgetMode: BudgetMode;
  onBudget: (mode: BudgetMode) => void;
  feishu: boolean | null;
  onFeishu: (next: boolean) => void;
  loadFailed: Failure | null;
  saveFailed: Failure | null;
}) {
  let notify: ReactNode;
  if (loadFailed) notify = <FailedLine reason={loadFailed.reason} onRetry={loadFailed.retry} />;
  else if (feishu === null) notify = <Loading />;
  else notify = <>
    <ul className={p.rows}><SwitchRow name="飞书通知" checked={feishu} onChange={onFeishu} testId="feishu-notify" /></ul>
    {saveFailed ? <FailedLine reason={saveFailed.reason} onRetry={saveFailed.retry} /> : null}
  </>;
  return (
    <>
      <Section title="新 Task" testId="budget-section">
        <ul className={p.rows}>
          <Row name="预算模式" action={<SegmentedSwitch label="新 Task 默认的预算模式" segments={BUDGET_MODES} selected={budgetMode} onSelect={onBudget} />} />
        </ul>
      </Section>
      <Section title="通知" testId="notify-section">{notify}</Section>
    </>
  );
}
