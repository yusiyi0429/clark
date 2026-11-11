"use client";

/**
 * 看一个本机会话的实时事件：接上事件流（断了自己带 Last-Event-ID 重连），折成 SessionView。
 * drafts：要「正在写」的草稿（子会话页）。草稿不进 SessionView、不占编号：单独一个小状态，一帧只写一次（同伙伴对话）；
 * 那一段的 assistant_text 到了就清掉草稿、换成真的，那条的编号记进 drafted（它已经一个字一个字出过了，不再整段淡入）。
 */
import { useEffect, useRef, useState } from "react";
import type { LocalRunner } from "./runner";
import { EMPTY_VIEW, foldEvent, type SessionView } from "./sessionView";

const NO_DRAFTED: ReadonlySet<number> = new Set();

export function useSessionEvents(runner: LocalRunner, sessionId: string | null, { drafts = false }: { drafts?: boolean } = {}): { view: SessionView; linked: boolean; draft: string | null; drafted: ReadonlySet<number> } {
  const [state, setState] = useState<{ id: string | null; view: SessionView; linked: boolean; draft: string | null; drafted: ReadonlySet<number> }>({ id: null, view: EMPTY_VIEW, linked: false, draft: null, drafted: NO_DRAFTED });
  /** 这一帧里最后到的草稿（undefined = 没有要写的）和排着的那一帧。 */
  const pending = useRef<string | undefined>(undefined);
  const frame = useRef(0);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const forget = () => { if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; pending.current = undefined; };
    setState({ id: sessionId, view: EMPTY_VIEW, linked: false, draft: null, drafted: NO_DRAFTED });
    void runner.watch(sessionId, {
      after: 0,
      signal: controller.signal,
      onLink: (linked) => setState((current) => current.id === sessionId ? { ...current, linked } : current),
      onEvent: (event) => {
        // 这一段写完了：草稿换成真的（同一次重画里，不闪）。
        if (event.type === "assistant_text") forget();
        setState((current) => {
          if (current.id !== sessionId) return current;
          const view = foldEvent(current.view, event);
          if (event.type !== "assistant_text" || current.draft === null) return { ...current, view };
          return { ...current, view, draft: null, drafted: new Set([...current.drafted, event.seq]) };
        });
      },
      ...(drafts ? {
        onDraft: (draft: { sessionId: string; text: string }) => {
          if (draft.sessionId !== sessionId) return;
          pending.current = draft.text;
          if (frame.current) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            const text = pending.current;
            pending.current = undefined;
            if (text === undefined) return;
            setState((current) => current.id === sessionId ? { ...current, draft: text || null } : current);
          });
        },
      } : {}),
    });
    return () => { controller.abort(); forget(); };
  }, [runner, sessionId, drafts]);
  return state.id === sessionId ? { view: state.view, linked: state.linked, draft: state.draft, drafted: state.drafted } : { view: EMPTY_VIEW, linked: false, draft: null, drafted: NO_DRAFTED };
}
