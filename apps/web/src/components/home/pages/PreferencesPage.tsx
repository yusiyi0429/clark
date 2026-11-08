"use client";

/**
 * 偏好（个人菜单「偏好」，设计 5.4.6、17.2、17.4）：外观（跟随系统 / 浅色 / 深色）、通知（飞书推送）、新 Task 的缺省预算、
 * 伙伴代我做事（和伙伴做过的事）、回收站。都存在服务端，点了就存；没存成在原处写「失败 · 重试」，不写说明句。
 * 伙伴改了设置（ui refresh settings）时重读飞书推送。
 */
import { useEffect, useState } from "react";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { useAppearance, type Appearance } from "@/lib/appearance";
import { readNotificationSettings, saveNotificationSettings } from "@/lib/board/cloud";
import { useBuddyUi } from "@/lib/buddy/uiEvent";
import { BuddyAuthoritySection, TrashSection } from "../BuddyAuthority";
import { DefaultBudget } from "../TaskBudget";
import type { SecondaryPageProps } from "./index";
import { Row, Section, SwitchRow } from "./parts";
import p from "@/styles/home-pages.module.css";

const APPEARANCES: { id: Appearance; label: string }[] = [{ id: "system", label: "跟随系统" }, { id: "light", label: "浅色" }, { id: "dark", label: "深色" }];

export function PreferencesPage(_props: SecondaryPageProps) {
  const [appearance, setAppearance] = useAppearance();
  const [appearanceFailed, setAppearanceFailed] = useState<Failure | null>(null);
  const [feishu, setFeishu] = useState<boolean | null>(null);
  const [feishuFailed, setFeishuFailed] = useState<Failure | null>(null);
  const [settingsTick, setSettingsTick] = useState(0);
  useBuddyUi((effect) => { if (effect.kind === "refresh" && effect.what.includes("settings")) setSettingsTick((n) => n + 1); });
  useEffect(() => {
    let alive = true;
    void readNotificationSettings().then((found) => { if (alive) setFeishu(found?.feishu ?? true); }, () => { if (alive) setFeishu(true); });
    return () => { alive = false; };
  }, [settingsTick]);
  const pick = (next: Appearance) => {
    setAppearanceFailed(null);
    void setAppearance(next).catch((error: unknown) => setAppearanceFailed(failureOf(error, () => pick(next))));
  };
  const toggleFeishu = (next: boolean) => {
    setFeishuFailed(null);
    setFeishu(next);
    void saveNotificationSettings(next).catch((error: unknown) => { setFeishu(!next); setFeishuFailed(failureOf(error, () => toggleFeishu(next))); });
  };
  return (
    <>
      <Section title="外观" testId="pref-appearance">
        <div className={p.field}><SegmentedSwitch label="外观" segments={APPEARANCES} selected={appearance} onSelect={pick} /></div>
        {appearanceFailed ? <FailedLine {...appearanceFailed} /> : null}
      </Section>
      <Section title="通知" testId="pref-notify">
        {feishu !== null ? <ul className={p.rows}><SwitchRow name="飞书推送" checked={feishu} onChange={toggleFeishu} testId="feishu-notify" /></ul> : null}
        {feishuFailed ? <FailedLine {...feishuFailed} /> : null}
      </Section>
      <Section title="新 Task" testId="pref-budget">
        <ul className={p.rows}><Row name="缺省预算" action={<DefaultBudget />} /></ul>
      </Section>
      <BuddyAuthoritySection />
      <TrashSection />
    </>
  );
}
