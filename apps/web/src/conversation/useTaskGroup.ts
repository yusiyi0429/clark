"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";

type Thread = components["schemas"]["ThreadView"];

/** 事项详情可见期间轮询公开线程；只有群组频道可见时标记已读。 */
export function useTaskGroup(taskId: string | undefined, visible: boolean) {
  const [view, setView] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [left, setLeft] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    let loading = false;
    setView(null); setLeft(false);
    const load = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const { data, response } = await browserApi.GET("/api/threads/{objectType}/{objectId}", { params: { path: { objectType: "task", objectId: taskId } } });
        if (!active) return;
        if (!data) {
          if (response.status === 403 || response.status === 404) { setLeft(true); setView(null); }
          else setError("事项群组暂时无法读取，请稍后重试。");
          return;
        }
        setView(data); setLeft(false); setError(null);
        const highest = Math.max(0, ...data.messages.map((message) => message.id));
        if (visibleRef.current && highest > data.lastReadId) {
          const read = await browserApi.POST("/api/threads/{objectType}/{objectId}/read", { params: { path: { objectType: "task", objectId: taskId } }, body: { lastReadId: highest } });
          if (active && read.data) setView((current) => current ? { ...current, ...read.data } : current);
        }
      } catch { if (active) setError("事项群组暂时无法读取，请稍后重试。"); }
      finally { loading = false; }
    };
    reload.current = load;
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    const resume = () => { void load(); };
    document.addEventListener("visibilitychange", resume);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [taskId]);

  useEffect(() => { if (visible) void reload.current(); }, [visible]);
  const send = useCallback(async (content: string): Promise<boolean> => {
    if (!taskId || left) return false;
    setSending(true); setError(null);
    try {
      const { data, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/messages", { params: { path: { objectType: "task", objectId: taskId } }, body: { content } });
      if (!data) { setError(failure?.message ?? "没发出去，输入已保留。"); return false; }
      await reload.current();
      return true;
    } catch { setError("没发出去，输入已保留。"); return false; }
    finally { setSending(false); }
  }, [taskId, left]);
  return { view, error, sending, left, send };
}
