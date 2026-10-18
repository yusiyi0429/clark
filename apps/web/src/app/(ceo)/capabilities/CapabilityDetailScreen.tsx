"use client";

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type CapabilityPayload, type MissionPayload } from "@/cards/payloads";
import { capabilitySections, issueRowData } from "@/components/HomeBoard";
import { IssueRow, meetingTimesByIssue } from "@/components/IssueRow";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import w from "@/styles/app-shell.module.css";
import c from "@/styles/capability-detail.module.css";

export type CapabilityPlan = { period: string; status: string; capabilities: { capabilityId: string; outcome: string }[] };

type SupportLabel = { code?: string; name: string };

/** 「支撑」按资料解释：战役锚点写编号与标题，战场写名称，全战场照写；找不到的锚点只写编号，不另造对象。 */
export function supportLabels(capability: Card, cards: Card[]): SupportLabel[] {
  const battlefields = cards.filter((item) => item.kind === "battlefield").map((item) => payloadOf<BattlefieldPayload>(item));
  return payloadOf<CapabilityPayload>(capability).supportRefs.map((ref): SupportLabel => {
    if (ref.type === "all-battlefields") return { name: "全战场" };
    if (ref.type === "battlefield") return { code: "战场", name: battlefields.find((item) => item.battlefieldId === ref.battlefieldId)?.name ?? ref.battlefieldId };
    const anchor = battlefields.flatMap((item) => item.missionAnchors).find((item) => item.code === ref.missionCode);
    return anchor ? { code: anchor.code, name: anchor.title } : { name: ref.missionCode };
  });
}

type Domain = {
  id: string;
  code: string;
  name: string;
  group: string;
  sixMonthOutcome: string;
  monthly: string | null;
  supports: SupportLabel[];
  missions: MissionPayload[];
};

/** 七个能力域按排序：名下 Mission（首页集合只含当期）与本月目标都从同一份资料派生，不保存汇总。 */
export function capabilityDomains(cards: Card[], plan: CapabilityPlan | null): Domain[] {
  const missions = cards.filter((item) => item.kind === "mission").map((item) => payloadOf<MissionPayload>(item));
  return cards
    .filter((item) => item.kind === "capability")
    .sort((a, b) => payloadOf<CapabilityPayload>(a).sortOrder - payloadOf<CapabilityPayload>(b).sortOrder)
    .map((item) => {
      const payload = payloadOf<CapabilityPayload>(item);
      return {
        id: payload.capabilityId,
        code: payload.code,
        name: payload.name,
        group: payload.group,
        sixMonthOutcome: payload.sixMonthOutcome,
        monthly: plan?.capabilities.find((entry) => entry.capabilityId === payload.capabilityId)?.outcome ?? null,
        supports: supportLabels(item, cards),
        missions: missions.filter((mission) => mission.capabilityId === payload.capabilityId).sort((a, b) => a.code.localeCompare(b.code)),
      };
    });
}

const PLAN_STATUS: Record<string, string> = { draft: "草拟中", negotiating: "协商中" };

/**
 * 公司能力详情（SSOT CEO-01，clark `CapabilityDetail`）：先列能力建设议题，再列每个能力域的负责人、
 * 六个月目标、本月目标、支撑的战役或战场与名下 Mission。首页卡只列有议题的能力域，细节都在这里。
 */
export function CapabilityDetailScreen({ cards, plan }: { cards: Card[]; plan: CapabilityPlan | null }) {
  const { navigate, close } = useWorkspace();
  const sections = useMemo(() => capabilitySections(cards), [cards]);
  const issues = useMemo(() => sections.flatMap((section) => section.issues), [sections]);
  const meetingTimes = useMemo(() => meetingTimesByIssue(cards), [cards]);
  const domains = useMemo(() => capabilityDomains(cards, plan), [cards, plan]);
  useRegisterDetail({ scope: "global", label: "公司能力", mark: null, cards: issues });
  const monthlyLabel = plan && PLAN_STATUS[plan.status] ? `本月目标 · ${PLAN_STATUS[plan.status]}` : "本月目标";

  return (
    <DetailFrame title="公司能力" subtitle="能力域" onBack={close}>
      <div className={w.expandedScroll}>
        <div className={c.detail}>
          <section className={c.section} aria-label="议题">
            <h3>
              议题<b>{issues.length}</b>
            </h3>
            <div className={c.issueList}>
              {sections.map((section) => (
                <div key={section.key} className={c.issueGroup} data-capability-category={section.key}>
                  <h4>{section.name}</h4>
                  {section.issues.map((card) => (
                    <IssueRow key={card.id} issue={issueRowData(card, meetingTimes)} card={card} onNavigate={navigate} />
                  ))}
                </div>
              ))}
              {issues.length ? null : <p className={c.empty}>暂无待决策议题</p>}
            </div>
          </section>

          <section className={c.section} aria-label="能力域">
            <h3>
              能力域<b>{domains.length}</b>
            </h3>
            <ul className={c.domains}>
              {domains.map((domain) => (
                <li key={domain.id} className={c.domain} data-capability={domain.id}>
                  <div className={c.domainHead}>
                    <h4>
                      {domain.name}
                      {domain.code ? <span aria-label={`编号 ${domain.code}`}>{domain.code}</span> : null}
                    </h4>
                    <p className={c.owner}>
                      负责人未登记{domain.group ? ` · ${domain.group}` : ""}
                    </p>
                    {domain.supports.length ? (
                      <div className={c.supports}>
                        <span>支撑</span>
                        <ul>
                          {domain.supports.map((label) => (
                            <li key={`${label.code ?? ""}:${label.name}`}>
                              {label.code ? <b>{label.code}</b> : null}
                              {label.name}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <div className={c.goal}>
                    <span>六个月目标</span>
                    <p>{domain.sixMonthOutcome || "未提供"}</p>
                  </div>
                  <div className={c.goal}>
                    <span>{monthlyLabel}</span>
                    {domain.monthly ? (
                      <p>{domain.monthly}</p>
                    ) : (
                      <p className={c.missing}>{plan ? "本月计划没有写这个能力域" : "本月计划尚未制定"}</p>
                    )}
                  </div>
                  <div className={c.missions}>
                    <span>本月 Mission · {domain.missions.length}</span>
                    {domain.missions.length ? (
                      <ul>
                        {domain.missions.map((mission) => {
                          const href = `/missions/${encodeURIComponent(mission.missionId)}`;
                          return (
                            <li key={mission.missionId}>
                              <button type="button" data-origin={href} onClick={(event) => navigate(href, event.currentTarget)}>
                                <b>{mission.code}</b>
                                <span>{mission.title}</span>
                                <small>{mission.ownerDisplayName || "待指派"}</small>
                                <ChevronRight size={13} aria-hidden="true" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className={c.missing}>本月没有归属这个能力域的 Mission</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </DetailFrame>
  );
}
