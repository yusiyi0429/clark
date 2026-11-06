"use client";

/** 看一个本机会话的实时事件：接上事件流（断了自己带 Last-Event-ID 重连），折成 SessionView。 */
import { useEffect, useState } from "react";
import type { LocalRunner } from "./runner";
import { EMPTY_VIEW, foldEvent, type SessionView } from "./sessionView";

export function useSessionEvents(runner: LocalRunner, sessionId: string | null): { view: SessionView; linked: boolean } {
  const [state, setState] = useState<{ id: string | null; view: SessionView; linked: boolean }>({ id: null, view: EMPTY_VIEW, linked: false });
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    setState({ id: sessionId, view: EMPTY_VIEW, linked: false });
    void runner.watch(sessionId, {
      after: 0,
      signal: controller.signal,
      onLink: (linked) => setState((current) => current.id === sessionId ? { ...current, linked } : current),
      onEvent: (event) => setState((current) => current.id === sessionId ? { ...current, view: foldEvent(current.view, event) } : current),
    });
    return () => controller.abort();
  }, [runner, sessionId]);
  return state.id === sessionId ? { view: state.view, linked: state.linked } : { view: EMPTY_VIEW, linked: false };
}
