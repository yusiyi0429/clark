"use client";

import { useMemo } from "react";
import { Button } from "@heroui/react";
import { Pencil } from "lucide-react";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import type { Card } from "@/lib/api/client";
import type { MissionPayload } from "@/cards/payloads";
import { MissionStatus, missionStatusLabel } from "@/components/MissionStatus";
import m from "@/styles/mission-detail.module.css";
import w from "@/styles/app-shell.module.css";

/** 关系条里的月度计划只读同周期状态；没有同周期计划时明确写未签发。 */
export function planRelation(period: string, planStatus: string | null): string {
  return planStatus ? `${period} · ${planStatus}` : `${period} · 尚未签发`;
}

/**
 * Mission 详情区分讨论草稿与已确定承诺：不推断进度、不显示完成率，
 * Task/Activity 与执行状态留在外部 DRI 流程。
 */
export function MissionDetailScreen({ mission, planStatus, card }: { mission: MissionPayload; planStatus: string | null; card?: Card }) {
  const { navigate, close } = useWorkspace();
  const cards = useMemo(() => (card ? [card] : []), [card]);
  const status = missionStatusLabel(mission) || (planStatus === "已签发" ? "生效中" : "");
  useRegisterDetail({ scope: `mission:${mission.missionId}`, label: mission.title, mark: null, cards });
  return (
    <DetailFrame
      title={mission.title}
      subtitle={`Mission ${mission.code} · ${mission.period}${status ? ` · ${status}` : ""}`}
      onBack={close}
      actions={
        !mission.personalCard ? <Button size="sm" variant="secondary" onPress={() => navigate(`/config/missions?missionId=${mission.missionId}`)}>
          <Pencil size={14} aria-hidden="true" />
          编辑 Mission
        </Button> : undefined
      }
    >
      <div className={w.expandedScroll}>
        <div className={m.content}>
          <p className={m.owner}>唯一负责人 · {mission.ownerDisplayName || "待指派"}</p>
          <MissionStatus mission={mission} />
          {mission.personalCard ? <a className={m.personalCardLink} href={`/mission-cards/${mission.personalCard.cardId}`} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(`/mission-cards/${mission.personalCard!.cardId}`); } }}>查看所属任务卡</a> : null}

          <div className={m.relations} data-testid="mission-relations">
            <Relation label="能力域" value={`${mission.capabilityCode} ${mission.capabilityName}`.trim()} />
            <Relation label="关联战场" value={mission.battlefieldNames.join(" · ") || "未关联战场"} tone="battlefield" />
            <Relation label="月度计划" value={planRelation(mission.period, planStatus)} tone="plan" />
            <Relation label="来源" value={`${mission.placeholder ? "占位 · " : ""}${mission.sourceTitle}`} tone="source" />
          </div>

          <div className={m.body}>
            <div className={m.main}>
              <section className={m.hero}>
                <p className={m.eyebrow}>MISSION OUTCOME</p>
                <p className={m.outcome}>{mission.outcome}</p>
                {mission.why ? <p className={m.why}>背景 · {mission.why}</p> : null}
              </section>

              <section className={m.section}>
                <h2 className={m.sectionTitle}>成功证据</h2>
                {mission.successEvidence.length ? (
                  <ul className={m.bullets}>
                    {mission.successEvidence.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={m.sectionBody}>来源未给出成功证据。</p>
                )}
              </section>

              <section className={m.section}>
                <h2 className={m.sectionTitle}>关键里程碑</h2>
                <p className={m.milestones}>{mission.milestones.length ? mission.milestones.join("　·　") : "来源未给出关键里程碑。"}</p>
              </section>
            </div>

            <div className={m.sidebar}>
              <SideCard title="关键依赖" tone="dependency" text={mission.dependencies} />
              <SideCard title="最大风险" tone="risk" text={mission.risk} />
              <SideCard title="边界" tone="boundary" text={mission.boundaries} />
              <section className={m.section}>
                <h2 className={m.sectionTitle}>来源追溯</h2>
                <p className={m.source}>
                  {mission.sourceTitle} · 修订 revision {mission.sourceRevision}
                  <br />
                  {mission.sourceRef}
                </p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </DetailFrame>
  );
}

function Relation({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={m.relation}>
      <p className={m.relationLabel}>{label}</p>
      <p className={m.relationValue} data-tone={tone}>
        {value}
      </p>
    </div>
  );
}

function SideCard({ title, tone, text }: { title: string; tone: string; text: string }) {
  return (
    <section className={m.section}>
      <h2 className={m.sectionTitle} data-tone={tone}>
        {title}
      </h2>
      <p className={m.sectionBody}>{text || "来源未给出。"}</p>
    </section>
  );
}
