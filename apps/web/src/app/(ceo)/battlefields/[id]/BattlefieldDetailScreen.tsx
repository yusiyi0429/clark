"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Crown } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type MissionPayload } from "@/cards/payloads";
import { IssueRow, meetingTimesByIssue } from "@/components/IssueRow";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { SourceName } from "@/components/SourceName";
import { cleanDisplayText } from "@/lib/displayText";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { calendarDate, monthDayTime } from "@/lib/companyTime";
import w from "@/styles/app-shell.module.css";
import d from "@/styles/battlefield-detail.module.css";

export type BattlefieldTab = "decisions" | "progress";

/** 本战场本月的 Mission（首页集合只含当期），按负责人分组；组内按编号。 */
export function missionsByOwner(cards: Card[], battlefieldId: string): { owner: string; missions: MissionPayload[] }[] {
  const groups = new Map<string, MissionPayload[]>();
  for (const item of cards) {
    if (item.kind !== "mission") continue;
    const mission = payloadOf<MissionPayload>(item);
    if (!mission.battlefieldIds.includes(battlefieldId)) continue;
    const owner = mission.ownerDisplayName || "待指派";
    groups.set(owner, [...(groups.get(owner) ?? []), mission]);
  }
  return [...groups.entries()].map(([owner, missions]) => ({ owner, missions: missions.sort((a, b) => a.code.localeCompare(b.code)) }));
}

const EXPORT_LABEL: Record<string, string> = { delivered: "已送达", failed: "外发失败" };

/**
 * 战场二级页（clark 战场视角「决策 / 战况」）：只摆有真实来源的内容，缺的照实写。
 * 战况不计算完成率、达成度或按期判断（CONTEXT.md Mission：不承载执行状态与完成率），
 * 只列本月 Mission 的成功证据与里程碑原文、普通待办的外发状态和负责人反馈。
 */
export function BattlefieldDetailScreen({ battlefield, cards, initialTab }: { battlefield: Card; cards: Card[]; initialTab: BattlefieldTab }) {
  const { navigate, close, viewerId } = useWorkspace();
  const payload = payloadOf<BattlefieldPayload>(battlefield);
  const ceoOwns = !!viewerId && payload.ownerId === viewerId;
  // 从卡片哪一面点进来就停在哪个页签（?tab=progress 是战况页签）。
  const [tab, setTab] = useState<BattlefieldTab>(initialTab);
  const meetingTimes = useMemo(() => meetingTimesByIssue(cards), [cards]);
  const issueCards = useMemo(() => {
    const byId = new Map(cards.filter((item) => item.kind === "issue").map((item) => [item.objectRef.id, item]));
    return payload.pendingIssues.flatMap((issue) => (byId.has(issue.id) ? [byId.get(issue.id)!] : []));
  }, [cards, payload.pendingIssues]);
  const groups = useMemo(() => missionsByOwner(cards, payload.battlefieldId), [cards, payload.battlefieldId]);
  const missions = groups.flatMap((group) => group.missions);
  const evidenceCount = missions.reduce((sum, mission) => sum + mission.successEvidence.length, 0);
  useRegisterDetail({ scope: "global", label: payload.name, mark: null, cards: issueCards });

  function pick(next: BattlefieldTab) {
    setTab(next);
    // 页签写进地址（刷新、分享都回到同一页签）；只换查询串，不重新请求页面。
    const url = new URL(window.location.href);
    if (next === "progress") url.searchParams.set("tab", "progress");
    else url.searchParams.delete("tab");
    // 传 null：Next 才会把新地址同步进路由（传它自己的 state 会被当成内部调用，之后重绘又把 ?tab 去掉，巡检 P2-29）。
    window.history.replaceState(null, "", url);
  }

  const openMission = (mission: MissionPayload, origin: Element) => navigate(`/missions/${encodeURIComponent(mission.missionId)}`, origin);

  return (
    <DetailFrame
      title={payload.name}
      subtitle="战场"
      onBack={close}
      actions={
        <SegmentedSwitch
          data-header-switch=""
          label="战场视角"
          selected={tab}
          onSelect={pick}
          segments={[
            { id: "decisions", label: "决策" },
            { id: "progress", label: <>{ceoOwns ? <Crown size={15} strokeWidth={1.8} aria-hidden="true" /> : null}战况</>,
              ariaLabel: ceoOwns ? "战况（一号位为本战场负责人）" : undefined },
          ]}
        />
      }
    >
      <div className={w.expandedScroll}>
        <div className={d.detail} data-tab={tab} data-material-column>
          {ceoOwns ? null : <p className={d.owner}>负责人 · {payload.ownerDisplayName || "待指派"}</p>}

          {tab === "decisions" ? (
            <>
              <section className={d.lead} aria-label="负责人反馈">
                <span>负责人反馈{payload.latestFeedback ? ` · ${monthDayTime(payload.latestFeedback.observedAt)}` : ""}</span>
                {payload.latestFeedback ? <p>{payload.latestFeedback.text}</p> : <p className={d.muted}>尚未收到负责人反馈</p>}
              </section>

              <section className={d.section} aria-label="议题">
                <h3>
                  议题<b>{payload.pendingIssues.length}</b>
                </h3>
                <div className={d.box}>
                  {payload.pendingIssues.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={{ id: issue.id, title: issue.title, urgency: issue.urgency, meetingTime: meetingTimes.get(issue.id) || undefined, fromRadar: issue.fromRadar }}
                      card={issueCards.find((item) => item.objectRef.id === issue.id)}
                      onNavigate={navigate}
                    />
                  ))}
                  {payload.pendingIssues.length ? null : <p className={d.empty}>无待决策议题</p>}
                </div>
              </section>

              <Goals payload={payload} />

              <section className={d.section} aria-label="战役">
                <h3>
                  战役<b>{payload.missionAnchors.length}</b>
                </h3>
                {payload.missionAnchors.length ? (
                  <>
                    <ul className={d.campaigns}>
                      {payload.missionAnchors.map((anchor) => (
                        <li key={anchor.code}>
                          <b>{anchor.code}</b>
                          <span>{anchor.title}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className={d.box}>
                    <p className={d.empty}>尚未登记战役</p>
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <p className={d.summary}>
                本月 {missions.length} 条 Mission · 成功证据 {evidenceCount} 项
              </p>

              <Goals payload={payload} />

              <section className={d.section} aria-label="本月进展">
                <div className={d.sectionHead}>
                  <h3>
                    本月进展<b>{missions.length}</b>
                  </h3>
                </div>
                {missions.length ? (
                  <div className={d.groups}>
                    {groups.map((group) => (
                      <div key={group.owner} className={d.group}>
                        <h4>
                          {group.owner}
                          <b>{group.missions.length} 条</b>
                        </h4>
                        <ul>
                          {group.missions.map((mission) => (
                            <li key={mission.missionId}>
                              <button type="button" className={d.mission} data-origin={`/missions/${encodeURIComponent(mission.missionId)}`} onClick={(event) => openMission(mission, event.currentTarget)}>
                                <b>{mission.code}</b>
                                <span>{mission.title}</span>
                                <small>成功证据 {mission.successEvidence.length} 项</small>
                                <ChevronRight size={13} aria-hidden="true" />
                              </button>
                              {mission.milestones.length ? (
                                <ol className={d.milestones} aria-label={`${mission.code} 的里程碑`}>
                                  {mission.milestones.map((milestone, index) => (
                                    <li key={`${index}:${milestone}`}>{milestone}</li>
                                  ))}
                                </ol>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={d.box}>
                    <p className={d.empty}>本月尚无归属本战场的 Mission</p>
                  </div>
                )}
              </section>

              <section className={d.section} aria-label="普通待办">
                <h3>
                  普通待办<b>{payload.todos.length}</b>
                </h3>
                <div className={d.box}>
                  {payload.todos.length ? (
                    <ul className={d.rows}>
                      {payload.todos.map((todo) => (
                        <li key={todo.id}>
                          <span>{todo.title}</span>
                          <small>
                            {todo.dueAt ? `${calendarDate(todo.dueAt)} · ` : ""}
                            {(todo.exportStatus && EXPORT_LABEL[todo.exportStatus]) || "待外发"}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={d.empty}>当月无归属本战场的普通待办</p>
                  )}
                </div>
              </section>

              <section className={d.section} aria-label="负责人反馈">
                <h3>
                  负责人反馈<b>{payload.feedback.length}</b>
                </h3>
                <div className={d.box}>
                  {payload.feedback.length ? (
                    <ol className={d.feedback}>
                      {payload.feedback.map((item) => (
                        <li key={`${item.observedAt}:${item.sourceRef}`}>
                          <span>{monthDayTime(item.observedAt)}</span>
                          <p>{cleanDisplayText(item.text)}</p>
                          <small>来源 · <SourceName value={item.sourceRef} /></small>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className={d.empty}>尚未收到负责人反馈</p>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </DetailFrame>
  );
}

/** 非演示环境的目标：六个月目标与本月目标。 */
function Goals({ payload }: { payload: BattlefieldPayload }) {
  return (
    <section className={d.section} aria-label="目标">
      <h3>目标</h3>
      <div className={d.goals}>
        <div>
          <span>六个月</span>
          <p>{payload.sixMonthOutcome || "未提供"}</p>
        </div>
        <div>
          <span>本月{payload.period ? ` · ${payload.period}` : ""}</span>
          {payload.target ? <p>{payload.target}</p> : <p className={d.muted}>尚未签发当月目标</p>}
        </div>
      </div>
    </section>
  );
}
