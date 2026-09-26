"use client";

/** clark card-document.tsx 的整张阅读页。正文不依赖观看者身份；只让控件随阶段变化。 */
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "ts-design/primitives";
import type { TMissionCardField, TPersonalMissionCardPayload } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import s from "./mission-card.module.css";

export type PersonalMission = TPersonalMissionCardPayload["card"]["missions"][number];
export const fieldNames: Record<TMissionCardField, string> = {
  title: "名称", why: "Why / 背景", outcome: "预期结果", successEvidence: "成功证据", boundaries: "边界", keyPath: "关键路径",
  milestones: "里程碑", resources: "资源与权限", dependencies: "依赖与协作", humanAgentSplit: "人-Agent 分工", risk: "风险与升级", retrospect: "复盘沉淀",
};
const fields: TMissionCardField[] = ["title", "why", "outcome", "keyPath", "resources", "humanAgentSplit", "risk", "retrospect", "successEvidence", "boundaries", "milestones", "dependencies"];
export function missionFieldText(mission: PersonalMission, field: TMissionCardField): string {
  const value = mission[field];
  return Array.isArray(value) ? value.join("\n") : value;
}
export function selectedFieldQuote(node: HTMLElement, selection: Pick<Selection, "anchorNode" | "focusNode" | "toString"> | null): string | null {
  const text = selection?.toString().trim();
  return text && selection?.anchorNode && selection.focusNode && node.contains(selection.anchorNode) && node.contains(selection.focusNode) ? text : null;
}
export type DocumentControls = {
  onQuote: (mission: PersonalMission, field: TMissionCardField, quote: string) => void;
  onPropose: (mission: PersonalMission, field: TMissionCardField) => void;
  onSelect: (mission: PersonalMission, field: TMissionCardField, node: HTMLElement) => void;
  proposalEditor?: (mission: PersonalMission, field: TMissionCardField) => ReactNode;
  onDecide?: (item: TPersonalMissionCardPayload["feedback"][number], decision: "accept" | "decline") => void;
  pending?: boolean;
  decisionError?: { feedbackId: string; message: string } | null;
};

export function FeedbackNote({ item, location, controls }: { item: TPersonalMissionCardPayload["feedback"][number]; location?: string; controls?: DocumentControls }) {
  const canDecide = controls?.onDecide && item.actions.some((action) => action.actionType === "mission-round.decide");
  const error = controls?.decisionError?.feedbackId === item.id ? controls.decisionError.message : null;
  return <article id={`feedback-${item.id}`} className={s.remark} data-tone={item.verdict.tone} data-feedback={item.id} tabIndex={-1} aria-label={location}>
    <header><span className={s.remarkWho}>{item.authorName}</span><span>{item.kind === "suggestion" ? "修改建议" : item.kind === "quote" ? "引用评论" : "评论"}</span><time dateTime={item.createdAt}>{monthDayTime(item.createdAt)}</time><span className={s.verdict} data-tone={item.verdict.tone} role="status">{item.verdict.text}</span></header>
    {item.sourceVersion !== null ? <p className={s.basis}>对照{item.basis === "candidate" ? "候选版本" : "草稿"} v{item.sourceVersion} · 第 {item.round} 轮</p> : null}
    {location ? <p className={s.location}>{location}</p> : null}
    {item.quote ? <blockquote>{item.quote}</blockquote> : null}
    {item.kind === "suggestion" ? <div className={s.diff}><p><span>提交时原文</span><del>{item.original || "未提供"}</del></p><p><span>建议改为</span><ins>{item.proposed}</ins></p></div> : null}
    <p>{item.body}</p>
    {canDecide ? <div className={s.decide}>
      <div className={s.inlineActions}>
        <Button variant="primary" className={s.decisionPrimary} isDisabled={Boolean(controls.pending || item.decision === "accept" || item.acceptBlockedReason)} aria-describedby={item.acceptBlockedReason ? `blocked-${item.id}` : undefined} onPress={() => controls.onDecide?.(item, "accept")}>{item.kind === "suggestion" ? "采纳修改" : "已纳入核对"}</Button>
        <Button variant="ghost" className={s.secondary} isDisabled={Boolean(controls.pending || item.decision === "decline")} onPress={() => controls.onDecide?.(item, "decline")}>不采纳</Button>
      </div>
      {item.acceptBlockedReason ? <p id={`blocked-${item.id}`} className={s.blocked}>{item.acceptBlockedReason}</p> : null}
      {error ? <p className={s.proposalError} role="alert">{error}</p> : null}
    </div> : null}
  </article>;
}

/** 原件分支仅保留可接入的阅读方式。10 月 API 不提供原件，也不出页签或下载入口。 */
export function CardDocument({ payload, controls, artifact }: {
  payload: TPersonalMissionCardPayload;
  controls: DocumentControls;
  artifact?: { content: string; note: string; showOriginal: boolean; onSelect: (original: boolean) => void };
}) {
  const { card, round, feedback } = payload;
  const canDiscuss = round.phase === "open";
  const canQuote = canDiscuss || round.phase === "closed" || round.phase === "reviewing";
  const sources = [...new Map(card.missions.map((mission) => [`${mission.sourceRef}:${mission.sourceRevision}`, mission])).values()];
  const loose = feedback.filter((item) => !item.missionId || !item.field);
  const decisionControls = round.approver && round.phase === "reviewing" ? controls : undefined;
  return <article className={s.document} aria-label={`${card.ownerName}的 ${Number(round.period.slice(5))} 月 Mission Card`}>
    <div className={s.version}>
      <div className={s.versionMain}><strong>{card.ownerName}</strong><span>{card.status}</span></div>
      <div className={s.source}>{round.placeholder ? <span>占位 · 沿用 9 月个人卡</span> : null}{sources.map((source) => <span key={`${source.sourceRef}:${source.sourceRevision}`}>飞书 r{source.sourceRevision} · <a href={source.sourceRef} target="_blank" rel="noreferrer">打开来源</a></span>)}</div>
    </div>
    {artifact ? <div className={s.tabs} role="tablist" aria-label="这张 Mission Card 的两种读法"><button role="tab" aria-selected={artifact.showOriginal} onClick={() => artifact.onSelect(true)}>原件</button><button role="tab" aria-selected={!artifact.showOriginal} onClick={() => artifact.onSelect(false)}>个人任务 · {card.missions.length}</button></div> : null}
    {artifact?.showOriginal ? <div className={s.artifact}><p>{artifact.note}</p><Markdown remarkPlugins={[remarkGfm]}>{artifact.content}</Markdown></div> : <div className={s.tasks}>
      {card.missions.map((mission) => <section key={mission.missionId} className={s.task} aria-label={`个人任务：${mission.title}`}>
        <h2>{mission.title}</h2>
        <p className={s.taskMeta}><span>{mission.code}</span><span>{mission.capabilityCode} · {mission.capabilityName}</span>{mission.placeholder ? <span className={s.placeholder}>占位</span> : null}<span>v{mission.version}</span></p>
        <dl className={s.fields}>{fields.map((field) => {
          const text = missionFieldText(mission, field);
          const notes = feedback.filter((item) => item.missionId === mission.missionId && item.field === field);
          return <div key={field} className={s.field} data-changed={mission.changedFields.includes(field) || undefined}>
            <dt>{fieldNames[field]}{mission.changedFields.includes(field) ? <span className={s.changed}>已采纳修改</span> : null}</dt>
            <dd><div className={s.fieldText} data-mission-field={`${mission.missionId}:${field}`} onMouseUp={(event) => canQuote && controls.onSelect(mission, field, event.currentTarget)} onKeyUp={(event) => canQuote && controls.onSelect(mission, field, event.currentTarget)}>
              {Array.isArray(mission[field]) && (mission[field] as string[]).length ? <ul>{(mission[field] as string[]).map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>{text || <span className={s.missing}>未提供</span>}</p>}
            </div>
            {canQuote ? <div className={s.fieldActions}><Button variant="ghost" className={s.textAction} isDisabled={!text} onPress={() => controls.onQuote(mission, field, text)}>{canDiscuss ? "引用并评论" : "引用到群组"}</Button>{canDiscuss ? <Button variant="ghost" className={s.textAction} onPress={() => controls.onPropose(mission, field)}>建议修改</Button> : null}</div> : null}
            {round.phase !== "confirmed" ? controls.proposalEditor?.(mission, field) : null}
            {notes.length ? <div className={s.remarks}>{notes.map((item) => <FeedbackNote key={item.id} item={item} location={`${card.ownerName}的卡 · ${mission.title} · ${fieldNames[field]}`} controls={decisionControls} />)}</div> : null}
            </dd>
          </div>;
        })}<div className={s.field}><dt>唯一责任人</dt><dd><p className={s.owner}>{card.ownerName}</p></dd></div></dl>
      </section>)}
    </div>}
    {loose.length ? <section className={s.loose} aria-label="没有指向具体字段的意见"><h2>整张卡上的意见</h2><div className={s.remarks}>{loose.map((item) => <FeedbackNote key={item.id} item={item} location={`${card.ownerName}的卡 · 整张卡`} controls={decisionControls} />)}</div></section> : null}
  </article>;
}
