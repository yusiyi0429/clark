"use client";

/**
 * 卡的详情（GET /api/me/cards/:id）：卡、交代、完成标准、最近 5 次本机执行、交回和验收、产出。前台时 10 秒重取一次。
 * 卡的接口还没有（404）时退回执行事项详情（GET /api/me/tasks/:id），卡的那几样为空。
 */
import { useCallback, useEffect, useState } from "react";
import type { TCardDetailResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { readCard } from "@/lib/board/cloud";
import type { CardItem } from "@/lib/board/cards";

export type CardDetail = Omit<TCardDetailResponse, "task"> & { task: CardItem; fallback: boolean };

export function useCardDetail(cardId: string) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await readCard(cardId);
      if (data) { setDetail({ ...data, fallback: false }); return; }
      const { data: task, response } = await browserApi.GET("/api/me/tasks/{id}", { params: { path: { id: cardId } } });
      if (response.status === 404) { setMissing(true); return; }
      if (task) {
        const standards = (task.task.doneDefinition ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
        setDetail({ task: task.task, letter: null, brief: null, standards, runs: [], handbacks: [], outputs: [], fallback: true });
      }
    } catch { /* 断网时留着上次的 */ }
  }, [cardId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return { detail, missing, refresh: load };
}
