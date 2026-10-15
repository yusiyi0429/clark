"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Card as HeroCard } from "@heroui/react";
import { ArrowLeft, ArrowLeftRight, ChevronRight, Crown } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type BattlefieldPayload, type MissionPayload } from "./payloads";
import { useBattlefieldDisplay } from "./battlefieldDisplay";
import { BattlefieldProgressPreview } from "./BattlefieldProgressPreview";
import { HeroButton } from "@/components/HeroButton";
import { IssueRow, meetingTimesByIssue } from "@/components/IssueRow";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { ReferenceButton } from "@/conversation/references";
import { monthDayTime } from "@/lib/companyTime";
import s from "@/styles/battlefield-card.module.css";
import b from "@/styles/home-board.module.css";

/**
 * 战场翻转卡（clark `progress-card.tsx` 的正反面与翻面焦点衔接）。
 * 正面：负责人、Mission、六个月目标（放在 clark「战场总结」那一格）与待决策议题；
 * 背面：进展（概念版三环）；MVP 先放示意图并盖磨砂蒙版写「建设中」，负责人反馈仍收在「反馈与依据」里。
 */
export function BattlefieldCard({ card, collection, onNavigate }: CardRenderProps) {
  const payload = payloadOf<BattlefieldPayload>(card);
  const id = payload.battlefieldId;
  const missions = collection.filter((item) => item.kind === "mission" && payloadOf<MissionPayload>(item).battlefieldIds.includes(id));
  const meetingTimes = useMemo(() => meetingTimesByIssue(collection), [collection]);
  // 战场卡的引用：本战场待决策议题的 Card（API 只接受议题 / 会议 / 月度计划 / Mission 作引用）。
  const issueCards = useMemo(() => {
    const byId = new Map(collection.filter((item) => item.kind === "issue").map((item) => [item.objectRef.id, item]));
    return new Map(payload.pendingIssues.flatMap((issue) => (byId.has(issue.id) ? [[issue.id, byId.get(issue.id)!] as const] : [])));
  }, [collection, payload.pendingIssues]);
  const reference = <ReferenceButton cards={[...issueCards.values()]} title={payload.name} />;
  // CEO 本人就是负责人：两面卡头都带一枚皇冠（clark progress-card 的 driBadge），正面不再写「负责人 · …」。
  const { viewerId } = useWorkspace();
  const ceoOwns = !!viewerId && payload.ownerId === viewerId;
  const ownerBadge = ceoOwns ? (
    <span className={s.ownerBadge} role="img" aria-label="你是这个战场的负责人" title="你是这个战场的负责人">
      <Crown size={17} strokeWidth={1.65} aria-hidden="true" />
    </span>
  ) : null;
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceId = useId();
  const display = useBattlefieldDisplay();
  const flipped = display.flipped(id);
  const frontFlip = useRef<HTMLButtonElement>(null);
  const backFlip = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);

  // 翻面只切展示面：焦点留在对应的翻面键上，不能留在已 inert 的那一面。
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.current?.contains(active)) {
      (flipped ? backFlip : frontFlip).current?.focus({ preventScroll: true });
    }
  }, [flipped]);

  const urgent = payload.pendingIssues.filter((issue) => issue.urgency === "red").length;
  const feedback = payload.latestFeedback;
  // 标题进战场二级页（clark progress-card 的 .title）：正面进「待决策」，翻到进展面再点就进「进展」页签。
  const detailHref = `/battlefields/${encodeURIComponent(id)}`;
  const title = (href: string) => (
    <HeroButton
      variant="ghost"
      size="sm"
      data-ts-layout="true"
      type="button"
      className={s.title}
      data-origin={href}
      aria-label={`打开${payload.name}`}
      onPress={(event) => onNavigate(href, event.target as Element)}
    >
      <h2>{payload.name}</h2>
      <ChevronRight size={14} aria-hidden="true" />
    </HeroButton>
  );

  return (
    <article ref={root} className={s.frame} data-testid={`zone-${id}`} data-mode={flipped ? "progress" : "decisions"}>
      <div className={s.rotor} data-flipped={flipped}>
        <HeroCard className={`${s.face} ${s.front}`} inert={flipped} aria-hidden={flipped}>
          <header className={s.header}>
            {title(detailHref)}
            {ownerBadge}
            {reference}
            <Button size="sm" variant="secondary" ref={frontFlip} className={s.flip} onPress={() => display.flip(id)} aria-label={`查看${payload.name}进展`}>
              <ArrowLeftRight size={15} aria-hidden="true" />
              <span>进展</span>
            </Button>
          </header>
          <div className={s.finding} aria-label="战场概况">
            <div className={s.findingHeading}>
              {ceoOwns ? null : <span>负责人 · {payload.ownerDisplayName || "待指派"}</span>}
              <button
                type="button"
                className={s.missionToggle}
                aria-expanded={missionsOpen}
                aria-controls={`missions-${id}`}
                onClick={() => setMissionsOpen((open) => !open)}
              >
                Missions · {missions.length}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </div>
            {payload.sixMonthOutcome ? <strong>长期目标 · {payload.sixMonthOutcome}</strong> : null}
            {missionsOpen ? (
              <ul id={`missions-${id}`} className={s.missionList} aria-label={`${payload.name}的 Mission`}>
                {missions.map((mission) => {
                  const item = payloadOf<MissionPayload>(mission);
                  const href = `/missions/${encodeURIComponent(item.missionId)}`;
                  return (
                    <li key={mission.id}>
                      <button type="button" data-origin={href} onClick={(event) => onNavigate(href, event.currentTarget)}>
                        <b>{item.code}</b>
                        <span>{item.title}</span>
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          <div className={s.issues} role="region" aria-label={`${payload.name}议题列表`}>
            {payload.pendingIssues.length ? (
              <div className={b.directIssues}>
                {payload.pendingIssues.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={{ id: issue.id, title: issue.title, urgency: issue.urgency, meetingTime: meetingTimes.get(issue.id) || undefined }}
                    card={issueCards.get(issue.id)}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            ) : (
              <p className={b.empty}>暂无待决策议题</p>
            )}
          </div>
        </HeroCard>

        <HeroCard className={`${s.face} ${s.back}`} inert={!flipped} aria-hidden={!flipped}>
          <div className={s.atmosphere} aria-hidden="true">
            <span />
            <span />
          </div>
          <header className={s.header}>
            {title(`${detailHref}?tab=progress`)}
            {ownerBadge}
            {reference}
            <Button size="sm" variant="secondary" ref={backFlip} className={s.flip} onPress={() => display.flip(id)} aria-label={`返回${payload.name}待决策`}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span>待决策</span>
              {urgent > 0 ? (
                <span className={s.urgent} aria-label={`${urgent} 条紧急议题`}>
                  {urgent}
                </span>
              ) : null}
            </Button>
          </header>
          <BattlefieldProgressPreview id={id} />
          <div
            className={s.evidence}
            data-open={evidenceOpen}
            onKeyDown={(event) => {
              if (event.key === "Escape" && evidenceOpen) {
                event.preventDefault();
                event.stopPropagation();
                setEvidenceOpen(false);
              }
            }}
          >
            <button type="button" aria-expanded={evidenceOpen} aria-controls={evidenceId} onClick={() => setEvidenceOpen((open) => !open)}>
              反馈与依据
              <span>{feedback ? `上次收集：${monthDayTime(feedback.observedAt) || feedback.observedAt}` : "尚未收到负责人反馈"}</span>
            </button>
            <div id={evidenceId} inert={!evidenceOpen} aria-hidden={!evidenceOpen}>
              {feedback ? (
                <>
                  <p>{feedback.text}</p>
                  <p>来源：{feedback.sourceRef}</p>
                </>
              ) : (
                <p>尚未收到负责人反馈</p>
              )}
            </div>
          </div>
        </HeroCard>
      </div>
    </article>
  );
}
