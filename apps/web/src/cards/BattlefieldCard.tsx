"use client";

import { useLayoutEffect, useRef } from "react";
import { ArrowLeft, ArrowLeftRight, ChevronRight } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type BattlefieldPayload } from "./payloads";
import { useBattlefieldDisplay } from "./battlefieldDisplay";
import s from "@/styles/battlefield-card.module.css";

const URGENCY_DOT: Record<string, string> = { red: "#e34b43", yellow: "#c79624", gray: "#8e8e93" };

/** 正面确认目标与待决策 Issue；背面只展示真实待办与负责人反馈，不显示百分比。 */
export function BattlefieldCard({ card, onNavigate }: CardRenderProps) {
  const payload = payloadOf<BattlefieldPayload>(card);
  const display = useBattlefieldDisplay();
  const flipped = display.flipped(payload.battlefieldId);
  const frontFlip = useRef<HTMLButtonElement>(null);
  const backFlip = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);

  // 翻面只切展示面：焦点必须留在对应的控制上，不能留在已 inert 的背面。
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.current?.contains(active)) {
      (flipped ? backFlip : frontFlip).current?.focus({ preventScroll: true });
    }
  }, [flipped]);

  const urgent = payload.pendingIssues.filter((issue) => issue.urgency === "red").length;

  return (
    <article
      ref={root}
      className={s.frame}
      data-origin={payload.battlefieldId}
      data-testid={`zone-${payload.battlefieldId}`}
      data-mode={flipped ? "progress" : "decisions"}
    >
      <div className={s.rotor} data-flipped={flipped}>
        <div className={`${s.face} ${s.front}`} inert={flipped} aria-hidden={flipped}>
          <header className={s.header}>
            <h2 className={s.staticTitle}>{payload.name}</h2>
            <button
              ref={frontFlip}
              type="button"
              className={s.flip}
              onClick={() => display.flip(payload.battlefieldId)}
              aria-label={`查看${payload.name}进展`}
            >
              <ArrowLeftRight size={15} aria-hidden="true" />
              <span>进展</span>
            </button>
          </header>
          <div className={s.context}>
            <span className={s.contextOwner}>负责人 · {payload.ownerDisplayName || "待指派"}</span>
            {payload.sixMonthOutcome ? <p className={s.outcome}>六个月目标 · {payload.sixMonthOutcome}</p> : null}
          </div>
          {payload.pendingIssues.length ? (
            <ul className={s.list}>
              {payload.pendingIssues.map((issue) => (
                <li key={issue.id}>
                  <button type="button" className={s.listButton} onClick={() => onNavigate(`/issues/${issue.id}`)}>
                    <i className={s.dot} style={{ background: URGENCY_DOT[issue.urgency] }} aria-hidden="true" />
                    <span>{issue.title}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.missing}>暂无待决策议题</p>
          )}
        </div>

        <div className={`${s.face} ${s.back}`} inert={!flipped} aria-hidden={!flipped}>
          <div className={s.atmosphere} aria-hidden="true">
            <span />
            <span />
          </div>
          <header className={s.header}>
            <h2 className={s.staticTitle}>{payload.name}</h2>
            <button
              ref={backFlip}
              type="button"
              className={s.flip}
              onClick={() => display.flip(payload.battlefieldId)}
              aria-label={`返回${payload.name}待决策`}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>待决策</span>
              {urgent > 0 ? <span className={s.urgent} aria-label={`${urgent} 条紧急议题`}>{urgent}</span> : null}
            </button>
          </header>
          <div className={s.progressBody}>
            <div className={s.progressBlock}>
              <span className={s.chartEyebrow}>当月战场结果{payload.period ? ` · ${payload.period}` : ""}</span>
              {payload.target ? <p className={s.target}>{payload.target}</p> : <p className={s.missing}>尚未签发当月目标</p>}
            </div>
            <div className={s.progressBlock}>
              <span className={s.chartEyebrow}>普通待办</span>
              {payload.todos.length ? (
                <ul className={s.todoList}>
                  {payload.todos.map((todo) => (
                    <li key={todo.id}>
                      <span>{todo.title}</span>
                      <small>
                        {todo.dueAt ? `${todo.dueAt} · ` : ""}
                        {todo.exportStatus === "delivered" ? "已送达" : todo.exportStatus === "failed" ? "外发失败" : "待外发"}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={s.missing}>当月没有归属该战场的普通待办</p>
              )}
            </div>
            <div className={s.progressBlock}>
              <span className={s.chartEyebrow}>最新负责人反馈</span>
              {payload.latestFeedback ? (
                <p className={s.feedback}>
                  {payload.latestFeedback.text}
                  <small>采集于 {payload.latestFeedback.observedAt} · {payload.latestFeedback.sourceRef}</small>
                </p>
              ) : (
                <p className={s.missing}>尚未收到负责人反馈</p>
              )}
            </div>
            <p className={s.noPercent}>WarMap 不计算完成百分比，也不跟踪待办执行状态。</p>
          </div>
        </div>
      </div>
    </article>
  );
}
