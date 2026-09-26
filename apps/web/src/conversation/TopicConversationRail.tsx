"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ChevronRight, MessageCircle, Sparkles, X } from "lucide-react";
import { AttachmentStatus, SessionTools } from "./SessionTools";
import { ConversationNotice, ConversationThinking, ConversationTurns } from "./Transcript";
import type { ConversationData } from "./useConversation";
import r from "@/styles/topic-conversation-rail.module.css";

/**
 * 二级页右侧对话列（clark `TopicConversationRail`）：围绕同一对象，只有「天枢」一个频道
 * （同事频道在天枢没有后端，不放）。共享输入条由外壳移进这一列底部。
 * ≤759px 收成右下角「对话」按钮，展开时焦点在对话列与输入条之间循环，Escape 收回。
 */
export function TopicConversationRail({
  data,
  label,
  mobileOpen,
  onMobileOpen,
  composerHeight = 56,
}: {
  data: ConversationData;
  label: string;
  mobileOpen: boolean;
  onMobileOpen: (open: boolean) => void;
  composerHeight?: number;
}) {
  const end = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width:759px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [data.messages, data.streaming]);
  useEffect(() => {
    if (mobileOpen) close.current?.focus({ preventScroll: true });
  }, [mobileOpen]);
  useEffect(() => {
    if (!mobileOpen || !narrow) return;
    function containFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const selector = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';
      const candidates = [
        ...(rail.current?.querySelectorAll<HTMLElement>(selector) ?? []),
        ...document.querySelectorAll<HTMLElement>(selector.split(", ").map((part) => `[data-testid="global-controls"] ${part}`).join(", ")),
      ].filter((element) => element.getClientRects().length && !element.closest('[inert], [aria-hidden="true"]'));
      const first = candidates[0];
      const last = candidates.at(-1);
      if (event.shiftKey && (document.activeElement === first || !candidates.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !candidates.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", containFocus);
    return () => document.removeEventListener("keydown", containFocus);
  }, [mobileOpen, narrow]);

  function closeMobile() {
    onMobileOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  return (
    <>
      {!mobileOpen ? (
        <Button ref={trigger} className={r.mobileTrigger} variant="secondary" onPress={() => onMobileOpen(true)} aria-label="展开议题对话">
          <MessageCircle size={17} />
          对话
        </Button>
      ) : (
        <button type="button" className={r.mobileVeil} onClick={closeMobile} aria-label="收起议题对话" />
      )}
      <aside
        ref={rail}
        className={r.rail}
        role={narrow && mobileOpen ? "dialog" : undefined}
        aria-modal={narrow && mobileOpen ? true : undefined}
        data-testid="topic-conversation-rail"
        data-mobile-open={mobileOpen}
        data-channel="agent"
        data-tone="light"
        aria-label="当前议题对话"
        onKeyDown={(event) => {
          if (event.key === "Escape" && mobileOpen && !event.defaultPrevented) {
            event.stopPropagation();
            event.preventDefault();
            closeMobile();
          }
        }}
      >
        <header className={r.header}>
          <div className={r.tabs} aria-label="选择对话对象">
            <Button variant="secondary" aria-pressed>
              <Sparkles size={16} />
              天枢
            </Button>
          </div>
          <div className={r.tools}>
            <SessionTools data={data} tone="light" />
          </div>
          <Button ref={close} isIconOnly variant="tertiary" onPress={closeMobile} aria-label="收起议题对话">
            <X size={18} />
          </Button>
        </header>
        <p className={r.context}>{label}</p>
        <div className={r.agent} style={{ paddingBottom: composerHeight + 28 }}>
          <AttachmentStatus data={data} className={r.error} />
          <div className={r.agentLog} role="log" aria-label="与天枢的议题对话" aria-live="polite" aria-relevant="additions text">
            {data.messages.length ? (
              <ConversationTurns messages={data.messages} />
            ) : !data.streaming ? (
              <div className={r.agentEmpty}>
                <Sparkles size={27} strokeWidth={1.3} />
                <h2>先一起想一想。</h2>
                <p>资料就在左侧。你的判断、疑问和讨论，都留在这件事里。</p>
                <Button className={r.agentPrompt} variant="tertiary" onPress={() => void data.send("这件事为什么值得现在研究？还有哪些关键问题需要弄清楚？", [])}>
                  这件事，最值得先弄清什么
                  <ChevronRight size={15} />
                </Button>
              </div>
            ) : null}
            {data.error && !data.streaming ? <ConversationNotice text={data.error} /> : null}
            {data.streaming ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} /> : null}
            <div ref={end} />
          </div>
        </div>
      </aside>
    </>
  );
}
