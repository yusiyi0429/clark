"use client";

/**
 * 「偏好」二级页（设计 17.2）：外观（跟随系统 / 浅色 / 深色）、飞书推送、新 Task 的缺省预算。都存在服务端，点了就存。
 * 版式和控件照「连接」页（v2-local 的分段、开关），不加说明文字；没存成在原处写「失败 · 重试」。
 */
import { useEffect, useState } from "react";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { useAppearance, type Appearance } from "@/lib/appearance";
import { readNotificationSettings, saveNotificationSettings } from "@/lib/board/cloud";
import { DefaultBudget } from "./TaskBudget";
import s from "@/styles/v2-local.module.css";

const APPEARANCES: { id: Appearance; label: string }[] = [{ id: "system", label: "跟随系统" }, { id: "light", label: "浅色" }, { id: "dark", label: "深色" }];

export function Preferences() {
  const [appearance, setAppearance] = useAppearance();
  const [appearanceFailed, setAppearanceFailed] = useState<Failure | null>(null);
  const [feishu, setFeishu] = useState<boolean | null>(null);
  const [feishuFailed, setFeishuFailed] = useState<Failure | null>(null);
  useEffect(() => {
    let alive = true;
    void readNotificationSettings().then((found) => { if (alive) setFeishu(found?.feishu ?? true); }, () => { if (alive) setFeishu(true); });
    return () => { alive = false; };
  }, []);
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
      <section className={s.section} aria-label="外观" data-testid="pref-appearance">
        <p className={s.lab}>外观</p>
        <SegmentedSwitch label="外观" segments={APPEARANCES} selected={appearance} onSelect={pick} />
        {appearanceFailed ? <FailedLine inline {...appearanceFailed} /> : null}
      </section>
      <section className={s.section} aria-label="通知" data-testid="pref-notify">
        <p className={s.lab}>通知</p>
        {feishu !== null ? (
          <label className={s.toggle}>
            <input type="checkbox" checked={feishu} onChange={(event) => toggleFeishu(event.target.checked)} />
            <span>飞书推送</span>
          </label>
        ) : null}
        {feishuFailed ? <FailedLine inline {...feishuFailed} /> : null}
      </section>
      <section className={s.section} aria-label="缺省预算" data-testid="pref-budget">
        <p className={s.lab}>缺省预算</p>
        <DefaultBudget />
      </section>
    </>
  );
}
