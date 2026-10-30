"use client";

/**
 * 会议卡（FR-4.3–4.5、FR-5.1/5.4/5.5）：会后一张卡审阅整场会——实际时间、参会人（会名和挂点在会议页页头，编辑时才出现会名）、摘要、决策（逐条确认）、
 * 按议题的正文各段（带出处）、行动项（负责人接下才推成执行事项）、对象修改（改前 / 改后）；主持人或创建人就地编辑、停顿自动保存。
 * 10/28 起记录正文不用确认：决策都有了结果或生成满 48 小时自动定版；定版前底部只有「不写进本体」。10/28 之前的会议卡照旧整卡确认一次。
 * 定版后可「修改」（更正原记录或会后新决定），修改中改过的地方原文划线显示在新内容上方；底部逐行显示会议事件和对象修改的同步状态。
 * 别人只读：有确认版看确认版（行动项看确认时的快照），没有看草稿。
 */
import { useEffect, useState } from "react";
import type { TMeetingCardView } from "@warmap/contracts";
import { Plus } from "lucide-react";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";
import { browserApi } from "@/lib/api/client";
import { monthDayClock } from "@/lib/companyTime";
import {
  basisLabel, changeRows, companyInput, draftReady, fromCompanyInput, inFuture, itemRows, itemsReady, sectionRows, syncRows, type CardContent, type RecordTurn,
} from "./meetingCardModel";
import { ActionItemRow, type MeetingPerson } from "./ActionItemRow";
import { InlineText } from "./InlineText";
import { MeetingDecisionList } from "./MeetingDecisionList";
import { ObjectChangeDiff } from "./ObjectChangeDiff";
import { RecordCardFooter, type FooterMode } from "./RecordCardFooter";
import { RecordSection } from "./RecordSection";
import { useMeetingCard } from "./useMeetingCard";
import c from "./meeting-card.module.css";
import { MeetingTaskQuality } from "../task-quality/MeetingTaskQuality";

type MeetingRecordCardProps = {
  meetingId: string;
  /** 会议页读到（或会议卡上次交回）的最新一份会议卡。 */
  initial: TMeetingCardView;
  /** 每次拿到服务端的新视图时交回会议页（会议卡重新挂上时从最新的接着显示）。 */
  onView?: (view: TMeetingCardView) => void;
  /** 会议页已有的逐字稿发言段：展开出处时显示那几句原话；没有就不显示。 */
  turns?: RecordTurn[];
  speakerName?: (speakerId: string) => string | null;
  /** 会议页的参会人（天枢 personId）：行动项的负责人从这里选。 */
  people?: MeetingPerson[];
  /** 指定了说话人：会议页重读参会人和逐字稿。 */
  onSpeakers?: () => void;
};

const noSpeaker = () => null;
const noPeople: MeetingPerson[] = [];
const SAVE_LABEL = { idle: null, saving: "保存中", saved: "已保存", failed: "保存失败", offline: "网络不通" } as const;
const names = (content: CardContent) => content.participants.map((person) => person.name).join("、");
const NOT_IN_TIANSHU = "none";

export function MeetingRecordCard({ meetingId, initial, onView, turns = [], speakerName = noSpeaker, people = noPeople, onSpeakers }: MeetingRecordCardProps) {
  const card = useMeetingCard(meetingId, initial, onView);
  // 没对上人的说话人由主持人或创建人从人员目录里点一下指定。
  const speakers = card.view.canEdit && card.draft ? card.view.unmappedSpeakers : [];
  const [directory, setDirectory] = useState<MeetingPerson[]>([]);
  useEffect(() => {
    if (!speakers.length || directory.length) return;
    void browserApi.GET("/api/people").then(({ data }) => setDirectory(data?.people ?? []), () => undefined);
  }, [speakers.length, directory.length]);
  const speakerOptions = [...directory.map((person) => ({ value: person.personId, label: person.displayName })), { value: NOT_IN_TIANSHU, label: "不是天枢里的人" }];
  const assign = (speakerId: string, value: string) =>
    void card.assignSpeaker(speakerId, value === NOT_IN_TIANSHU ? null : value).then((done) => { if (done && value !== NOT_IN_TIANSHU) onSpeakers?.(); });

  const { view, draft, pending } = card;
  const confirmed = view.confirmed;
  const editable = view.canEdit && draft !== null && (!confirmed || card.editing);
  const content: CardContent | null = editable ? draft : confirmed?.payload ?? draft;
  if (!content) return null;
  const locked = card.busy;
  const baseline = editable && confirmed ? confirmed.payload : null;
  const was = <T,>(now: T, before: T | undefined): T | null => (baseline && before !== now ? before ?? null : null);
  const wasTitle = was(content.title, baseline?.title);
  const wasTime = was(content.occurredAt, baseline?.occurredAt);
  const wasNames = baseline ? was(names(content), names(baseline)) : null;
  const wasSummary = was(content.summary, baseline?.summary);
  const rows = sectionRows(content.sections, baseline?.sections ?? null);
  const changes = changeRows(content.objectChanges, baseline?.objectChanges ?? null);
  const items = itemRows(editable ? card.items : confirmed?.actionItems ?? view.actionItems, editable && confirmed ? confirmed.actionItems : null);
  const legacy = view.decisions === null;
  const tag = !confirmed ? (legacy ? "待确认" : null) : editable ? "修改中" : null;
  const saveLabel = editable ? SAVE_LABEL[card.saveState] : null;
  const mode: FooterMode = !view.canEdit ? "readonly" : !confirmed ? (legacy ? "first" : "open") : editable ? "editing" : "confirmed";
  const nameOf = (personId: string) => people.find((person) => person.personId === personId)?.displayName ?? personId;
  // 逐条状态按服务端此刻的（确认版的行动项快照不跟着接下、退回变）。
  const reviewOf = new Map(view.actionItems.map((item) => [item.id, item.review]));
  const timeInvalid = Boolean(draft && (card.timeRejected || inFuture(draft.occurredAt)));
  const pendingHasText = Boolean(pending && (pending.heading.trim() || pending.body.trim()));
  const ready = editable && draft !== null && !card.unsaved && card.saveState !== "saving" && !card.conflict && !pendingHasText
    && draftReady(draft) && itemsReady(card.items) && Boolean(draft.occurredAt) && !timeInvalid;
  const setOccurredAt = (value: string) => card.setOccurredAt(fromCompanyInput(value));
  const nowInput = companyInput(new Date().toISOString());
  let number = 0;
  let itemNumber = 0;

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

      {/* 会议名和挂点页头已经写了：只读时不再重复，只在编辑（能改会议名）时出现。 */}
      {editable ? (
        <div className={c.titleBlock} data-changed={wasTitle !== null ? "" : undefined}>
          {wasTitle !== null ? <del className={`${c.was} ${c.title}`}>{wasTitle}</del> : null}
          <InlineText as="h2" className={c.title} value={content.title} editable={editable} readOnly={locked} single label="会议名" invalid={!content.title.trim()}
            autoFocus={card.focus === "title"} onChange={(title) => card.edit((current) => ({ ...current, title }))} onBlur={card.leave} />
        </div>
      ) : null}
      <dl className={c.props}>
        {editable && !card.timeInFooter ? (
          <div data-changed={wasTime !== null ? "" : undefined}><dt>时间</dt><dd>
            {wasTime !== null ? <del className={c.was}>{wasTime ? monthDayClock(wasTime) : ""}</del> : null}
            <span className={c.timeField} data-invalid={timeInvalid ? "" : undefined}>
              <DateTimePicker label="实际" size="compact" value={companyInput(content.occurredAt)} max={nowInput} disabled={locked} onChange={setOccurredAt} />
            </span>
          </dd></div>
        ) : !editable && content.occurredAt ? (
          <div><dt>时间</dt><dd>{monthDayClock(content.occurredAt)}</dd></div>
        ) : null}
        {content.participants.length || wasNames ? (
          <div data-changed={wasNames !== null ? "" : undefined}><dt>参会人</dt><dd>
            {wasNames ? <del className={c.was}>{wasNames}</del> : null}
            {names(content)}
          </dd></div>
        ) : null}
        {speakers.length ? (
          <div><dt>说话人</dt><dd className={c.speakers}>
            {speakers.map((speaker) => (
              <span key={speaker.id} className={c.speaker}>
                <span>{speaker.name}</span>
                <Select aria-label={`${speaker.name}是谁`} placeholder="是谁" size="compact" className={c.ownerPicker} value="" disabled={locked}
                  options={speakerOptions} onChange={(value) => { if (value) assign(speaker.id, value); }} />
              </span>
            ))}
          </dd></div>
        ) : null}
      </dl>

      {editable || content.summary.trim() ? (
        <section className={c.block} data-changed={wasSummary !== null ? "" : undefined}>
          <h3 className={c.blockLabel}>摘要</h3>
          {wasSummary ? <del className={`${c.was} ${c.summary}`}>{wasSummary}</del> : null}
          <InlineText className={c.summary} value={content.summary} editable={editable} readOnly={locked} label="摘要"
            onChange={(summary) => card.edit((current) => ({ ...current, summary }))} onBlur={card.leave} />
        </section>
      ) : null}

      {view.decisions?.length ? (
        <MeetingDecisionList decisions={view.decisions} sections={content.sections} hostId={view.hostId} viewerId={view.viewerId} people={people}
          frozen={Boolean(confirmed)} busy={card.busy} nameOf={nameOf} onReview={card.review} onAssign={card.assignOwner} />
      ) : null}

      <section className={c.block}>
        {/* 新加的那段和其他段放在同一个列表里（同一个 key）：写全进草稿时不重新挂载，光标不丢。 */}
        {[
          ...rows.map(({ item: section, state, was: before }) => {
            const position = state === "deleted" ? null : ++number;
            const index = position === null ? -1 : position - 1;
            return (
              <RecordSection key={`${state === "deleted" ? "deleted:" : ""}${section.id}`} number={position} section={section} state={state} was={before}
                editable={editable} locked={locked} sources={content.sources} turns={turns} speakerName={speakerName}
                canMoveUp={index > 0} canMoveDown={index >= 0 && index < content.sections.length - 1} canDelete={content.sections.length > 1}
                onChange={(field, value) => card.setSection(section.id, field, value)} onLeave={card.leave}
                onMove={(delta) => card.moveSection(section.id, delta)} onDelete={() => card.deleteSection(section.id)} />
            );
          }),
          ...(editable && pending ? [
            <RecordSection key={pending.id} number={content.sections.length + 1} section={pending} state={baseline ? "changed" : "same"} fresh touched={pending.touched}
              editable locked={locked} sources={content.sources} turns={turns} speakerName={speakerName} onChange={card.setPendingField} onLeave={card.leavePending} />,
          ] : []),
        ]}
        {editable && !pending ? (
          <button type="button" className={c.add} disabled={locked} onClick={card.addSection}><Plus size={14} strokeWidth={2} aria-hidden="true" />加一段</button>
        ) : null}
      </section>

      {editable || items.length ? (
        <section className={c.block}>
          <h3 className={c.blockLabel}>行动项</h3>
          {items.length ? (
            <div className={c.items}>
              {items.map(({ item, state, was: before }) => (
                <ActionItemRow key={`${state === "deleted" ? "deleted:" : ""}${item.id}`} number={state === "deleted" ? null : ++itemNumber} item={item} state={state}
                  review={reviewOf.get(item.id)}
                  was={before} editable={editable} locked={locked} people={people} basis={basisLabel(item.basisSectionIds, content.sections)}
                  invalid={!item.text.trim() && card.leftItems.includes(item.id)}
                  onChange={(field, value) => card.setItem(item.id, field, value)} onLeave={() => card.leaveItem(item.id)} onDelete={() => card.deleteItem(item.id)} />
              ))}
            </div>
          ) : null}
          {editable ? (
            <button type="button" className={c.add} disabled={locked} onClick={card.addItem}><Plus size={14} strokeWidth={2} aria-hidden="true" />加一条</button>
          ) : null}
        </section>
      ) : null}

      {changes.length ? (
        <section className={c.block}>
          <h3 className={c.blockLabel}>对象修改</h3>
          <div className={c.changes}>
            {changes.map(({ item: change, state, was: before }) => (
              <ObjectChangeDiff key={`${state === "deleted" ? "deleted:" : ""}${change.id}`} change={change} state={state} wasAfter={before?.after.text ?? null}
                editable={editable} locked={locked} basis={basisLabel(change.basisSectionIds, content.sections)} options={view.targetOptions}
                onAfter={(text) => card.setAfter(change.id, text)} onLeave={card.leave} onTarget={(option) => card.setTarget(change.id, option)}
                onDelete={() => card.deleteChange(change.id)} />
            ))}
          </div>
        </section>
      ) : null}

      <RecordCardFooter key={`${confirmed?.confirmation.revision ?? 0}:${editable}`} mode={mode} confirmation={confirmed?.confirmation ?? null}
        rows={confirmed && view.sync ? syncRows(view.sync, confirmed.payload.objectChanges) : []}
        busy={card.busy} ready={ready} anchored={Boolean(draft?.relatedObjectRefs.length)} error={view.canEdit ? card.error : null} change={view.draftChange}
        skipWorld={confirmed ? view.sync?.writeToWorld === false : !view.writeToWorld} focusLine={card.focus === "confirmed"}
        onWorldChoice={(writeToWorld) => void card.setWorldChoice(writeToWorld)}
        time={editable && card.timeInFooter && draft ? { value: companyInput(draft.occurredAt), max: nowInput, invalid: timeInvalid, onChange: setOccurredAt } : null}
        onConfirm={(input) => void card.confirm(input)} onModify={card.startEditing} onDiscard={() => void card.discard()}
        onRetry={view.canEdit ? () => void card.retry() : undefined} />
      <MeetingTaskQuality meetingId={meetingId} revision={confirmed?.payload.revision ?? null} />
    </article>
  );
}
