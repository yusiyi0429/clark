"use client";

import { useCallback, useEffect, useState } from "react";

/** 议题内决定或会后确认写入成功后派发：历史分层跟着重读。 */
export const DECISION_HISTORY_CHANGED = "decision-history-changed";

export type DecisionHistoryState<T> = {
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
  reload: () => void;
};

/**
 * 读议题有效历史分层（GET /api/issues/:id/history、/api/meetings/:id/history）。
 * - 读取中、读到、失败三种状态分开，失败可重试；重读时保留上一份结果，不闪空。
 * - revision 变化（议题 / 会议 Card 版本变了）、Agent 在对话里改了业务、页面里决定成功后都重读，不靠本地拼状态。
 * url 为 null（成员只读、没有关联议题）时不发请求。
 */
export function useDecisionHistory<T>(url: string | null, revision: string): DecisionHistoryState<T> {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data: T | null; error: string | null }>({ status: "loading", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState((current) => (current.status === "error" ? { ...current, status: "loading" } : current));
    void (async () => {
      try {
        const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
        if (response.status === 401) {
          window.location.assign("/access");
          return;
        }
        if (!response.ok) throw new Error(response.status === 404 ? "没有找到这份历史" : "历史决定读取失败");
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setState({ status: "ready", data, error: null });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState((current) => ({ status: "error", data: current.data, error: (cause as Error).message || "历史决定读取失败" }));
      }
    })();
    return () => controller.abort();
  }, [url, revision, nonce]);

  useEffect(() => {
    if (!url) return;
    window.addEventListener("conversation-object-changed", reload);
    window.addEventListener(DECISION_HISTORY_CHANGED, reload);
    return () => {
      window.removeEventListener("conversation-object-changed", reload);
      window.removeEventListener(DECISION_HISTORY_CHANGED, reload);
    };
  }, [url, reload]);

  return { ...state, reload };
}
