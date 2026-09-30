"use client";

/** clark card-document.tsx 的整张阅读页。正文不依赖观看者身份；只让控件随阶段变化。 */
import { useCallback, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "ts-design/primitives";
import type { TMissionCardField, TPersonalMissionCardPayload } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { CorrectionPanel, type CorrectionControls } from "./CorrectionPanel";
import { LinkedTaskRows } from "@/components/plan/MonthPlan";
import type { TMonthPlanResponse, TTaskView } from "@warmap/contracts";
import s from "./mission-card.module.css";
import { AnnotatedField, AnnotationNote, FieldAnnotationActivity, RevisionHistory, SelectionPopover, type AnnotationControls, type AnnotationSelection } from "./MissionAnnotations";

export type PersonalMission = TPersonalMissionCardPayload["card"]["missions"][number];
export const fieldNames: Record<TMissionCardField, string> = {
  title: "名称", timeBoundary: "时间边界", outcome: "战役结果", why: "贡献 / 存在必要性", successEvidence: "成功 / 验收标准", boundaries: "责任边界",
  keyPath: "核心路径", tradeoffs: "关键取舍", dependencies: "关键约束与依赖", milestones: "里程碑", resources: "资源与权限", humanAgentSplit: "人-Agent 分工", risk: "风险与升级", retrospect: "复盘沉淀",
};
const fields: TMissionCardField[] = ["timeBoundary", "outcome", "why", "successEvidence", "boundaries", "keyPath", "tradeoffs", "dependencies", "milestones", "resources", "humanAgentSplit", "risk", "retrospect"];
const supplementaryFields = new Set<TMissionCardField>(["resources", "humanAgentSplit", "risk", "retrospect"]);
export function missionFieldText(mission: PersonalMission, field: TMissionCardField): string {
  const value = mission[field];
  return Array.isArray(value) ? value.join("\n") : value ?? "";
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
  /** 已确定任务卡的更正（GAP-04）。 */
  corrections?: CorrectionControls;
  annotations?: AnnotationControls;
};

export function FeedbackNote({ item, location, controls }: { item: TPersonalMissionCardPayload["feedback"][number]; location?: string; controls?: DocumentControls }) {
  const canDecide = controls?.onDecide && item.actions.some((action) => action.actionType === "mission-round.decide");
  const error = controls?.decisionError?.feedbackId === item.id ? controls.decisionError.message : null;
  return <article id={`feedback-${item.id}`} className={s.remark} data-tone={item.verdict.tone} data-feedback={item.id} tabIndex={-1} aria-label={location}>
    <header><span className={s.remarkWho}>{item.authorName}</span><span>{item.kind === "suggestion" ? "修改建议" : item.kind === "quote" ? "引用评论" : "评论"}</span><time dateTime={item.createdAt}>{monthDayTime(item.createdAt)}</time><span className={s.verdict} data-tone={item.verdict.tone} role="status">{item.verdict.text}</span></header>
    {item.sourceVersion !== null ? <p className={s.basis}>对照{item.basis === "candidate" ? "候选版本" : "草稿"} v{item.sourceVersion}</p> : null}
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
export function CardDocument({ payload, controls, artifact, ownerPlan, linkedItems, viewerId }: {
  payload: TPersonalMissionCardPayload;
  controls: DocumentControls;
  artifact?: { content: string; note: string; showOriginal: boolean; onSelect: (original: boolean) => void };
  ownerPlan?: { selected: boolean; onSelect: (selected: boolean) => void; plan: TMonthPlanResponse | null; content: ReactNode; loading: boolean; error: string };
  linkedItems?: Record<string, TTaskView[]>;
  viewerId?: string | null;
}) {
  const { card, round, feedback, corrections, correctionAccess: access } = payload;
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const closeSelection = useCallback(() => { setSelection(null); window.getSelection()?.removeAllRanges(); }, []);
  const notes = controls.annotations?.notes ?? [];
  const revisions = controls.annotations?.revisions ?? [];
  const canDiscuss = round.phase === "open" && !card.ownerConfirmedAt && viewerId !== card.ownerId;
  const loose = feedback.filter((item) => !item.missionId || !item.field);
  const decisionControls = round.approver && round.phase === "reviewing" ? controls : undefined;
  const fixes = controls.corrections;
  // 入口只看服务端给的更正权限：拍板人直接更正，其他看得到卡的人申请更正。
  const correctVerb = access.canApply ? "更正" : access.canRequest ? "申请更正" : null;
  return <article className={s.document} aria-label={`${card.ownerName}的${Number(round.period.slice(5))}月任务`}>
    {payload.annotationAccess.closedReason ? <p className={s.readonly}>{payload.annotationAccess.closedReason}</p> : null}
    {access.closedReason && card.shown === "confirmed" ? <p className={s.readonly}>{access.closedReason}</p> : null}
    {artifact ? <div className={s.tabs} role="tablist" aria-label="这张 Mission Card 的两种读法"><button role="tab" aria-selected={artifact.showOriginal} onClick={() => artifact.onSelect(true)}>原件</button><button role="tab" aria-selected={!artifact.showOriginal} onClick={() => artifact.onSelect(false)}>个人任务 · {card.missions.length}</button></div> : null}
    {notes.length || revisions.length ? <div className={s.documentTools}><button type="button" className={s.notesToggle} aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>批注与记录 <span>{notes.length + revisions.length}</span></button></div> : null}
    {notesOpen ? <section className={s.annotationList} aria-label="批注与修改记录">{notes.map((note) => <AnnotationNote key={note.id} note={note} />)}<RevisionHistory revisions={revisions} /></section> : null}
    {artifact?.showOriginal ? <div className={s.artifact}><p>{artifact.note}</p><Markdown remarkPlugins={[remarkGfm]}>{artifact.content}</Markdown></div> : <div className={s.tasks} id="mission-task-details" role="region" aria-label="任务细节">
      {card.missions.map((mission) => <section key={mission.missionId} className={s.task} aria-label={`个人任务：${mission.title}`}>
        <div className={s.titleWrap}><div className={s.taskTitle} role="heading" aria-level={2}><AnnotatedField mission={mission} field="title" text={mission.title} sourceRound={round.round} notes={notes.filter((note) => note.missionId === mission.missionId && note.field === "title")} onSelect={setSelection} /></div>
        {canDiscuss ? <div className={s.fieldActions}><Button variant="ghost" className={s.textAction} onPress={() => controls.onPropose(mission, "title")}>建议修改</Button></div> : fixes && correctVerb ? <div className={s.fieldActions}><Button variant="ghost" className={s.textAction} aria-label={`${correctVerb}：名称`} onPress={() => fixes.onOpen(mission, "title")}>{correctVerb}</Button></div> : null}</div>
        <p className={s.taskMeta}><span>{mission.capabilityName}</span><span>唯一责任人 · {card.ownerName}</span>{mission.placeholder ? <span className={s.placeholder}>占位</span> : null}{mission.selfEditedFields?.includes("title") ? <span className={s.changed}>本人已修改名称</span> : null}</p>
        {round.phase !== "confirmed" ? controls.proposalEditor?.(mission, "title") : null}
        {fixes ? <CorrectionPanel mission={mission} field="title" label={fieldNames.title} items={corrections.filter((item) => item.missionId === mission.missionId && item.field === "title")} access={access} deciderName={round.deciderName} controls={fixes} /> : null}
        {feedback.filter((item) => item.missionId === mission.missionId && item.field === "title").map((item) => <FeedbackNote key={item.id} item={item} location={`${card.ownerName}的卡 · ${mission.title} · 名称`} controls={decisionControls} />)}
        {controls.annotations ? <FieldAnnotationActivity notes={notes.filter((note) => note.missionId === mission.missionId && note.field === "title")} controls={controls.annotations} /> : null}
        <RevisionHistory revisions={revisions.filter((revision) => revision.missionId === mission.missionId && revision.field === "title")} />
        <div className={s.fields}>{fields.map((field) => {
          const text = missionFieldText(mission, field);
          const feedbackNotes = feedback.filter((item) => item.missionId === mission.missionId && item.field === field);
          const fieldFixes = corrections.filter((item) => item.missionId === mission.missionId && item.field === field);
          const fieldNotes = notes.filter((note) => note.missionId === mission.missionId && note.field === field);
          const fieldRevisions = revisions.filter((revision) => revision.missionId === mission.missionId && revision.field === field);
          const editor = round.phase !== "confirmed" ? controls.proposalEditor?.(mission, field) : null;
          // 历史卡缺少正式核心字段时诚实留白；空补充项可省略，但已有意见和记录仍然可读。
          const hasCorrectionDraft = fixes?.draft?.missionId === mission.missionId && fixes.draft.field === field;
          if (supplementaryFields.has(field) && !text.trim() && !mission.changedFields.includes(field) && !mission.selfEditedFields?.includes(field) && !feedbackNotes.length && !fieldFixes.length && !fieldNotes.length && !fieldRevisions.length && !editor && !hasCorrectionDraft) return null;
          const historyKey = `${mission.missionId}-${field}`;
          const historyOpen = fixes?.history === historyKey;
          const markdownText = Array.isArray(mission[field]) ? (mission[field] as string[]).map((line) => `- ${line.replace(/\n/g, "\n  ")}`).join("\n") : text;
          return <section key={field} className={s.field} data-changed={mission.changedFields.includes(field) || undefined} aria-label={fieldNames[field]}>
            <h3>{fieldNames[field]}{mission.selfEditedFields?.includes(field) ? <span className={s.changed}>本人已修改</span> : mission.changedFields.includes(field) ? <span className={s.changed}>已采纳修改</span> : null}{fixes && fieldFixes.some((item) => item.status === "applied") ? <Button variant="ghost" className={s.corrected} aria-expanded={historyOpen} aria-controls={historyOpen ? `correction-history-${historyKey}` : undefined} aria-label={`已更正：${fieldNames[field]}，${historyOpen ? "收起" : "查看"}更正记录`} onPress={() => fixes.onHistory(historyOpen ? null : historyKey)}><span>已更正</span></Button> : null}</h3>
            <div className={s.fieldBody}>{text.trim() ? <AnnotatedField mission={mission} field={field} text={text} sourceRound={round.round} markdownText={markdownText} notes={fieldNotes} onSelect={setSelection} /> : <p className={s.missing}>待明确</p>}
            {controls.annotations ? <FieldAnnotationActivity notes={fieldNotes} controls={controls.annotations} /> : null}
            <RevisionHistory revisions={fieldRevisions} />
            {canDiscuss ? <div className={s.fieldActions}><Button variant="ghost" className={s.textAction} onPress={() => controls.onPropose(mission, field)}>建议修改</Button></div> : null}
            {fixes && correctVerb ? <div className={s.fieldActions}><Button variant="ghost" className={s.textAction} aria-label={`${correctVerb}：${fieldNames[field]}`} onPress={() => fixes.onOpen(mission, field)}>{correctVerb}</Button></div> : null}
            {editor}
            {fixes ? <CorrectionPanel mission={mission} field={field} label={fieldNames[field]} items={fieldFixes} access={access} deciderName={round.deciderName} controls={fixes} /> : null}
            {feedbackNotes.length ? <div className={s.remarks}>{feedbackNotes.map((item) => <FeedbackNote key={item.id} item={item} location={`${card.ownerName}的卡 · ${mission.title} · ${fieldNames[field]}`} controls={decisionControls} />)}</div> : null}
            </div>
          </section>;
        })}</div>
        {linkedItems || ownerPlan?.plan ? <LinkedTaskRows tasks={linkedItems?.[mission.missionId] ?? ownerPlan?.plan?.groups.find(group => group.missionId === mission.missionId)?.items ?? []} viewerId={viewerId} /> : null}
      </section>)}
    </div>}
    {loose.length ? <section className={s.loose} aria-label="没有指向具体字段的意见"><h2>整张卡上的意见</h2><div className={s.remarks}>{loose.map((item) => <FeedbackNote key={item.id} item={item} location={`${card.ownerName}的卡 · 整张卡`} controls={decisionControls} />)}</div></section> : null}
    {selection && controls.annotations ? <SelectionPopover key={`${selection.mission.missionId}:${selection.field}:${selection.startOffset}:${selection.quote}`} selection={selection} canCreate={round.phase === "open" && !card.ownerConfirmedAt && payload.annotationAccess.canCreate && selection.sourceRound === round.round} closedReason={selection.sourceRound !== round.round ? "审核已重新开放，请重新选中文字后批注。" : payload.annotationAccess.closedReason ?? (round.phase !== "open" ? "当前正文已冻结，重新开放审核后可继续批注。" : null)} onSave={controls.annotations.onSave} onClose={closeSelection} onQuote={() => { controls.onQuote(selection.mission, selection.field, selection.quote); closeSelection(); }} /> : null}
  </article>;
}
