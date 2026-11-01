"use client";

/**
 * 本人的伙伴（spec 5.5「选择你的伙伴」）：本人起的名字和选的那颗横放胶囊，存在服务端、跟着人走。
 * 保存后发 `buddy-changed`，同一页里读伙伴的地方（对话窗标题、右列胶囊）跟着重读。
 */

import { useEffect, useState } from "react";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { readStoredSkin } from "@/components/coagent/skin";

export type Buddy = components["schemas"]["Buddy"];

const CHANGED = "buddy-changed";

/** 伙伴名字最多占多宽：6 个汉字、12 个窄字母，或混着写（Miles 胶囊按这个上限封顶）。 */
export const BUDDY_NAME_UNITS = 12;

const narrowChar = (char: string) => /^[a-ln-vx-z0-9 .,\-_']$/.test(char);

/**
 * 和服务端（apps/api buddy.ts）同一条规矩：去掉首尾空白后，小写字母（m、w 除外）、数字、空格和 . , - _ ' 算 1，
 * 其余（汉字、全角、大写字母、m、w、别的符号）算 2。
 */
export function buddyNameUnits(name: string): number {
  let units = 0;
  for (const char of name.trim()) units += narrowChar(char) ? 1 : 2;
  return units;
}

export function buddyNameValid(name: string): boolean {
  const units = buddyNameUnits(name);
  return units >= 1 && units <= BUDDY_NAME_UNITS;
}

/** 输入框里超宽的部分打不进去：从头数到放不下为止（首尾空白也算宽，宁紧勿松）。 */
export function clampBuddyName(name: string): string {
  let units = 0;
  let kept = "";
  for (const char of name) {
    units += narrowChar(char) ? 1 : 2;
    if (units > BUDDY_NAME_UNITS) break;
    kept += char;
  }
  return kept;
}

/** 选伙伴时的初始值：有伙伴就用；没有时名字空着等本人起，样子停在这台电脑上原来选过的那颗胶囊。 */
export function initialBuddyDraft(stored: Buddy | null): Buddy {
  return stored ?? { name: "", form: readStoredSkin() };
}

export async function saveBuddy(next: Buddy): Promise<Buddy> {
  const { data, error } = await browserApi.PUT("/api/me/buddy", { body: { name: next.name.trim(), form: next.form } });
  if (!data) throw new Error(error?.message ?? "未保存，请重试。");
  window.dispatchEvent(new Event(CHANGED));
  return data;
}

export function useBuddy(): { buddy: Buddy | null; loading: boolean } {
  const [buddy, setBuddy] = useState<Buddy | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = () => {
      void browserApi.GET("/api/me/buddy").then(({ data }) => {
        if (!active) return;
        setBuddy(data ?? null);
        setLoading(false);
      }).catch(() => { if (active) setLoading(false); });
    };
    load();
    window.addEventListener(CHANGED, load);
    return () => { active = false; window.removeEventListener(CHANGED, load); };
  }, []);
  return { buddy, loading };
}
