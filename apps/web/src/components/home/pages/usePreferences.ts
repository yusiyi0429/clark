"use client";

/**
 * 偏好（设计 5.4.6「偏好」、11.3、13.1 第 2 条）的两样：
 * - 飞书通知：B 的 GET / PUT /api/me/notification-settings（{ feishu }，缺省开），存在服务端。改动乐观更新，没存上回到原值，原处「失败 · 重试」。
 * - 新 Task 默认的预算模式（自动 / 设预算 / 无上限，默认自动）：服务端还没有字段（要 B 加），先存在这台电脑上；换存法只换 BudgetStore。
 */
import { useCallback, useEffect, useState } from "react";
import type { TNotificationSettings } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

export type BudgetMode = "auto" | "budget" | "unlimited";
export const BUDGET_MODES: { id: BudgetMode; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "budget", label: "设预算" },
  { id: "unlimited", label: "无上限" },
];
export const DEFAULT_BUDGET_MODE: BudgetMode = "auto";
const MODES = new Set<string>(BUDGET_MODES.map((mode) => mode.id));
export const budgetModeOf = (raw: unknown): BudgetMode => (typeof raw === "string" && MODES.has(raw) ? raw as BudgetMode : DEFAULT_BUDGET_MODE);

export type BudgetStore = { read: () => BudgetMode; write: (mode: BudgetMode) => void };
const BUDGET_KEY = "tianshu-budget-default-v1";
/** 这台电脑上（过渡）：存不了照样用这一次。Task 管线开工时的分段可以用 readBudgetDefault 取默认值。 */
export const localBudgetStore: BudgetStore = {
  read: () => { try { return budgetModeOf(localStorage.getItem(BUDGET_KEY)); } catch { return DEFAULT_BUDGET_MODE; } },
  write: (mode) => { try { localStorage.setItem(BUDGET_KEY, mode); } catch { /* 存不了 */ } },
};
export const readBudgetDefault = () => localBudgetStore.read();

/** 新 Task 默认的预算模式：ready 前是默认值（读本机要等挂上以后，免得和服务端画的不一样）。 */
export function useBudgetDefault(store: BudgetStore = localBudgetStore) {
  const [mode, setMode] = useState<BudgetMode>(DEFAULT_BUDGET_MODE);
  useEffect(() => { setMode(store.read()); }, [store]);
  const set = useCallback((next: BudgetMode) => { setMode(next); store.write(next); }, [store]);
  return { mode, set };
}

export type NotifyApi = {
  read: () => Promise<TNotificationSettings>;
  write: (next: TNotificationSettings) => Promise<TNotificationSettings>;
};
/** B 的接口（生成的客户端：getNotificationSettings、updateNotificationSettings）。 */
export const notifyApi: NotifyApi = {
  read: async () => {
    const { data, error } = await browserApi.GET("/api/me/notification-settings");
    if (!data) throw new Error(error?.message ?? "没读到");
    return data;
  },
  write: async (next) => {
    const { data, error } = await browserApi.PUT("/api/me/notification-settings", { body: next });
    if (!data) throw new Error(error?.message ?? "没存上");
    return data;
  },
};

export type Failure = { reason: string; retry: () => void };

/** 飞书通知：feishu 为 null 是还在读；loadFailed 是没读到；saveFailed 是刚才那次没存上（已经回到原值）。 */
export function useNotificationSettings(api: NotifyApi = notifyApi) {
  const [feishu, setFeishu] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState<Failure | null>(null);
  const [saveFailed, setSaveFailed] = useState<Failure | null>(null);
  const load = useCallback(() => {
    setLoadFailed(null);
    void api.read().then((value) => setFeishu(value.feishu))
      .catch((error: unknown) => setLoadFailed({ reason: error instanceof Error ? error.message : "", retry: load }));
  }, [api]);
  useEffect(load, [load]);
  const set = useCallback((next: boolean) => {
    const before = feishu;
    setFeishu(next);
    setSaveFailed(null);
    void api.write({ feishu: next }).then((value) => setFeishu(value.feishu)).catch((error: unknown) => {
      setFeishu(before);
      setSaveFailed({ reason: error instanceof Error ? error.message : "", retry: () => set(next) });
    });
  }, [api, feishu]);
  return { feishu, loadFailed, saveFailed, set };
}
