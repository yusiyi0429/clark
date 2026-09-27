"use client";

import { useMemo } from "react";
import type { Card } from "@/lib/api/client";
import type { ResearchDoc } from "@/cards/payloads";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import s from "@/styles/member-group-card.module.css";

type MemberIssue = { status: string; urgency: { level: string; reason?: string }; location: { level: string }; whyNow: string | null;
  research: { status: string; doc?: ResearchDoc }; receipts: { id: string; decisionText: string; revokedAt: string | null }[] };
type MemberMeeting = { status: string; scheduledAt: string; endsAt: string; leadDriId: string; participants: { personId: string; displayName: string }[];
  purpose: string; preflightBrief: string; materials: { id: string; fileName: string; extractedText: string }[];
  outcome: { items?: { id: string; kind: string; text: string; ownerPersonId?: string }[] } | null };
const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit" });

export function MemberGroupCard({ card }: { card: Card }) {
  const workspace = useWorkspace();
  const type: "issue" | "meeting" = card.kind === "issue" ? "issue" : "meeting";
  const group = useMemo(() => ({ kind: "thread" as const, objectType: type, objectId: card.objectRef.id, viewerId: workspace.viewerId ?? "", members: [] }), [type, card.objectRef.id, workspace.viewerId]);
  useRegisterDetail({ scope: `${type}:${card.objectRef.id}`, label: card.title, mark: type === "meeting" ? "meeting" : null, cards: [card], group });
  const back = () => workspace.close();
  if (type === "issue") {
    const issue = card.payload as MemberIssue;
    const doc = issue.research.doc;
    return <div className={s.screen}><DetailFrame title={card.title} subtitle={`议题 · ${issue.status === "decided" ? "已形成结论" : issue.status === "dismissed" ? "已移出" : "研究中"}`} onBack={back}>
      <main className={s.body}>
        <section className={s.panel}><h2>为什么现在</h2><p>{issue.whyNow || issue.urgency.reason || "请查看研究与进展"}</p><p className={s.meta}>位置 · {issue.location.level}　紧急程度 · {issue.urgency.level}</p></section>
        <section className={s.panel}><h2>研究与依据</h2>{doc ? <><p>{doc.summary}</p>
          {doc.options?.length ? <><h3>备选路径</h3><ul>{doc.options.map((option) => <li key={option.id}>{option.label}</li>)}</ul></> : null}
          {doc.evidence?.length ? <><h3>依据</h3><ul>{doc.evidence.map((item, index) => <li key={index}>{item.quote} · {item.sourceTitle}</li>)}</ul></> : null}
          {doc.unknowns?.length ? <><h3>仍待确认</h3><ul>{doc.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}</> : <p className={s.meta}>研究状态：{issue.research.status}</p>}</section>
        {issue.receipts?.filter((item) => !item.revokedAt).length ? <section className={s.panel}><h2>CEO 的判断</h2>{issue.receipts.filter((item) => !item.revokedAt).map((item) => <p key={item.id}>{item.decisionText}</p>)}</section> : null}
      </main>
    </DetailFrame></div>;
  }
  const meeting = card.payload as MemberMeeting;
  const lead = meeting.participants.find((person) => person.personId === meeting.leadDriId)?.displayName ?? meeting.leadDriId;
  return <div className={s.screen}><DetailFrame title={card.title} subtitle="会议安排" onBack={back}>
    <main className={s.body}>
      <section className={s.panel}><h2>会议安排</h2><p className={s.when}>{time(meeting.scheduledAt)} — {time(meeting.endsAt)}</p><p>主持人 · {lead}</p><p>参会人 · {meeting.participants.map((person) => person.displayName).join("、")}</p>{meeting.purpose ? <p>会议目的 · {meeting.purpose}</p> : null}</section>
      {meeting.preflightBrief ? <section className={s.panel}><h2>会前预审</h2><p>{meeting.preflightBrief}</p></section> : null}
      <section className={s.panel}><h2>会前材料</h2>{meeting.materials.length ? meeting.materials.map((material) => <article key={material.id} className={s.material}><strong>{material.fileName}</strong><a href={`/api/meetings/${card.objectRef.id}/materials/${material.id}/download`}>下载原件</a>{material.extractedText ? <details><summary>查看解析文字</summary><p>{material.extractedText}</p></details> : null}</article>) : <p className={s.meta}>暂无材料</p>}</section>
      {meeting.outcome?.items?.length ? <section className={s.panel}><h2>会后结论</h2>{meeting.outcome.items.map((item) => <p key={item.id}>{item.kind === "todo" ? "待办" : "决定"} · {item.text}{item.ownerPersonId ? ` · ${meeting.participants.find((person) => person.personId === item.ownerPersonId)?.displayName ?? item.ownerPersonId}` : ""}</p>)}</section> : null}
    </main>
  </DetailFrame></div>;
}
