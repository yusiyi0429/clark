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

/** 和服务端同一条规矩：去掉首尾空白后 1–12 个字。 */
export function buddyNameValid(name: string): boolean {
  const length = name.trim().length;
  return length >= 1 && length <= 12;
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
