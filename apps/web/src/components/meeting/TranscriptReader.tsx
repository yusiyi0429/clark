"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingTranscriptPage } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { transcriptTurnAnchorId } from "@/cards/meetingSources";
import { flashElement, scrollToElement } from "./readingScroll";
import r from "./transcriptReader.module.css";
import { useDots } from "@/lib/home/noEllipsis";

/**
 * 逐字稿按发言阅读：一行一段（说话人、时间、正文），按页取（GET /api/meetings/:id/transcript），滚到底接着取。
 * focusTurnId（出处 `transcript:<会>#<段>`、`meetingAction=transcript&turn=`）：取到那一段为止，滚过去并闪一下。
 */

type Turn = TMeetingTranscriptPage["turns"][number];
type ReaderState = { turns: Turn[]; nextTurn: string | null; status: "loading" | "ready" | "error" };

function clock(iso: string | null): string {
  const date = iso ? new Date(iso) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE }) : "";
}

export function TranscriptReader({ meetingId, focusTurnId }: { meetingId: string; focusTurnId: string | null }) {
  const dots = useDots();
  const [state, setState] = useState<ReaderState>({ turns: [], nextTurn: null, status: "loading" });
  const listRef = useRef<HTMLOListElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const loading = useRef(false);
  const focused = useRef<string | null>(null);

  /** from 为 null 是第一页；之后每页接在后面。同一时间只取一页。 */
  async function load(from: string | null) {
    if (loading.current) return;
    loading.current = true;
    try {
      const { data, response } = await browserApi.GET("/api/meetings/{id}/transcript", { params: { path: { id: meetingId }, query: from ? { from } : {} } });
      if (!response.ok || !data) throw new Error(String(response.status));
      setState((current) => ({ turns: from ? [...current.turns, ...data.turns] : data.turns, nextTurn: data.nextTurn, status: "ready" }));
    } catch {
      setState((current) => ({ ...current, status: "error" }));
    } finally {
      loading.current = false;
    }
  }

  useEffect(() => {
    void load(null);
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 要定位的那一段还没取到就接着取；取到了滚过去闪一下（每个 focusTurnId 只定位一次）。
  useEffect(() => {
    if (!focusTurnId || focused.current === focusTurnId || state.status !== "ready") return;
    if (!state.turns.some((turn) => turn.id === focusTurnId)) {
      if (state.nextTurn) void load(state.nextTurn);
      return;
    }
    const element = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(transcriptTurnAnchorId(focusTurnId))}`);
    if (!element) return;
    focused.current = focusTurnId;
    scrollToElement(element);
    flashElement(element);
  }, [focusTurnId, state]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚到底（末尾那条线进入视口）就取下一页。
  useEffect(() => {
    const end = endRef.current;
    const next = state.nextTurn;
    if (!end || !next || state.status !== "ready" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(next);
    }, { rootMargin: "0px 0px 400px 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [state.nextTurn, state.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={r.reader}>
      {state.turns.length ? (
        <ol ref={listRef} className={r.turns}>
          {state.turns.map((turn) => (
            <li key={turn.id} id={transcriptTurnAnchorId(turn.id)} className={r.turn}>
              <span className={r.speaker}>{turn.speakerName}</span>
              <time className={r.time} dateTime={turn.startedAt ?? undefined}>{clock(turn.startedAt)}</time>
              <p className={r.text}>{turn.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {state.status === "loading" ? <p className={r.status} aria-busy="true">{dots("读取中…")}</p> : null}
      {state.status === "error" ? (
        <p className={r.status} role="alert">
          没有读到逐字稿
          <button type="button" className={r.retry} onClick={() => void load(state.turns.length ? state.nextTurn : null)}>重试</button>
        </p>
      ) : null}
      {state.nextTurn && state.status === "ready" ? <div ref={endRef} className={r.end} aria-hidden="true" /> : null}
    </div>
  );
}
