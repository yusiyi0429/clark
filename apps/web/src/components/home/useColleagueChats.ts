"use client";

/**
 * 左栏对话两组：20 秒读一次；窗口回到前台、对话变了（COLLEAGUE_CHATS_CHANGED）、伙伴说同事对话要重读时各读一次。
 * 切到别的标签页时不读；读不到时留着上一次的。
 */
import { useEffect, useRef, useState } from "react";
import type { TChatListResponse } from "@warmap/contracts";
import { useBuddyUi } from "@/lib/buddy/uiEvent";
import { COLLEAGUE_CHATS_CHANGED, listChats } from "@/lib/home/colleagueChats";

const FREQUENCY = 20_000;

export function useColleagueChats(): TChatListResponse | null {
  const [list, setList] = useState<TChatListResponse | null>(null);
  const reload = useRef<() => void>(() => undefined);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try { setList(await listChats(controller.signal)); } catch { /* 留着上一次的 */ }
    };
    reload.current = () => void load();
    void load();
    const timer = window.setInterval(load, FREQUENCY);
    const events = ["focus", COLLEAGUE_CHATS_CHANGED];
    events.forEach((event) => window.addEventListener(event, load));
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort(); window.clearInterval(timer);
      events.forEach((event) => window.removeEventListener(event, load)); document.removeEventListener("visibilitychange", load);
    };
  }, []);

  useBuddyUi((effect) => { if (effect.kind === "refresh" && effect.what.includes("colleague_chats")) reload.current(); });
  return list;
}
