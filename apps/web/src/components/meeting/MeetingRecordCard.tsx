"use client";

/**
 * 会议卡（FR-4.3–4.5、FR-5.1/5.4/5.5）：会后一张卡审阅整场会——会名和实际时间、参会人、挂点、摘要、按议题的正文各段（带出处）、
 * 对象修改（改前 / 改后）；主持人或创建人就地编辑、停顿自动保存，整卡确认一次；确认后可「修改」（更正原记录或会后新决定），
 * 底部逐行显示会议事件和对象修改的同步状态。别人只读：有确认版看确认版，没有看草稿（标「待确认」）。
 * 行动项这一版不在卡上（存草稿不交 actionItems，服务端沿用已存的）。
 */
import { useEffect, useState } from "react";
import type { TMeetingCardView, TWorldAnchor } from "@warmap/contracts";
import { Plus } from "lucide-react";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { monthDayClock } from "@/lib/companyTime";
import { getMeetingCard } from "./meetingCardApi";
import { getMeetingWorld } from "./meetingDecisionApi";
import {
  basisLabel, changedChangeIds, companyInput, draftReady, fromCompanyInput, sectionRows, syncRows, type CardContent, type RecordTurn,
} from "./meetingCardModel";
import { InlineText } from "./InlineText";
import { ObjectChangeDiff } from "./ObjectChangeDiff";
import { RecordCardFooter, type FooterMode } from "./RecordCardFooter";
import { RecordSection } from "./RecordSection";
import { useMeetingCard } from "./useMeetingCard";
import { WorldAnchors } from "./WorldAnchors";
import c from "./meeting-card.module.css";

/** 会议记录这块用会议卡还是旧的会后条目：问会议卡接口，有草稿或确认版就是会议卡；还没问到时 unknown。 */
export type CardProbe = { status: "unknown" } | { status: "legacy" } | { status: "card"; view: TMeetingCardView; key: string };
export function useMeetingCardProbe(meetingId: string, refreshKey: string): CardProbe {
  const [probe, setProbe] = useState<CardProbe>({ status: "unknown" });
  useEffect(() => {
    let live = true;
    void getMeetingCard(meetingId).then((result) => {
      if (!live) return;
      setProbe(result.ok && (result.view.draft || result.view.confirmed)
        ? { status: "card", view: result.view, key: `${meetingId}|${refreshKey}` } : { status: "legacy" });
    });
    return () => { live = false; };
  }, [meetingId, refreshKey]);
  return probe;
}

type MeetingRecordCardProps = {
  meetingId: string;
  /** 会议页刚读到的会议卡（决定用会议卡时读的那一份）。 */
  initial: TMeetingCardView;
  /** 会议页已有的逐字稿发言段：展开出处时显示那几句原话；没有就不显示。 */
  turns?: RecordTurn[];
  speakerName?: (speakerId: string) => string | null;
};

const noSpeaker = () => null;
const SAVE_LABEL = { idle: null, saving: "保存中", saved: "已保存", failed: "未保存" } as const;

export function MeetingRecordCard({ meetingId, initial, turns = [], speakerName = noSpeaker }: MeetingRecordCardProps) {
  const card = useMeetingCard(meetingId, initial);
  const [anchors, setAnchors] = useState<TWorldAnchor[]>([]);
  useEffect(() => { void getMeetingWorld(meetingId).then((detail) => setAnchors(detail?.world.anchors ?? []), () => undefined); }, [meetingId]);

  const { view, draft, pending } = card;
  const confirmed = view.confirmed;
  const editable = view.canEdit && draft !== null && (!confirmed || card.editing);
  const content: CardContent | null = editable ? draft : confirmed?.payload ?? draft;
  if (!content) return null;
  const baseline = editable && confirmed ? confirmed.payload : null;
  const rows = sectionRows(content.sections, baseline?.sections ?? null);
  const changedChanges = changedChangeIds(content.objectChanges, baseline?.objectChanges ?? null);
  const tag = !confirmed ? "待确认" : editable ? "修改中" : null;
  const saveLabel = editable ? SAVE_LABEL[card.saveState] : null;
  const mode: FooterMode = !view.canEdit ? "readonly" : !confirmed ? "first" : editable ? "editing" : "confirmed";
  const pendingHasText = Boolean(pending && (pending.heading.trim() || pending.body.trim()));
  const ready = editable && draft !== null && !card.unsaved && card.saveState !== "saving" && !card.conflict && !pendingHasText
    && draftReady(draft) && Boolean(draft.occurredAt);
  const setOccurredAt = (value: string) => card.edit((current) => ({ ...current, occurredAt: fromCompanyInput(value) }), true);
  const nowInput = companyInput(new Date().toISOString());
  let number = 0;

  return (
    <article className={c.card} aria-label="会议记录">
      {tag || saveLabel ? (
        <div className={c.topLine}>
          {tag ? <span className={c.tag}>{tag}</span> : null}
          {saveLabel ? <span className={c.saveState} data-state={card.saveState}>{saveLabel}</span> : null}
        </div>
      ) : null}
      {card.conflict ? (
        <div className={c.conflict} role="status">
          <span>内容已更新</span>
          <button type="button" className={c.link} disabled={card.busy} onClick={() => void card.reload()}>查看最新</button>
        </div>
      ) : null}

      <InlineText as="h2" className={c.title} value={content.title} editable={editable} single label="会议名" invalid={!content.title.trim()}
        onChange={(title) => card.edit((current) => ({ ...current, title }))} onBlur={card.leave} />
      <dl className={c.props}>
        {editable && !card.timeInFooter ? (
          <div><dt>时间</dt><dd><DateTimePicker label="实际" size="compact" value={companyInput(content.occurredAt)} max={nowInput} onChange={setOccurredAt} /></dd></div>
        ) : !editable && content.occurredAt ? (
          <div><dt>时间</dt><dd>{monthDayClock(content.occurredAt)}</dd></div>
        ) : null}
        {content.participants.length ? <div><dt>参会人</dt><dd>{content.participants.map((person) => person.name).join("、")}</dd></div> : null}
        {anchors.length ? <div><dt>挂到</dt><dd><WorldAnchors anchors={anchors} /></dd></div> : null}
      </dl>

      {editable || content.summary.trim() ? (
        <section className={c.block} data-changed={baseline && baseline.summary !== content.summary ? "" : undefined}>
          <h3 className={c.blockLabel}>摘要</h3>
          <InlineText className={c.summary} value={content.summary} editable={editable} label="摘要"
            onChange={(summary) => card.edit((current) => ({ ...current, summary }))} onBlur={card.leave} />
        </section>
      ) : null}

      <section className={c.block}>
        {/* 新加的那段和其他段放在同一个列表里（同一个 key）：写全进草稿时不重新挂载，光标不丢。 */}
        {[
          ...rows.map(({ section, state }) => {
            const position = state === "deleted" ? null : ++number;
            const index = position === null ? -1 : position - 1;
            return (
              <RecordSection key={`${state === "deleted" ? "deleted:" : ""}${section.id}`} number={position} section={section} state={state} editable={editable}
                sources={content.sources} turns={turns} speakerName={speakerName}
                canMoveUp={index > 0} canMoveDown={index >= 0 && index < content.sections.length - 1} canDelete={content.sections.length > 1}
                onChange={(field, value) => card.setSection(section.id, field, value)} onLeave={card.leave}
                onMove={(delta) => card.moveSection(section.id, delta)} onDelete={() => card.deleteSection(section.id)} />
            );
          }),
          ...(editable && pending ? [
            <RecordSection key={pending.id} number={content.sections.length + 1} section={pending} state={baseline ? "changed" : "same"} fresh editable
              sources={content.sources} turns={turns} speakerName={speakerName} onChange={card.setPendingField} onLeave={card.leavePending} />,
          ] : []),
        ]}
        {editable && !pending ? (
          <button type="button" className={c.add} onClick={card.addSection}><Plus size={14} strokeWidth={2} aria-hidden="true" />加一段</button>
        ) : null}
      </section>

      {content.objectChanges.length ? (
        <section className={c.block}>
          <h3 className={c.blockLabel}>对象修改</h3>
          <div className={c.changes}>
            {content.objectChanges.map((change) => (
              <ObjectChangeDiff key={change.id} change={change} editable={editable} changed={changedChanges.has(change.id)}
                basis={basisLabel(change.basisSectionIds, content.sections)} options={view.targetOptions}
                onAfter={(text) => card.setAfter(change.id, text)} onLeave={card.leave} onTarget={(option) => card.setTarget(change.id, option)} />
            ))}
          </div>
        </section>
      ) : null}

      <RecordCardFooter key={`${confirmed?.confirmation.revision ?? 0}:${editable}`} mode={mode} confirmation={confirmed?.confirmation ?? null}
        rows={view.canEdit && confirmed && view.sync ? syncRows(view.sync, confirmed.payload.objectChanges) : []}
        busy={card.busy} ready={ready} error={view.canEdit ? card.error : null} skipWorld={view.sync?.writeToWorld === false}
        time={editable && card.timeInFooter && draft ? { value: companyInput(draft.occurredAt), max: nowInput, onChange: setOccurredAt } : null}
        onConfirm={(input) => void card.confirm(input)} onModify={card.startEditing} onDiscard={() => void card.discard()} onRetry={() => void card.retry()} />
    </article>
  );
}
