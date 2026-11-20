"use client";

/**
 * 一段同事对话：开着就读，伙伴在答时每 FAST_FREQUENCY 读一次，否则 20 秒；切到别的标签页时不读。
 * 句子数变了（打开、来了新的、自己发了）记成读到最新，并告诉左栏和主线重读（COLLEAGUE_CHATS_CHANGED）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TChatView } from "@warmap/contracts";
import { COLLEAGUE_CHATS_CHANGED, markChatRead, readChat } from "@/lib/home/colleagueChats";
import { FAST_FREQUENCY } from "./PartnerTeam";

const FREQUENCY = 20_000;

export function useColleagueChat(side: "with" | "from", personId: string) {
  const [chat, setChat] = useState<TChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const answering = !!chat?.messages.some((message) => message.answer === "answering");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try { setChat(await readChat(side, personId, controller.signal)); setError(null); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "没有读到这段对话"); }
    };
    void load();
    const timer = window.setInterval(load, answering ? FAST_FREQUENCY : FREQUENCY);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [side, personId, answering, retry]);

  const count = useRef<number | null>(null);
  useEffect(() => {
    if (!chat?.id || chat.messages.length === count.current) return;
    count.current = chat.messages.length;
    void markChatRead(chat.id).then(() => window.dispatchEvent(new Event(COLLEAGUE_CHATS_CHANGED)), () => undefined);
  }, [chat]);

  return { chat, error, setChat, reload: useCallback(() => setRetry((value) => value + 1), []) };
}
