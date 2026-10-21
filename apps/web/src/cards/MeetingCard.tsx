"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileUp, Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { browserApi, type CardAction } from "@/lib/api/client";
import type { TMeetingDecisionHistoryResponse, TTranscriptCandidateProjection } from "@warmap/contracts";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { issueScopeLabel } from "./scopeNames";
import { useConfirm } from "@/components/ConfirmDialog";
import { SelectionToolbar, useSelectionQuote } from "@/components/SelectionQuote";
import { MeetingClock, MeetingHeaderActions, MeetingStatus, meetingDayWord, meetingPhase, meetingSlot, useMeetingTimeline } from "@/components/meeting/MeetingHeader";
import { useMeetingRecorder, type RecorderState } from "@/components/meeting/useMeetingRecorder";
import { MaterialPane, useMaterialPreview, type MaterialMeta } from "@/components/meeting/meetingMaterialPreview";
import { IssueDecisionBlock } from "@/components/meeting/IssueDecisionBlock";
import type { HistoryView } from "@/components/meeting/DecisionHistoryLayers";
import { MeetingOutline, saveReadingPosition, useOutlineSpy, useReadingAnchor, useRestoreReadingPosition, type OutlineItem } from "@/components/meeting/MeetingOutline";
import { SourceList, SourceNavigatorProvider, useSourceNavigator, type SourceObject } from "@/components/meeting/SourceViewer";
import { DECISION_HISTORY_CHANGED, useDecisionHistory } from "@/components/meeting/useDecisionHistory";
import { PreflightProgress } from "@/components/meeting/PreflightProgress";
import { DivergencesSection, LensAnswers, MaterialQuestionsSection } from "@/components/meeting/PreflightReviewExtras";
import { announceMeetingCard, listenMeetingCard } from "@/lib/meetingSync";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { Button, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { ESCAPE_BACK_ATTR, ESCAPE_BACK_EVENT } from "@/components/shell/escapeChain";
import { useRememberedScroll, type MaterialTab } from "@/components/shell/MaterialTabs";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { escapeToSegment, initialMeetingView, meetingSegments, noPreflightContent, pickMaterial, pickSegment, selectedSegment, type MeetingView } from "./meetingView";
import { ObjectMaterialArea } from "@/components/materials/ObjectMaterialArea";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { calendarDate, COMPANY_TIMEZONE } from "@/lib/companyTime";
import { cleanDisplayText, isPastDue, materialTitle, stripInternalRefs } from "@/lib/displayText";
import { ActionFeedback, useCardAction, type ActionState } from "@/lib/useCardAction";
import { useUndoWindow } from "@/lib/undoWindow";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";
import { groupPreflight } from "./preflightOutline";
import { attributeEntries, groupOutcomeByIssue, ISSUE_STATUS_LABEL, outcomeIssueId, preflightInFlight, preflightStatusText, speakerLabel, type PreflightEntry } from "./meetingIssueModel";
import { buildHistoryIndex, outcomeAnchorId, type SourceContext, type SourceMaterial } from "./meetingSources";
import { MeetingDecisions } from "@/components/meeting/MeetingDecisions";
import s from "@/styles/meeting-workspace.module.css";

export { MaterialPane, materialMeta, previewKind, type MaterialMeta, type MaterialPreview } from "@/components/meeting/meetingMaterialPreview";

/** 成员视角的会议卡：实际参会的人才带完整纪要摘要（服务端按飞书参会名单裁剪）。 */
export function memberOutcomeSummary(payload: { outcome?: unknown }): string | null {
  const summary = (payload.outcome as { summary?: unknown } | null | undefined)?.summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}


const ITEM_LABEL: Record<string, string> = {
  decision: "决定",
  todo: "普通待办",
  ceoJudgment: "CEO 判断",
  reopenWhen: "复议条件",
  open: "未收敛事项",
  strategic: "战略议题",
};

const EXPORT_LABEL: Record<string, string> = {
  pending_export: "待外发",
  delivered: "已送达",
  failed: "外发失败",
};

const INPUT_LABEL: Record<string, string> = { available: "已具备", derived: "据现有资料推断", missing: "待补" };

/** 预审过期提示：哪份群材料从 vN 变成 vM、新增或删除了什么、有几条新讨论（feedback 12）。 */
function preflightStaleText(preflight: MeetingPayload["preflight"]): string {
  const stale = preflight.staleInputs;
  const materials = stale?.materials ?? [];
  const parts = materials.slice(0, 3).map((material) =>
    material.change === "updated" ? `《${materialTitle(material.fileName)}》预审基于 v${material.usedVersion}，当前已是 v${material.currentVersion}`
      : material.change === "added" ? `新增《${materialTitle(material.fileName)}》未进入本次预审`
        : `《${materialTitle(material.fileName)}》已删除`);
  if (materials.length > 3) parts.push(`另有 ${materials.length - 3} 份材料变化`);
  if (stale?.newDiscussionCount) parts.push(`群里新增 ${stale.newDiscussionCount} 条讨论`);
  // 生成期间资料就变了：即使已知是哪份材料升版，也要明说“生成期间”，不让人以为报告生成时用的是最新资料。
  const lead = preflight.inputsChangedDuringRun ? "预审生成期间资料有更新" : "资料已更新";
  return `${lead}：${parts.join("；") || "本报告未基于最新资料"}。可重新预审。`;
}

/** 预审失败原因给 CEO 看的说法：服务端原话带内部名词（Preflight、sourceRef…）时换成中文说明；原话仍在预审记录里便于排查。 */
const PREFLIGHT_ERROR_TEXT: Record<string, string> = {
  invalid_source_ref: "本次预审有依据与该会议资料不符，结果未保存。",
  invalid_preflight_candidate: "本次预审返回内容不完整，结果未保存。",
};
export function preflightErrorText(error: { code: string; message: string }): string {
  if (!/[A-Za-z]{3,}/.test(error.message)) return error.message;
  return PREFLIGHT_ERROR_TEXT[error.code] ?? "本次预审未完成。";
}

const MATERIAL_ACCEPT = "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md";

/** 人员目录投影：人员映射下拉与编辑会议的主持人下拉共用这一份结构。 */
export type DirectoryOption = { personId: string; displayName: string; roles: string[] };

/** 长文本截断：回应出处与 aria-label 用。 */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 语义 1（决策书）：materials[] 内 kind 打标；缺省 kind = primary，旧数据免迁移。 */
export function splitMaterials<T extends { id: string; kind?: string }>(materials: T[]): { primary: T[]; supplements: T[] } {
  return {
    primary: materials.filter((material) => material.kind !== "supplement"),
    supplements: materials.filter((material) => material.kind === "supplement"),
  };
}

/** 补充材料上传的 documented contract：multipart `files`（单份）+ `requestId`。 */
export function buildSupplementForm(requestId: string, file: File): FormData {
  const form = new FormData();
  form.append("files", file);
  form.append("requestId", requestId);
  return form;
}

export type SpeakerMappingRow = {
  speakerName: string;
  turnCount: number;
  personId: string;
  suggestedPersonId: string | null;
  suggestedDisplayName: string | null;
  status: "existing" | "add" | "unmapped";
};

/** 映射表状态：已参与 / 确认后加入 / 未映射；几个说话人可以对到同一个人。 */
export function speakerMappingRows(
  candidate: TTranscriptCandidateProjection,
  participantIds: string[],
  mappings: Record<string, string>,
): SpeakerMappingRow[] {
  return candidate.speakers.map((speaker) => {
    const personId = mappings[speaker.speakerName] ?? speaker.suggestedPersonId ?? "";
    return {
      speakerName: speaker.speakerName,
      turnCount: speaker.turnCount,
      personId,
      suggestedPersonId: speaker.suggestedPersonId,
      suggestedDisplayName: speaker.suggestedDisplayName,
      status: personId ? (participantIds.includes(personId) ? "existing" : "add") : "unmapped",
    };
  });
}

export function speakerMappingError(rows: SpeakerMappingRow[]): string | null {
  const unmapped = rows.filter((row) => !row.personId).length;
  if (unmapped > 0) return `还有 ${unmapped} 位说话人未映射，确认不可用`;
  return null;
}

/** 相对时间：秒 → mm:ss 或 h:mm:ss。 */
export function offsetLabel(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

const MAPPING_STATUS_LABEL = { existing: "已是参与人", add: "确认后加入", unmapped: "未映射" } as const;

/** 确认 Action input：只含 speakerName→personId 与显式标记，全量 turns 留在服务端。 */
export function confirmTranscriptInput(
  candidate: TTranscriptCandidateProjection,
  mappings: Record<string, string>,
): { speakerMappings: { speakerName: string; personId: string }[]; confirmAddParticipants: true } {
  return {
    speakerMappings: candidate.speakers.map((speaker) => ({
      speakerName: speaker.speakerName,
      personId: mappings[speaker.speakerName],
    })),
    confirmAddParticipants: true,
  };
}

/**
 * 妙记 Markdown 候选预览（设计 aB4pK）：只读来源摘要 + 说话人映射 + 时间锚点 + 抽样发言；
 * 确认把 mapping 交给 opaque Action，全量 turns 不进入浏览器 Action input。
 */
export function TranscriptCandidateDialog({
  dialogRef,
  candidate,
  scheduledAt,
  participants,
  directory,
  directoryError,
  pending,
  state,
  hasConfirm,
  hasDiscard,
  onRetry,
  onClose,
  onConfirm,
  onDiscard,
}: {
  dialogRef: { current: HTMLDialogElement | null };
  candidate: TTranscriptCandidateProjection;
  scheduledAt: string;
  participants: { personId: string }[];
  directory: DirectoryOption[];
  directoryError: string | null;
  pending: boolean;
  state: ActionState;
  hasConfirm: boolean;
  hasDiscard: boolean;
  onRetry: () => void;
  onClose: () => void;
  onConfirm: (mappings: Record<string, string>) => void;
  onDiscard: () => void;
}) {
  const [mappings, setMappings] = useState<Record<string, string>>(() =>
    Object.fromEntries(candidate.speakers.map((speaker) => [speaker.speakerName, speaker.suggestedPersonId ?? ""])),
  );
  const rows = speakerMappingRows(candidate, participants.map((person) => person.personId), mappings);
  const error = speakerMappingError(rows);
  return (
    <dialog ref={dialogRef} className={s.candidateDialog} aria-label="妙记会议记录候选">
      <header className={s.candidateHeader}>
        <div>
          <h2>确认妙记会议记录</h2>
          <p>
            {candidate.source.fileName} · {Math.ceil(candidate.source.sizeBytes / 1024)} KB · SHA-256 {candidate.source.sha256.slice(0, 12)}…
          </p>
          <p>
            {candidate.turnCount} 条发言 · {candidate.speakerCount} 位说话人 · 时长 {offsetLabel(candidate.durationSeconds)} · 解析器 {candidate.source.parserVersion}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭会议记录预览">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className={s.candidateBody}>
        <section className={s.candidateSection}>
          <h3>时间锚点</h3>
          <p>
            会议时间 {scheduledAt.slice(0, 16).replace("T", " ")} · 首段 +{offsetLabel(candidate.firstOffsetSeconds)} · 末段 +
            {offsetLabel(candidate.lastOffsetSeconds)}
          </p>
        </section>
        <section className={s.candidateSection}>
          <h3>说话人映射</h3>
          <table className={s.mappingTable}>
            <thead>
              <tr>
                <th>来源说话人</th>
                <th>发言数</th>
                <th>对应人员</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.speakerName} data-status={row.status}>
                  <td>{row.speakerName}</td>
                  <td>{row.turnCount}</td>
                  <td>
                    <div style={{ maxWidth: 220 }}><Select
                      aria-label={`映射 ${row.speakerName}`}
                      size="compact"
                      placeholder="请选择人员"
                      value={row.personId}
                      disabled={pending}
                      onChange={(value) => setMappings({ ...mappings, [row.speakerName]: value })}
                      options={[
                        ...(row.suggestedPersonId && !directory.some((person) => person.personId === row.suggestedPersonId)
                          ? [{ value: row.suggestedPersonId, label: row.suggestedDisplayName ?? row.suggestedPersonId }] : []),
                        ...directory.map((person) => ({ value: person.personId, label: person.displayName })),
                      ]}
                    /></div>
                  </td>
                  <td>{MAPPING_STATUS_LABEL[row.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {directoryError ? <p className={s.error} role="alert">{directoryError}</p> : null}
          {error ? <p className={s.error} role="alert">{error}</p> : null}
        </section>
        <section className={s.candidateSection}>
          <h3>抽样发言</h3>
          <ol className={s.sampleTurns}>
            {candidate.sampleTurns.map((turn, index) => (
              <li key={`${turn.offsetSeconds}-${index}`}>
                <span>{offsetLabel(turn.offsetSeconds)} · {turn.speakerName}</span>
                <p>{turn.text}</p>
              </li>
            ))}
          </ol>
        </section>
        {candidate.warnings.length ? (
          <section className={s.candidateSection}>
            <h3>提示</h3>
            <ul className={s.warnings}>
              {candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </section>
        ) : null}
        <ActionFeedback state={state} onRetry={onRetry} />
      </div>
      <footer className={s.candidateFooter}>
        {hasDiscard ? (
          <button type="button" className={s.candidateDiscard} disabled={pending} onClick={onDiscard}>
            清除候选
          </button>
        ) : null}
        <span className={s.candidateSpacer} />
        <button type="button" className={s.candidateCancel} onClick={onClose}>
          关闭
        </button>
        {hasConfirm ? (
          <button type="button" className={s.candidateConfirm} disabled={pending || Boolean(error)} onClick={() => onConfirm(mappings)}>
            {pending ? "确认中…" : "确认并写入逐字稿"}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}

/** datetime-local 的值 ↔ 后台时刻：一律按公司时区（上海，无夏令时）读写，不按浏览器所在时区。 */
export function toCompanyInput(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const date = at.toLocaleDateString("en-CA", { timeZone: COMPANY_TIMEZONE });
  const time = at.toLocaleTimeString("en-GB", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}T${time}`;
}

export function fromCompanyInput(value: string): string {
  return `${value}:00+08:00`;
}

/** 会中那一行灰字里「这一刻的一件事」：录没录上。 */
export function recorderLine(state: RecorderState): string {
  if (state.status === "recording") return "录音中";
  if (state.status === "starting") return "正在打开麦克风";
  return state.error ?? "没有录音";
}

/** 计时弹出那一小块里只放录音出的问题；录音中 / 会议中由计时胶囊上的小字表明。 */
export function recordingNote(state: RecorderState): string {
  return state.status === "recording" ? "" : state.error ?? "";
}

const PREFLIGHT_TAB: MaterialTab = { id: "preflight", label: "AI 预审", title: "AI 预审：会前材料的评审结论" };
/** 整场会的那一页：会开完了，页头「会前预审 ｜ 会议记录」里的后一段；在这里导入妙记或逐字稿、逐项复核。 */
const RECORD_TAB: MaterialTab = { id: "record", label: "会议记录", title: "会议记录：妙记或逐字稿与会后复核" };
/** 会中录音与「开始会议」／计时留到下一版（用户 2026-09-29 定）：代码保留，这一版页头不放；会后照常导入会议记录。 */
const MEETING_CLOCK_ENABLED = false;

/** 材料页签上的短名：去掉扩展名，补充材料前面写「补充」。 */
export function materialTab(material: MaterialMeta): MaterialTab {
  const name = materialTitle(material.fileName).replace(/\.(pdf|docx|md)$/i, "");
  return { id: material.id, label: material.kind === "supplement" ? `补充 · ${name}` : name, title: `会议材料：${materialTitle(material.fileName)}` };
}

type OutcomeItem = NonNullable<MeetingPayload["outcome"]>["items"][number];

/** 子决定：指向同一场会里另一条决定的决定（随主决定确认 / 忽略 / 撤回）。 */
export function isChildDecision(items: OutcomeItem[], item: OutcomeItem): boolean {
  return item.kind === "decision" && Boolean(item.parentItemId) && items.some((candidate) => candidate.id === item.parentItemId && candidate.kind === "decision");
}

/** Action Item 归谁：抽取给了负责人就是他，没有就是这场会的主持人（和服务端推送同一条规则）。 */
export function actionOwner(item: OutcomeItem, payload: MeetingPayload): string {
  return item.ownerPersonId ?? payload.leadDriId;
}

/** 纪要里每一条此刻的状态：给人看的一句话，和一个状态色。 */
export function outcomeItemState(item: OutcomeItem, payload: MeetingPayload, name: (personId: string) => string): { state: "confirmed" | "dismissed" | "open" | "pending"; label: string } {
  const status = item.review?.status;
  if (item.kind === "open") return { state: "open", label: "仅展示，不产生效果" };
  if (item.kind === "strategic") {
    if (status === "confirmed") return { state: "confirmed", label: "CEO 已确认 · 本体待 Co-Agent 更新" };
    if (status === "dismissed") return { state: "dismissed", label: "CEO 不同意" };
    return { state: "pending", label: "待 CEO 确认" };
  }
  if (item.kind === "todo") {
    const owner = actionOwner(item, payload);
    if (status === "confirmed") return { state: "confirmed", label: item.review?.effectRef?.startsWith("task:") ? `已推给${name(owner)}` : "已确认" };
    if (status === "dismissed") return { state: "dismissed", label: "已忽略" };
    return { state: "pending", label: owner === payload.ceoParticipantId ? "一号位事项，仅记入纪要" : "未推送" };
  }
  if (status === "confirmed") return { state: "confirmed", label: "已确认" };
  if (status === "dismissed") return { state: "dismissed", label: "已忽略" };
  return { state: "pending", label: "待处理" };
}

/** 待办事项的一行总结：按实际推送情况写，不把没推送的也说成「已推给负责人」（巡检 P2-22）。待办会后自动推给负责人，这里只看不办。 */
export function actionCountText(items: OutcomeItem[]): string {
  const pushed = items.filter((item) => item.review?.status === "confirmed" && item.review.effectRef?.startsWith("task:")).length;
  if (pushed && pushed === items.length) return `${items.length} 项待办已推给负责人`;
  return pushed ? `${items.length} 项待办 · ${pushed} 项已推给负责人` : `${items.length} 项待办`;
}

/** 会议共识按主决定分组：子决定（parentItemId 指向同场会的主决定）挂在主决定下面，随主决定一起确认。 */
export function decisionGroups(decisions: OutcomeItem[], all: OutcomeItem[]): { item: OutcomeItem; children: OutcomeItem[] }[] {
  return decisions.filter((item) => !isChildDecision(all, item))
    .map((item) => ({ item, children: all.filter((child) => child.parentItemId === item.id && isChildDecision(all, child)) }));
}

/** 子决定此刻写什么：跟着主决定走——主决定在撤回窗口里时写它的结果，否则写自己的（待处理时不写）。 */
export function childDecisionLabel(child: OutcomeItem, parentHeld: "confirm" | "dismiss" | null): { state: "confirmed" | "dismissed"; label: string } | null {
  if (parentHeld) return parentHeld === "confirm" ? { state: "confirmed", label: "已确认" } : { state: "dismissed", label: "已忽略" };
  if (child.review?.status === "confirmed") return { state: "confirmed", label: "已确认" };
  if (child.review?.status === "dismissed") return { state: "dismissed", label: "已忽略" };
  return null;
}

/** 撤回窗口里（还没提交）这一条写什么：和提交后的说法一致。 */
export function heldItemLabel(item: OutcomeItem, kind: "confirm" | "dismiss", name: (personId: string) => string, payload: MeetingPayload): string {
  if (kind === "dismiss") return item.kind === "strategic" ? "不同意" : "已忽略";
  return item.kind === "todo" ? `推送给${name(actionOwner(item, payload))}` : "已确认";
}

/** 会议录音的几步（服务端实际先后：转码 → 上传 → 识别）。 */
export const RECORDING_LABEL: Record<NonNullable<MeetingPayload["recording"]>["status"], string> = {
  recording: "录音中",
  transcoding: "正在转码",
  uploading: "正在上传",
  transcribing: "正在识别",
  done: "已转成文字",
  failed: "转写失败",
};

/** 录音交给服务端之后、识别完之前：页面每几秒取一次会议卡片，等说话人对应弹出来。 */
export const MEETING_POLL_MS = 5000;
/** 会前预审进行中：每两秒取一次，过程一步一步跟上。 */
export const PREFLIGHT_POLL_MS = 2000;

/** 会议页要不要每 5 秒重取卡片：会前预审还在跑、录音转写中、会后抽取中（成员只读视图不取，它的卡片走成员接口）。 */
export function meetingNeedsPolling(payload: MeetingPayload, memberReadOnly = false): boolean {
  if (memberReadOnly) return false;
  if (preflightInFlight(payload)) return true;
  const extracting = payload.status === "held" && (payload.outcome?.status === "pending" || payload.outcome?.status === "running");
  return recordingInFlight(payload.recording) || extracting;
}

export function recordingInFlight(recording: MeetingPayload["recording"]): boolean {
  return recording?.status === "transcoding" || recording?.status === "uploading" || recording?.status === "transcribing";
}

/** 材料上面那一行灰字里「这一刻的一件事」。 */
export function meetingNow(payload: MeetingPayload, ended: boolean): string {
  if (payload.status === "cancelled") return "已取消";
  if (payload.status === "reviewed") return "会后事项已处理完";
  if (payload.status === "held") {
    if (payload.outcome?.status !== "ready") return "正在整理纪要";
    return payload.outcome.items.some((item) => item.kind === "strategic" && item.review?.status === "pending") ? "纪要已生成 · 待 CEO 确认战略议题" : "纪要已生成";
  }
  if (ended && payload.transcriptCandidate) return "会议记录待确认说话人";
  if (ended && recordingInFlight(payload.recording)) return "录音转写中";
  if (ended && payload.recording?.status === "failed") return "录音转写失败，可导入妙记";
  if (ended && payload.minutesStatus === "waiting") return "妙记生成中";
  if (ended) return "待导入会议记录";
  return preflightStatusText(payload.preflight);
}

/**
 * Meeting 页面（clark 会议二级页，C-08）：矩形页头里是计划时段、会名、材料下拉钮（AI 预审 + 每一份会前材料 +
 * 添加材料）、会开完了的「会前预审 ｜ 会议记录」两段切换（会前没有会议记录入口；开始会议／计时这一版不放，见 MEETING_CLOCK_ENABLED）；页头下面一行状态，再下面是正在看的那一份。
 * 会前预审、妙记导入、会后逐项复核这些真实功能都在：AI 预审（编辑会议、返回编辑材料、重新预审在它顶部）、材料（只读预览）、
 * 会议记录（导入与复核）。
 */
/** 两句话去掉标点空白后是否一样（或一句包含另一句）：原话和条目重复时不再并排摆两遍。 */
const normSentence = (value: string) => value.replace(/[\s，。；：、,.;:！？!?“”"'「」《》（）()|·-]/g, "");
export const sameSentence = (a: string, b: string) => {
  const x = normSentence(a);
  const y = normSentence(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  // 纪要表格行（「负责人 | 事项 | 做法 | 时间」）改写出来的原话：每一格都已写在条目里，就是同一件事说了两遍（巡检 P2-27）。
  const cells = a.split(/\s*[|·：；]\s*/).map(normSentence).filter(Boolean);
  return cells.length >= 2 && cells.every((cell) => y.includes(cell));
};

export function MeetingCard({ card, collection, onCard, onNavigate, readOnly: memberReadOnly = false }: CardRenderProps & { readOnly?: boolean }) {
  const source = payloadOf<MeetingPayload & { purpose?: string | null }>(card);
  const workspace = useWorkspace();
  const isHost = source.leadDriId === workspace.viewerId;
  // 成员响应只带可见事实；组件内部补空值以复用 CEO 的页头、材料和预审排版。
  const payload: MeetingPayload & { purpose?: string | null } = memberReadOnly ? {
    ...source,
    issueIds: [], ceoParticipantId: "", originRef: null,
    preflight: { status: source.preflight.status, pendingSince: null, runId: null, entries: [], basis: "",
      brief: source.preflight.brief, error: null, generatedAt: null,
      ...(source.preflight.readiness ? { readiness: source.preflight.readiness } : {}),
      ...(source.preflight.summary ? { summary: source.preflight.summary } : {}) },
    draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
    transcript: null, transcriptCandidate: isHost ? source.transcriptCandidate ?? null : null, recording: null,
  } : source;
  const { homeCards } = workspace;
  const { ask, dialog: confirmDialog } = useConfirm();
  // 会后事项先留 5 秒撤回再提交：到点时从最新的会议 Card 取动作（每处理一条版本 +1），并且一条接一条地发。
  const latestCard = useRef(card);
  if (card.version >= latestCard.current.version) latestCard.current = card;
  const updateCard = (updated: CardRenderProps["card"]) => {
    if (updated.version >= latestCard.current.version) latestCard.current = updated;
    onCard(updated);
    window.dispatchEvent(new Event("meeting-changed"));
    // 会议页办完的事（确认 / 忽略 / 撤回…）让左栏马上换上最新的会议 Card。
    announceMeetingCard(updated, "page");
  };
  const { state, run, retry, pending } = useCardAction(updateCard);
  // 左栏战略变更卡上办完的确认 / 忽略 / 撤回（服务端已提交）：合并最新会议 Card，并重读关联议题与历史分层，「会议共识」不用等左栏的撤回窗口结束。
  const syncRef = useRef<(updated: typeof card) => void>(() => undefined);
  syncRef.current = (updated) => {
    if (memberReadOnly || updated.objectRef.id !== card.objectRef.id || updated.version <= latestCard.current.version) return;
    latestCard.current = updated;
    onCard(updated);
    const issueIds = (payloadOf<MeetingPayload>(updated).issueIds ?? []);
    void Promise.all(issueIds.map(async (id) => (await browserApi.GET("/api/cards/issues/{id}", { params: { path: { id } } })).data?.cards?.[0]))
      .then((next) => next.forEach((issue) => { if (issue) onCard(issue); }), () => undefined)
      .finally(() => window.dispatchEvent(new CustomEvent(DECISION_HISTORY_CHANGED, { detail: { issueId: issueIds[0] } })));
  };
  useEffect(() => listenMeetingCard("page", (updated) => syncRef.current(updated)), []);
  const itemUndo = useUndoWindow<"confirm" | "dismiss">();
  const commitChain = useRef<Promise<unknown>>(Promise.resolve());
  const [note, setNote] = useState(payload.draft.note);
  const [supplementText, setSupplementText] = useState("");
  const [supplementEntry, setSupplementEntry] = useState("");
  const [supplementTarget, setSupplementTarget] = useState(payload.leadDriId);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // 补充材料：仅 scheduled 渲染入口；状态只存内存，成功后由后端返回的新 Card 驱动。
  const [supplementBusyId, setSupplementBusyId] = useState<string | null>(null);
  const [supplementError, setSupplementError] = useState<string | null>(null);
  // 编辑会议弹层：只提交改动字段，写入走 opaque action meeting.edit_details。
  const [editOpen, setEditOpen] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const detailsForm = () => ({ title: card.title, scheduledAt: toCompanyInput(payload.scheduledAt), endsAt: toCompanyInput(payload.endsAt), leadDriId: payload.leadDriId });
  const [editForm, setEditForm] = useState(detailsForm);
  const [driOptions, setDriOptions] = useState<DirectoryOption[]>([]);
  const [driError, setDriError] = useState<string | null>(null);
  // 妙记候选：全量人员目录 + 预览弹层；候选变化（重上传）时靠 key 重置映射。
  const [candidateOpen, setCandidateOpen] = useState(Boolean(payload.transcriptCandidate));
  const [directory, setDirectory] = useState<DirectoryOption[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // 左侧阅读区看哪一份（cards/meetingView）：会前只有会前预审；会开完了、有待确认的会议记录或已在复核，页头出「会前预审 ｜ 会议记录」两段，默认会议记录（那是下一步要做的事）。
  const meetingHeld = payload.status === "held" || payload.status === "reviewed" || (payload.status === "scheduled" && Boolean(payload.hasEnded || payload.endedAt || payload.transcriptCandidate));
  const [view, setView] = useState<MeetingView>(() => initialMeetingView(meetingHeld));
  // 正在看某份材料（某份文件）时，Esc 先回到上次选中的那一段，再按一次才离开会议页（巡检 P1-14）。
  const viewingMaterialFile = selectedSegment(view) === null;
  useEffect(() => {
    if (!viewingMaterialFile) return;
    const back = () => setView(escapeToSegment);
    window.addEventListener(ESCAPE_BACK_EVENT, back);
    return () => window.removeEventListener(ESCAPE_BACK_EVENT, back);
  }, [viewingMaterialFile]);
  // 「开始会议」计时是这一页的状态（和概念版一样），同时开始录音；「这场会开完了」停下录音交给服务端转写，并写进后台。
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const recorder = useMeetingRecorder(card.objectRef.id);
  const workspaceRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const materialRef = useRef<HTMLInputElement>(null);
  const candidateDialog = useRef<HTMLDialogElement>(null);

  const actions = memberReadOnly ? card.actions.filter((action) => isHost && ["meeting.end", "meeting.reschedule", "meeting.confirm_transcript_candidate", "meeting.discard_transcript_candidate"].includes(action.actionType)) : card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const itemAction = (type: string, itemId: string) =>
    actions.find((action) => action.actionType === type && action.itemId === itemId);

  const issues = collection.filter((item) => item.kind === "issue");
  const issueById = new Map(issues.map((item) => [item.objectRef.id, item]));
  const people = new Map(payload.participants.map((person) => [person.personId, person.displayName]));
  const dri = payload.participants.filter((person) => person.roles.includes("dri"));
  const readOnly = memberReadOnly || payload.status !== "scheduled";
  const viewedMaterial = payload.materials.find((material) => material.id === view.current) ?? null;

  const meetingId = card.objectRef.id;
  const readingKey = `meeting:${meetingId}|${view.current}`;
  useRememberedScroll(`${card.objectRef.id}|${view.current}`);
  // 跳到外部信号、别的会议后再回来：回到离开前读到的议题（必须在 useRememberedScroll 之后）。
  useRestoreReadingPosition(readingKey, mainRef, !memberReadOnly);
  const preview = useMaterialPreview(meetingId, viewedMaterial?.id);

  // 每个关联议题的三层历史（仍有效决定 / 此后变化 / 本次待判断）：议题或会议 Card 变了、对话里改了业务都重读。
  const historyRevision = [card.version, ...payload.issueIds.map((id) => issueById.get(id)?.version ?? 0)].join(".");
  const meetingHistory = useDecisionHistory<TMeetingDecisionHistoryResponse>(
    !memberReadOnly && payload.issueIds.length ? `/api/meetings/${meetingId}/history` : null, historyRevision);
  const histories = useMemo(() => meetingHistory.data?.issues ?? [], [meetingHistory.data]);
  const issueHistory = (issueId: string): HistoryView => ({
    status: meetingHistory.status,
    error: meetingHistory.error,
    reload: meetingHistory.reload,
    data: histories.find((history) => history.issueId === issueId) ?? null,
  });

  // 依据解析用的页面事实：预审快照里的材料版本、报告之后的新版本、旧会前材料、历史分层、相关会议名。
  const evidence = payload.preflight.inputCoverage?.evidence;
  const staleMaterials = payload.preflight.staleInputs?.materials;
  const sourceContext = useMemo<SourceContext>(() => {
    const materials = new Map<string, SourceMaterial>();
    for (const material of staleMaterials ?? []) materials.set(material.id, { objectType: material.objectType, objectId: material.objectId, fileName: material.fileName });
    for (const material of evidence?.materials ?? []) {
      materials.set(material.id, { objectType: material.objectType, objectId: material.objectId, fileName: material.fileName,
        format: material.format, version: material.version, state: material.state });
    }
    const titles = new Map(collection.filter((item) => item.kind === "issue").map((item) => [item.objectRef.id, item.title] as [string, string]));
    for (const history of histories) if (!titles.has(history.issueId)) titles.set(history.issueId, history.issueTitle);
    return {
      meetingId,
      issueIds: payload.issueIds,
      issueTitle: (issueId: string) => titles.get(issueId),
      materials,
      currentVersions: new Map((staleMaterials ?? []).flatMap((material) => (material.currentVersion ? [[material.id, material.currentVersion] as [string, number]] : []))),
      legacyMaterials: new Map(payload.materials.map((material) => [material.id, material])),
      history: buildHistoryIndex(histories),
      meetings: new Map([
        ...(evidence?.relatedMeetings ?? []).map((meeting) => [meeting.id, meeting.title] as [string, string]),
        ...histories.flatMap((history) => history.relatedMeetings.map((meeting) => [meeting.id, meeting.title] as [string, string])),
      ]),
    };
  }, [meetingId, payload.issueIds, payload.materials, evidence, staleMaterials, collection, histories]);
  const relatedMeetingIds = [...new Set(histories.flatMap((history) => history.relatedMeetings.map((meeting) => meeting.id)))].filter((id) => id !== meetingId);
  const objectsKey = [...payload.issueIds, ...relatedMeetingIds].join(",");
  const sourceObjects = useMemo<SourceObject[]>(() => [
    { objectType: "meeting", objectId: meetingId },
    ...objectsKey.split(",").filter(Boolean).map((id) => ({ objectType: payload.issueIds.includes(id) ? "issue" as const : "meeting" as const, objectId: id })),
  ], [meetingId, objectsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const showRecord = useCallback(() => setView(pickSegment("record")), []);
  const leaveReading = useCallback(() => saveReadingPosition(readingKey, mainRef.current), [readingKey]);
  const { api: sourceApi, overlay: sourceOverlay } = useSourceNavigator({
    context: sourceContext, rootRef: workspaceRef, onNavigate, onShowRecord: showRecord, objects: sourceObjects, meetingId, beforeLeave: leaveReading,
  });
  // 划词引用提问：和议题页一样，选中正文里的一段就能带进右侧对话。
  const { selected: quoteSelection, clear: clearQuote, onMouseUp: onQuoteMouseUp } = useSelectionQuote(mainRef);

  const candidateKey = payload.transcriptCandidate?.createdAt ?? null;

  // 录音转写中、会后抽取中、会前预审中：每 5 秒取一次会议卡片，状态、候选、纪要、预审跟着更新；候选一到，下面那段就自动打开说话人对应。
  const refreshing = meetingNeedsPolling(payload, memberReadOnly);
  const pollMs = preflightInFlight(payload) ? PREFLIGHT_POLL_MS : MEETING_POLL_MS;
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(async () => {
      const { data } = await browserApi.GET("/api/cards/meetings/{id}", { params: { path: { id: card.objectRef.id } } });
      const next = data?.cards?.[0];
      if (!next) return;
      onCard(next);
      // 预审出结果：左栏会议卡跟着从「会前预审中」换成结论。
      if (!preflightInFlight(payloadOf<MeetingPayload>(next))) window.dispatchEvent(new Event("meeting-changed"));
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [refreshing, pollMs, card.objectRef.id, onCard]);

  // 候选出现或重上传后自动打开预览；关闭只收起，不回滚服务端候选。
  useEffect(() => {
    if (candidateKey) setCandidateOpen(true);
  }, [candidateKey]);

  useEffect(() => {
    if (!candidateOpen) return;
    const dialog = candidateDialog.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const onClose = () => { if (!dialog.open) setCandidateOpen(false); };
    dialog.addEventListener("close", onClose);
    return () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
    };
  }, [candidateOpen, candidateKey]);

  // 映射下拉需要完整人员目录（不限 DRI）；加载失败时确认保持不可用。
  useEffect(() => {
    if (!candidateKey) return;
    let cancelled = false;
    void (async () => {
      try {
        let options: DirectoryOption[];
        if (memberReadOnly) {
          const params = { params: { path: { objectType: "meeting" as const, objectId: card.objectRef.id } } };
          const [candidates, thread] = await Promise.all([
            browserApi.GET("/api/threads/{objectType}/{objectId}/candidates", params),
            browserApi.GET("/api/threads/{objectType}/{objectId}", params),
          ]);
          if (!candidates.response.ok || !thread.response.ok) throw new Error("directory unavailable");
          options = [...source.participants, ...(candidates.data?.people ?? []), ...(thread.data?.members ?? [])]
            .map((person) => ({ personId: person.personId, displayName: person.displayName, roles: [] }));
        } else {
          const result = await browserApi.GET("/api/people");
          if (!result.response.ok) throw new Error("directory unavailable");
          options = result.data?.people ?? [];
        }
        if (cancelled) return;
        setDirectoryError(null);
        setDirectory([...new Map(options.map((person) => [person.personId, person])).values()]);
      } catch {
        if (!cancelled) setDirectoryError("人员目录加载失败，无法完成说话人映射");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateKey, memberReadOnly, card.objectRef.id, source.participants]);

  function toggle(field: "readIssueIds" | "checkedEntryIds" | "carriedIssueIds", id: string) {
    const current = payload.draft[field];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    const action = actionOf("meeting.update_draft");
    if (action) void run(action, { [field]: next });
  }

  /** 编辑弹层回填当前 Card 事实；主持人只列人员目录里的 DRI，目录不可用时保留当前值。 */
  async function openEditDetails(reschedule = false) {
    const next = detailsForm();
    if (reschedule && Date.parse(payload.scheduledAt) <= Date.now()) {
      const start = new Date(Date.now() + 86_400_000);
      next.scheduledAt = toCompanyInput(start.toISOString());
      next.endsAt = toCompanyInput(new Date(start.getTime() + Date.parse(payload.endsAt) - Date.parse(payload.scheduledAt)).toISOString());
    }
    setEditForm(next);
    setDriError(null);
    setEditOpen(true);
    setRescheduling(reschedule);
    if (reschedule) return;
    const { data, response } = await browserApi.GET("/api/people");
    if (!response.ok) {
      setDriError("人员目录加载失败，暂时只能保留当前主持人");
      return;
    }
    setDriOptions((((data as { people?: DirectoryOption[] } | undefined)?.people ?? []).filter((person) => person.roles.includes("dri"))));
  }

  const requestedMeetingAction = useRef<string | null>(null);
  useEffect(() => {
    const request = new URLSearchParams(window.location.search).get("meetingAction");
    const key = request ? `${card.objectRef.id}:${request}` : null;
    if (!key || requestedMeetingAction.current === key) return;
    requestedMeetingAction.current = key;
    if (request === "reschedule" && actionOf("meeting.reschedule")) void openEditDetails(true);
    if (request === "transcript" || (request === "reschedule" && payload.transcriptCandidate))
      setView(pickSegment("record"));
  });

  /** 只提交真正改动的字段：未改的时间不重写。时间按公司时区提交。 */
  async function saveMeetingDetails() {
    const action = actionOf(rescheduling ? "meeting.reschedule" : "meeting.edit_details");
    if (!action) return;
    const initial = detailsForm();
    const patch: { title?: string; scheduledAt?: string; endsAt?: string; leadDriId?: string } = {};
    const title = editForm.title.trim();
    if (!rescheduling && title && title !== card.title) patch.title = title;
    if (editForm.scheduledAt && (rescheduling || editForm.scheduledAt !== initial.scheduledAt)) patch.scheduledAt = fromCompanyInput(editForm.scheduledAt);
    if (editForm.endsAt && editForm.endsAt !== initial.endsAt) patch.endsAt = fromCompanyInput(editForm.endsAt);
    if (!rescheduling && editForm.leadDriId && editForm.leadDriId !== payload.leadDriId) patch.leadDriId = editForm.leadDriId;
    if (!Object.keys(patch).length) {
      setEditOpen(false);
      return;
    }
    if (await run(action, patch)) setEditOpen(false);
  }

  /** JSON 直导：multipart 单文件；与 DRI service API 共用同一校验边界。 */
  async function uploadTranscript(file: File) {
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/meetings/${card.objectRef.id}/transcript`, { method: "POST", body: form });
    setUploading(false);
    if (response.status === 401) {
      onNavigate("/access");
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: typeof collection };
    if (response.ok && body.cards?.[0]) {
      updateCard(body.cards[0]);
      return;
    }
    setUploadError(body.message ?? "逐字稿整份被拒绝");
  }

  /** 会议记录入口按扩展名分流：.md 只生成候选，.json 走既有 immediate import。 */
  async function importTranscriptFile(file: File) {
    if (!/\.md$/i.test(file.name)) return uploadTranscript(file);
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/meetings/${card.objectRef.id}/transcript-candidate`, { method: "POST", body: form });
    setUploading(false);
    if (response.status === 401) {
      onNavigate("/access");
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: typeof collection };
    if (response.ok && body.cards?.[0]) return updateCard(body.cards[0]);
    setUploadError(body.message ?? "妙记 Markdown 整份被拒绝");
  }

  /** 确认候选：只提交 speakerMappings 与显式标记，全量 turns 留在服务端。 */
  function confirmCandidate(mappings: Record<string, string>) {
    const action = actionOf("meeting.confirm_transcript_candidate");
    if (!action || !payload.transcriptCandidate) return;
    void run(action, confirmTranscriptInput(payload.transcriptCandidate, mappings));
  }

  function discardCandidate() {
    const action = actionOf("meeting.discard_transcript_candidate");
    if (action) void run(action, {});
  }

  async function replaceMaterials() {
    const files = materialRef.current?.files;
    if (!files?.length) {
      setUploadError("请先选择至少一份会前材料；空选择不会替换现有材料。");
      return;
    }
    if (payload.materials.length && !(await ask("替换会清空当前材料集、补充材料与预审候选。是否继续？"))) return;
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const response = await fetch(`/api/meetings/${card.objectRef.id}/materials`, { method: "POST", body: form });
    setUploading(false);
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: typeof collection };
    if (response.ok && body.cards?.[0]) return onCard(body.cards[0]);
    setUploadError(body.message ?? "材料集被拒绝");
  }

  /** 补充材料：documented contract = POST …/materials/supplement（multipart files + requestId）；不触碰 preflight。 */
  async function uploadSupplementMaterial(requestId: string, file: File) {
    setSupplementBusyId(requestId);
    setSupplementError(null);
    const response = await fetch(`/api/meetings/${card.objectRef.id}/materials/supplement`, {
      method: "POST",
      body: buildSupplementForm(requestId, file),
    });
    setSupplementBusyId(null);
    if (response.status === 401) {
      onNavigate("/access");
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: typeof collection };
    if (response.ok && body.cards?.[0]) return onCard(body.cards[0]);
    setSupplementError(body.message ?? "补充材料被拒绝");
  }

  /** 危险替换：必须先确认，再以 confirmReplace:true 提交整份 Transcript。 */
  async function replaceTranscript() {
    const file = replaceRef.current?.files?.[0];
    const action = actionOf("meeting.replace_transcript");
    if (!file || !action) {
      setUploadError("请选择要替换成的逐字稿文件。");
      return;
    }
    let transcript: unknown;
    try {
      transcript = JSON.parse(await file.text());
    } catch {
      setUploadError("逐字稿文件格式不对，无法读取");
      return;
    }
    setUploadError(null);
    void run(action, { transcript, confirmReplace: true });
  }

  const preflightEntries: PreflightEntry[] = payload.preflight.entries.map((entry) => ({ ...entry, body: payload.draft.editsByEntryId[entry.id] ?? entry.body }));
  // 按议题收拢（feedback 15）：只有一个关联议题时预审条目全部归它；多个议题时按依据指向归属，指不出的留在会议层面。
  const attributed = attributeEntries(preflightEntries, payload.issueIds, sourceContext);
  const meetingEntries = attributed.meeting;
  const coreEntry = meetingEntries.find((entry) => entry.kind === "core_judgment");
  /** 会议层面的一号位追问在琥珀参考盒里，按陈述列表编号，不在别处重复。 */
  const lensEntries = meetingEntries.filter((entry) => entry.kind === "leader_lens");
  const preflightGroups = groupPreflight(meetingEntries, Boolean(payload.preflight.taskDefinition))
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.kind !== "leader_lens" && entry !== coreEntry) }))
    .filter((group) => group.entries.length > 0);
  const checkedCount = payload.draft.checkedEntryIds.filter((id) => payload.preflight.entries.some((entry) => entry.id === id)).length;
  const noCeoQuestion = payload.preflight.status === "ready" && Boolean(payload.preflight.taskDefinition) && !preflightEntries.some((entry) => entry.kind === "meeting_question");
  const singleIssue = payload.issueIds.length === 1;

  /* 会后条目：按议题分组（feedback 15），没有议题的进「其他」；「其他」里仍按共识、Action Item、战略议题分。 */
  const outcomeItems = payload.outcome?.items ?? [];
  const outcomeGroups = groupOutcomeByIssue(outcomeItems, payload.issueIds);
  const minutesOf = (items: typeof outcomeItems) => ({
    decisions: items.filter((item) => item.kind === "decision"),
    actions: [...items.filter((item) => item.kind === "todo").reduce((groups, item) => {
      const ownerId = actionOwner(item, payload);
      groups.set(ownerId, [...(groups.get(ownerId) ?? []), item]);
      return groups;
    }, new Map<string, typeof outcomeItems>())].map(([ownerId, list]) => ({ ownerId, items: list })),
    strategic: items.filter((item) => item.kind === "strategic"),
    others: items.filter((item) => !["decision", "todo", "strategic"].includes(item.kind)),
  });
  const minutes = minutesOf(memberReadOnly ? outcomeItems : outcomeGroups.others);
  /**
   * 会后确认 / 忽略 / 撤回走原生 meeting Action，返回的是会议 Card；决定被确认后议题的回执和状态也变了，
   * 所以成功后按议题再读一次议题 Card（只读），历史分层跟着重读；演示里再通知首页刷新。
   */
  const runItem = async (action: CardAction, item: (typeof outcomeItems)[number]) => {
    if (!(await run(action, {}))) return;
    // 会议页确认的决定同样写到战场（没有倒计时：会议页上一直留着撤回；撤回时服务端把战场恢复）。docs/superpowers/specs/2026-10-12-confirm-to-battlefield.md §6
    if (action.actionType === "meeting.confirm_item" && item.kind === "decision") {
      const apply = latestCard.current.actions.find((candidate) => candidate.actionType === "meeting.apply_battlefield");
      if (apply) await run(apply, {});
    }
    const issueId = outcomeIssueId(item, payload.issueIds);
    if (issueId) {
      const { data } = await browserApi.GET("/api/cards/issues/{id}", { params: { path: { id: issueId } } });
      const next = data?.cards?.[0];
      if (next) onCard(next);
    }
    window.dispatchEvent(new CustomEvent(DECISION_HISTORY_CHANGED, { detail: { issueId } }));
  };
  /** 确认 / 推送 / 忽略：先显示结果并给 5 秒「撤回」，到点才提交（和左栏一致，巡检 P1-9）。 */
  const holdItem = (kind: "confirm" | "dismiss", item: (typeof outcomeItems)[number]) => itemUndo.hold(item.id, kind, () => {
    const type = kind === "confirm" ? "meeting.confirm_item" : "meeting.dismiss_item";
    commitChain.current = commitChain.current.then(async () => {
      const action = latestCard.current.actions.find((candidate) => candidate.actionType === type && candidate.itemId === item.id);
      if (action) await runItem(action, item);
    }).catch(() => undefined);
  });
  const renderItem = (item: (typeof outcomeItems)[number]) => {
    // 子决定画在主决定下面（缩进、没有自己的按钮），不单独成条
    if (isChildDecision(outcomeItems, item)) return null;
    const children = item.kind === "decision" ? decisionGroups([item], outcomeItems)[0].children : [];
    const itemState = outcomeItemState(item, payload, (id) => people.get(id) ?? id);
    const itemText = cleanDisplayText(item.kind === "strategic" && item.title ? item.title : item.text);
    const quote = cleanDisplayText(item.quote);
    const overdue = item.kind === "todo" && item.review?.status === "pending" && isPastDue(item.dueDate, item.text, calendarDate(new Date().toISOString()));
    const held = item.review?.status === "pending" ? itemUndo.pending(item.id) : null;
    return (
      <article key={item.id} id={outcomeAnchorId(item.id)} className={s.decisionRecord} data-kind={item.kind}>
        <div className={s.itemHead}>
          <span className={s.kindBadge}>{ITEM_LABEL[item.kind] ?? item.kind}</span>
          <p className={s.itemText}>{itemText}</p>
        </div>
        {item.kind === "strategic" && item.brief ? <p className={s.entryBody}>{cleanDisplayText(item.brief)}</p> : null}
        {/* 原话里的 Markdown 表格行改写成一句；和条目本身说的是同一句时不再重复一遍。 */}
        {quote && !sameSentence(quote, itemText) ? (
          <blockquote className={s.itemQuote}>
            <p>{quote}</p>
          </blockquote>
        ) : null}
        <div className={s.itemMeta}>
          <div className={s.itemMetaLeft}>
            {speakerLabel(item.speakerId, people) ? <span>{speakerLabel(item.speakerId, people)}</span> : null}
            {item.kind === "todo" && payload.issueIds.length ? <span>负责人 {people.get(actionOwner(item, payload)) ?? "待确认"}</span> : null}
            {item.dueDate ? <span>{item.dueDate.slice(5).replace("-", "/")} 前</span> : null}
            {overdue ? <span className={s.overdue}>已过期</span> : null}
            <span className={s.itemState} data-state={held ? (held === "confirm" ? "confirmed" : "dismissed") : itemState.state}>
              {held ? heldItemLabel(item, held, (id) => people.get(id) ?? id, payload) : itemState.label}
            </span>
          </div>
          {/* 待办会后已自动推给负责人：这里只看，不再逐条推送、忽略或撤回 */}
          {item.kind === "todo" ? null : <div className={s.itemActions}>
            {held ? (
              <button type="button" aria-label={`撤回：${itemText}`} onClick={() => itemUndo.undo(item.id)}>撤回</button>
            ) : <>
            {itemAction("meeting.confirm_item", item.id) ? (
              <button type="button" data-variant="confirm" disabled={pending} onClick={() => holdItem("confirm", item)}>
                确认
              </button>
            ) : null}
            {itemAction("meeting.dismiss_item", item.id) ? (
              <button type="button" disabled={pending} onClick={() => holdItem("dismiss", item)}>
                {item.kind === "strategic" ? "不同意" : "忽略"}
              </button>
            ) : null}
            </>}
            {itemAction("meeting.revoke_effect", item.id) ? (
              <button type="button" disabled={pending} onClick={() => void runItem(itemAction("meeting.revoke_effect", item.id)!, item)}>
                撤回
              </button>
            ) : null}
          </div>}
        </div>
        {children.length ? (
          <ul className={s.subDecisions} aria-label={`含 ${children.length} 项`}>
            {children.map((child) => {
              const childState = childDecisionLabel(child, held);
              return (
                <li key={child.id} id={outcomeAnchorId(child.id)} className={s.subDecision}>
                  <p>{cleanDisplayText(child.text)}</p>
                  {childState ? <span className={s.itemState} data-state={childState.state}>{childState.label}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </article>
    );
  };

  /* 正式版会前准备：每条预审条目可核对、可请求补充材料；每个议题可标已阅、带到会议。演示里不出现这些会务操作。 */
  const entryActions = (entry: PreflightEntry) => {
    const checked = payload.draft.checkedEntryIds.includes(entry.id);
    return (
      <div className={s.briefActions}>
        <button type="button" aria-pressed={checked} disabled={pending} onClick={() => toggle("checkedEntryIds", entry.id)}>
          {checked ? "已核对" : "标记已核对"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSupplementEntry(entry.id);
            setSupplementText(`请补充「${entry.title}」的证据`);
          }}
        >
          请求补充材料
        </button>
      </div>
    );
  };
  const issuePrep = (issueId: string) => {
    const read = payload.draft.readIssueIds.includes(issueId);
    const carried = payload.draft.carriedIssueIds.includes(issueId);
    return (
      <div className={s.briefActions}>
        <button type="button" aria-pressed={read} disabled={pending} onClick={() => toggle("readIssueIds", issueId)}>
          <Check size={12} aria-hidden="true" />
          已阅
        </button>
        <button type="button" aria-pressed={carried} disabled={pending} onClick={() => toggle("carriedIssueIds", issueId)}>
          带到会议
        </button>
      </div>
    );
  };
  const issueStatusOf = (issueId: string) => {
    const issueCard = issueById.get(issueId);
    return (issueCard ? payloadOf<IssuePayload>(issueCard).status : histories.find((history) => history.issueId === issueId)?.issueStatus) ?? "pending";
  };
  const hasAdvice = (issueId: string) => (attributed.byIssue.get(issueId) ?? []).some((entry) => entry.kind === "next_step" || entry.kind === "leader_lens")
    || (singleIssue && Boolean(payload.preflight.summary?.priorityAction));

  /* 目录：会议概况 → 每个议题（当前议题展开小节）→ 会议层面的判断 → 会前准备；会后：纪要 → 每个议题 → 其他 → 原文。 */
  const preflightShown = view.current === PREFLIGHT_TAB.id;
  const recordShown = view.current === RECORD_TAB.id;
  const issueOutline = (focus: "decision" | "outcome"): OutlineItem[] => payload.issueIds.map((issueId, index) => {
    const status = issueStatusOf(issueId);
    const waiting = (outcomeGroups.byIssue.get(issueId) ?? []).filter((item) => item.review?.status === "pending" && item.kind !== "todo" && !isChildDecision(outcomeItems, item)).length;
    const base = `issue:${issueId}`;
    return {
      key: base,
      label: issueById.get(issueId)?.title ?? sourceContext.issueTitle(issueId) ?? `议题 ${index + 1}`,
      short: `议题 ${index + 1}${payload.issueIds.length > 1 ? ` / ${payload.issueIds.length}` : ""}`,
      hint: focus === "outcome" && waiting ? `${waiting} 条待确认` : ISSUE_STATUS_LABEL[status],
      tone: focus === "outcome" && waiting ? "pending" : status === "decided" ? "decided" : status === "dismissed" ? "dismissed" : "pending",
      children: focus === "outcome"
        ? [{ key: `${base}:outcome`, label: "会上结论" }, { key: `${base}:result`, label: "实际结果" }, { key: `${base}:history`, label: "历史与变化" }]
        : [{ key: `${base}:judgment`, label: "核心判断" }, { key: `${base}:history`, label: "历史与变化" }, { key: `${base}:evidence`, label: "事实与依据" },
          { key: `${base}:options`, label: "选项与后果" }, ...(hasAdvice(issueId) ? [{ key: `${base}:advice`, label: "建议" }] : []),
          { key: `${base}:decision`, label: "一号位决定" }, { key: `${base}:result`, label: "实际结果" }],
    };
  });
  const showMeetingSection = preflightGroups.length > 0 || lensEntries.length > 0 || (noCeoQuestion && !payload.issueIds.length);
  const showReviewExtras = Boolean(payload.preflight.materialQuestions?.items.length || payload.preflight.divergences?.length);
  const decisionOutline: OutlineItem[] | null = !memberReadOnly && (preflightEntries.length || payload.issueIds.length) ? [
    { key: "overview", label: "会议概况", short: "会议概况" },
    ...issueOutline("decision"),
    ...(showReviewExtras ? [{ key: "review", label: "待决题与分歧", short: "待决题与分歧" }] : []),
    ...(showMeetingSection ? [{ key: "meeting", label: payload.issueIds.length ? "会议层面的判断" : "预审判断", short: "预审判断" }] : []),
    ...(!readOnly ? [{ key: "prep", label: "会前准备", short: "会前准备" }] : []),
  ] : null;
  const recordOutline: OutlineItem[] | null = !memberReadOnly && payload.issueIds.length && payload.outcome && (payload.status === "held" || payload.status === "reviewed") ? [
    { key: "summary", label: "会议纪要", short: "会议纪要" },
    ...issueOutline("outcome"),
    ...(outcomeGroups.others.length ? [{ key: "others", label: "其他事项", short: "其他事项", hint: `${outcomeGroups.others.length} 条` }] : []),
    { key: "transcript", label: "会议记录原文", short: "会议记录原文" },
  ] : null;
  const outline = preflightShown ? decisionOutline : recordShown ? recordOutline : null;
  const { active: outlineActive, jump: jumpOutline } = useOutlineSpy(mainRef, Boolean(outline), `${view.current}|${outline?.map((item) => item.key).join(",") ?? ""}`);
  // 换一份视图（预审 ↔ 会议记录）时重新记「正在读的那一段」，不拿上一份视图的元素去校位置。
  useReadingAnchor(mainRef, Boolean(outline), view.current);
  // 会后视图里「看依据与选项」：切回议题工作区，等这一页换好再定位到那个议题。
  const pendingJump = useRef<string | null>(null);
  const showDecision = useCallback((issueId: string) => {
    pendingJump.current = `issue:${issueId}`;
    setView(pickSegment("preflight"));
  }, []);
  useEffect(() => {
    const key = pendingJump.current;
    if (!key || view.current !== PREFLIGHT_TAB.id) return;
    pendingJump.current = null;
    jumpOutline(key);
  }, [view.current, jumpOutline]); // eslint-disable-line react-hooks/exhaustive-deps

  const issueBlocks = (focus: "decision" | "outcome") => payload.issueIds.map((issueId, index) => {
    const issueCard = issueById.get(issueId) ?? null;
    return (
      <IssueDecisionBlock
        key={issueId}
        issueId={issueId}
        index={index + 1}
        total={payload.issueIds.length}
        card={issueCard}
        history={issueHistory(issueId)}
        entries={focus === "decision" ? attributed.byIssue.get(issueId) ?? [] : []}
        summary={singleIssue ? payload.preflight.summary ?? null : null}
        outcomeItems={outcomeGroups.byIssue.get(issueId) ?? []}
        renderOutcomeItem={renderItem}
        focus={focus}
        decisionActions={[]}
        scopeLabel={issueCard ? issueScopeLabel((issueCard.payload as IssuePayload).location, homeCards) : ""}
        currentMeetingId={meetingId}
        outlineKey={`issue:${issueId}`}
        onCard={onCard}
        onOpenIssue={(origin) => onNavigate(`/issues/${issueId}`, origin)}
        onShowDecision={() => showDecision(issueId)}
        prep={readOnly || focus === "outcome" ? undefined : issuePrep(issueId)}
        entryExtra={readOnly ? undefined : entryActions}
        checkedEntryIds={payload.draft.checkedEntryIds}
      />
    );
  });

  /* 下拉永远包含当前主持人：目录加载失败也不会把值改成空。 */
  const editDriOptions: DirectoryOption[] = driOptions.length
    ? driOptions
    : [{ personId: payload.leadDriId, displayName: people.get(payload.leadDriId) ?? payload.leadDriId, roles: [] }];

  /* 积极信号与潜在风险两卡并排；其余章节整宽。 */
  const isPairKey = (key: string) => key === "positive_signal" || key === "risk_calibration";
  const firstPairIndex = preflightGroups.findIndex((group) => isPairKey(group.key));
  const beforePair = firstPairIndex === -1 ? preflightGroups : preflightGroups.slice(0, firstPairIndex);
  const pairGroups = preflightGroups.filter((group) => isPairKey(group.key));
  const afterPair = firstPairIndex === -1 ? [] : preflightGroups.slice(firstPairIndex).filter((group) => !isPairKey(group.key));
  const renderGroup = (group: (typeof preflightGroups)[number]) => (
    <section key={group.key} className={s.reviewSection} data-group={group.key}>
      <header>
        <h3>{group.label}</h3>
        {group.entries.length > 1 ? <span className={s.count}>{group.entries.length} 条</span> : null}
      </header>
      {group.entries.map((entry, index) => {
        const checked = payload.draft.checkedEntryIds.includes(entry.id);
        return (
          <article key={entry.id} className={s.quoteItem} data-checked={checked} data-question={group.key === "meeting_question" || undefined}>
            <div className={s.entryTitle}>
              {group.key === "meeting_question" ? <span>{String(index + 1).padStart(2, "0")}</span> : null}
              <strong>{entry.title}</strong>
            </div>
            <p className={s.entryBody}>{entry.body}</p>
            {entry.ceoDecision ? (
              /* CEO 级问题：为什么现在、为什么需要你、可选路径与影响（feedback 18）。 */
              <div className={s.heroSummary}>
                <span><small>决策时机</small>{entry.ceoDecision.whyNow}</span>
                <span><small>需一号位决定的原因</small>{entry.ceoDecision.whyCeo}</span>
                {entry.ceoDecision.options.map((option) => (
                  <span key={option.label}><small>可选：{option.label}</small>{option.impact}</span>
                ))}
                {entry.ceoDecision.delayCost ? <span><small>延迟代价</small>{entry.ceoDecision.delayCost}</span> : null}
              </div>
            ) : null}
            <SourceList refs={entry.sourceRefs} />
            {readOnly ? null : entryActions(entry)}
          </article>
        );
      })}
    </section>
  );

  /* 页头：计划时段、会后「会前预审 ｜ 会议记录」两段、开始会议／计时（这一版不放；已取消的会也没有计时）。 */
  const ended = Boolean(payload.hasEnded || payload.endedAt) || payload.status === "held" || payload.status === "reviewed";
  const phase = meetingPhase(startedAt, ended);
  const { timeline, label: timelineLabel } = useMeetingTimeline({ phase, scheduledAt: payload.scheduledAt, cancelled: payload.status === "cancelled" });
  const endAction = actionOf("meeting.end");
  const clock =
    !MEETING_CLOCK_ENABLED || (memberReadOnly && !isHost) || payload.status === "cancelled" ? undefined : (
      <MeetingClock
        phase={phase}
        startedAt={startedAt}
        endedAt={payload.endedAt}
        ending={pending || !endAction || recorder.state.status === "stopping"}
        caption={recorder.state.status === "recording" ? "录音中" : "会议中"}
        note={recordingNote(recorder.state)}
        onStart={() => {
          setStartedAt(Date.now());
          void recorder.start();
        }}
        onEnd={async () => {
          if (!endAction) return;
          await recorder.stop();
          if (!(await run(endAction, {}))) return;
          setStartedAt(undefined);
          setView(pickSegment("record"));
        }}
      />
    );
  const participantNames = payload.participants.map((person) => person.displayName);
  const facts = [
    `${people.get(payload.leadDriId) ?? "主持人待确认"}主持`,
    participantNames.length <= 4 ? `参会：${participantNames.join("、")}` : `${participantNames.length} 人参会`,
  ];
  // 会后「会前预审」是页头的一段，下拉单只列材料；会前下拉单第一项是 AI 预审。
  const tabs = meetingHeld ? payload.materials.map(materialTab) : [PREFLIGHT_TAB, ...payload.materials.map(materialTab)];
  const provenance = (material: MaterialMeta) => {
    const request = payload.draft.supplementRequests.find((item) => item.id === material.supplementFor);
    return request ? ` · 回应「${truncateText(request.text, 24)}」` : "";
  };

  /** 重新预审：工具栏和「资料已更新」提示共用同一个原生 Action 与确认。 */
  const regenerateAction = actionOf("meeting.regenerate_preflight");
  const regenerate = async () => {
    if (regenerateAction && (await ask("用最新资料重新预审？现有预审内容和已做的核对标记会被替换。"))) void run(regenerateAction, {});
  };

  /** 这场会开完了：记为已开完，转到会议记录（导入妙记或逐字稿）。 */
  const endMeeting = async () => {
    if (!endAction || !(await run(endAction, {}))) return;
    setView(pickSegment("record"));
  };

  /** 编辑会议 / 重新安排会议共用的表单（标题、起止、主持人）。 */
  const editFields = (
    <>
      <p className={s.editTitle}>{rescheduling ? "重新安排会议" : "编辑会议"}</p>
      {!rescheduling ? <label className={s.editField}>
        <span>会议标题</span>
        <input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
      </label> : null}
      <label className={s.editField}>
        <span>开始</span>
        <DateTimePicker label="开始" value={editForm.scheduledAt} onChange={(start) => {
          setEditForm((current) => ({ ...current, scheduledAt: start,
            endsAt: rescheduling && start && current.scheduledAt && current.endsAt
              ? toCompanyInput(new Date(Date.parse(fromCompanyInput(start)) + Date.parse(fromCompanyInput(current.endsAt)) - Date.parse(fromCompanyInput(current.scheduledAt))).toISOString()) : current.endsAt }));
        }} />
      </label>
      <label className={s.editField}>
        <span>结束</span>
        <DateTimePicker label="结束" value={editForm.endsAt} onChange={(endsAt) => setEditForm((current) => ({ ...current, endsAt }))} />
      </label>
      {!rescheduling ? <label className={s.editField}>
        <span>主持人</span>
        <Select aria-label="主持人" value={editForm.leadDriId} onChange={(leadDriId) => setEditForm((current) => ({ ...current, leadDriId }))}
          options={editDriOptions.map((person) => ({ value: person.personId, label: person.displayName }))} />
      </label> : null}
      {editForm.scheduledAt && editForm.endsAt && editForm.endsAt <= editForm.scheduledAt ? <p className={s.editHint}>结束时间要晚于开始时间</p> : null}
      {driError ? <p className={s.editHint}>{driError}</p> : null}
      <div className={s.editActions}>
        <button type="button" className={s.editCancel} onClick={() => setEditOpen(false)}>
          取消
        </button>
        <button
          type="button"
          className={s.editSave}
          disabled={pending || !editForm.title.trim() || (Boolean(editForm.endsAt) && editForm.endsAt <= editForm.scheduledAt)}
          onClick={() => void saveMeetingDetails()}
        >
          保存
        </button>
      </div>
    </>
  );

  /** 标题右侧的铅笔：低调地放「编辑会议」，浮层跟着它出来。 */
  const titleEdit = payload.status === "scheduled" && actionOf("meeting.edit_details") ? (
    <Popover isOpen={editOpen && !rescheduling} onOpenChange={(open) => { if (!open) setEditOpen(false); }}>
      <Button className={s.titleEdit} aria-label="编辑会议" isDisabled={pending} onPress={() => void openEditDetails()}>
        <Pencil size={14} aria-hidden="true" />
      </Button>
      <Popover.Content placement="bottom start" className={s.editFloat}>
        <TianshuPortalTheme>
          <Popover.Dialog className={s.editDialog} aria-label="编辑会议">
            {editFields}
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  ) : null;

  const preflightToolbar = readOnly && !isHost ? null : (
    <div className={s.toolbar}>
      {actionOf("meeting.reschedule") ? <button type="button" disabled={pending} onClick={() => void openEditDetails(true)}>重新安排会议</button> : null}
      {endAction && isHost && !ended ? <button type="button" disabled={pending} onClick={() => void endMeeting()}>结束会议</button> : null}
      {actionOf("meeting.edit_materials") ? (
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            if (await ask("返回编辑会使当前预审候选失效。是否继续？")) void run(actionOf("meeting.edit_materials")!, {});
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          返回编辑材料
        </button>
      ) : null}
      {regenerateAction ? (
        <button type="button" disabled={pending} onClick={() => void regenerate()}>
          <RefreshCw size={13} aria-hidden="true" />
          {pending ? "预审中…" : "重新预审"}
        </button>
      ) : null}
      {/* 「重新安排会议」仍挂在这一行下面；「编辑会议」在标题右侧的铅笔浮层里。 */}
      {editOpen && rescheduling ? (
        <div className={s.editPopover} role="dialog" aria-label="重新安排会议">
          {editFields}
        </div>
      ) : null}
    </div>
  );

  /* 会议概况（只放不专属某个议题的事）：预审结论、资料是否过期、整场判断、四输入边界、预审读了哪些资料和缺口。 */
  const usedMaterials = evidence?.materials ?? [];
  const materialGaps = usedMaterials.filter((material) => material.state !== "used" || material.truncated);
  const duplicateLegacy = evidence?.legacyMaterials.filter((material) => material.state === "duplicate") ?? [];
  const showStale = payload.preflight.status === "ready" && Boolean(payload.preflight.staleInputs || payload.preflight.inputsChangedDuringRun);
  const decidedCount = payload.issueIds.filter((issueId) => issueStatusOf(issueId) === "decided").length;
  const overview = (
    <section className={s.overview} data-outline="overview" aria-label="会议概况">
      {payload.preflight.status === "running" && payload.preflight.entries.length ? (
        <p className={s.runningNotice} role="status">
          <Loader2 size={15} aria-hidden="true" />
          正在按最新资料重新预审
        </p>
      ) : null}
      {payload.preflight.status === "running" ? <PreflightProgress progress={payload.preflight.progress} status="running" /> : null}
      <div className={s.overviewTop}>
        {payload.issueIds.length ? <p className={s.overviewIssues}>共 {payload.issueIds.length} 个议题{decidedCount ? ` · ${decidedCount} 个已决定` : ""}</p> : null}
        {!readOnly && payload.preflight.entries.length ? <span className={s.count}>已核对 {checkedCount} / {payload.preflight.entries.length}</span> : null}
      </div>
      {!coreEntry && payload.issueIds.length && payload.preflight.status !== "running" && payload.preflight.brief ? (
        /* 预审条目都归到了议题下（单议题会全部归它）时，没有会议层面的整场判断块；预审那句「这次会只需要定哪一件事」不能因此丢掉。 */
        <p className={s.briefLine}><small>整场判断</small>{cleanDisplayText(payload.preflight.brief)}</p>
      ) : null}
      {showStale ? (
        /* 资料在报告之后（或生成期间）变了：不把旧报告当成基于最新资料（feedback 12），可直接用最新资料重新预审。 */
        <div className={s.staleNotice} role="status">
          <p>{preflightStaleText(payload.preflight)}</p>
          {regenerateAction ? (
            <button type="button" disabled={pending} onClick={() => void regenerate()}>
              <RefreshCw size={13} aria-hidden="true" />
              {pending ? "预审中…" : "用最新资料重新预审"}
            </button>
          ) : null}
        </div>
      ) : null}
      {payload.preflight.error ? (
        <p className={s.error} role="alert" title={payload.preflight.error.code}>
          {preflightErrorText(payload.preflight.error)}
          {actionOf("meeting.retry_preflight") ? (
            <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_preflight")!, {})}>
              重试预审
            </button>
          ) : null}
        </p>
      ) : null}
      {coreEntry || !payload.issueIds.length ? (
        <div className={s.judgmentHero} data-checked={coreEntry ? payload.draft.checkedEntryIds.includes(coreEntry.id) || undefined : undefined}>
          <small>{payload.issueIds.length ? "整场判断" : "核心判断"}</small>
          <h2>{coreEntry?.title ?? "会前预审"}</h2>
          <p>{(coreEntry?.body ?? payload.preflight.brief) || (ended ? "该会议会前未进行预审。" : "尚无会前预审。")}</p>
          {payload.preflight.summary && !singleIssue ? (
            <div className={s.heroSummary}>
              <span><small>最优先动作</small>{payload.preflight.summary.priorityAction}</span>
              <span><small>最关键问题</small>{payload.preflight.summary.criticalIssue}</span>
            </div>
          ) : null}
          {coreEntry ? <SourceList refs={coreEntry.sourceRefs} /> : null}
          {coreEntry && !readOnly ? entryActions(coreEntry) : null}
        </div>
      ) : !payload.preflight.entries.length ? (
        payload.preflight.status === "running" && payload.preflight.progress?.steps.length ? null
          : <p className={s.empty}>{payload.preflight.status === "running" ? "会前预审进行中" : "尚无会前预审。"}</p>
      ) : null}
      {noCeoQuestion && payload.issueIds.length && !payload.issueIds.some((issueId) => issueStatusOf(issueId) === "pending") ? (
        /* 问题不设下限（feedback 18）：预审认为没有需要当场拍板的事、且议题都已处理时才如实写出；还有待决定议题时不写，免得与「待决定」自相矛盾。 */
        <p className={s.noQuestion}>本次会议无需当场决策的问题。</p>
      ) : null}
      {payload.preflight.inputCoverage ? (
        <div className={s.coverage}>
          <small>预审依据</small>
          <span>背景 <b>{INPUT_LABEL[payload.preflight.inputCoverage.background]}</b></span>
          <span>目的 <b>{INPUT_LABEL[payload.preflight.inputCoverage.purpose]}</b></span>
          <span>源材料 <b>{INPUT_LABEL[payload.preflight.inputCoverage.sourceMaterial]}</b></span>
          <span>关联会议 <b>{INPUT_LABEL[payload.preflight.inputCoverage.relatedMeeting]}</b></span>
          {payload.preflight.inputCoverage.groupMaterials ? <span>群材料 <b>{INPUT_LABEL[payload.preflight.inputCoverage.groupMaterials]}</b></span> : null}
          {payload.preflight.inputCoverage.discussions ? <span>群讨论 <b>{INPUT_LABEL[payload.preflight.inputCoverage.discussions]}</b></span> : null}
          {payload.preflight.inputCoverage.decisionHistory ? <span>历史决定 <b>{INPUT_LABEL[payload.preflight.inputCoverage.decisionHistory]}</b></span> : null}
        </div>
      ) : null}
      {usedMaterials.length || duplicateLegacy.length || evidence?.skippedObjects ? (
        <div className={s.inputMaterials}>
          <SourceList label="预审读取的资料" refs={usedMaterials.filter((material) => material.state !== "unreadable").map((material) => material.sourceRef)} />
          {materialGaps.map((material) => (
            <p key={material.id} className={s.gapLine}>
              《{materialTitle(material.fileName)}》第 {material.version} 版：{material.state === "link_only" ? "外部链接，仅读取标题与地址"
                : material.state === "unreadable" ? "该版本无可读文字，未纳入预审" : "内容较长，仅读取前段"}
            </p>
          ))}
          {duplicateLegacy.length ? <p className={s.gapLine}>{duplicateLegacy.length} 份会前材料与群材料重复，只用了群材料的最新版。</p> : null}
          {evidence?.skippedObjects ? <p className={s.gapLine}>另有 {evidence.skippedObjects} 处资料你没有查看权限，没有读取。</p> : null}
        </div>
      ) : null}
      {payload.preflight.taskDefinition ? (
        <details className={s.taskContext}>
          <summary>材料与评审范围</summary>
          <div><small>材料目的</small><p>{stripInternalRefs(payload.preflight.taskDefinition.materialPurpose)}</p></div>
          <div><small>本次评审目的</small><p>{stripInternalRefs(payload.preflight.taskDefinition.reviewPurpose)}</p></div>
          <div><small>读者下一动作</small><p>{stripInternalRefs(payload.preflight.taskDefinition.readerAction)}</p></div>
          <div><small>本材料非目标</small><p>{stripInternalRefs(payload.preflight.taskDefinition.nonGoal)}</p></div>
          <div><small>证据边界</small><p>{stripInternalRefs(payload.preflight.basis)}</p></div>
        </details>
      ) : null}
      {payload.preflight.status !== "running" ? <PreflightProgress progress={payload.preflight.progress} status={payload.preflight.status} /> : null}
    </section>
  );

  /* 材料自带的待决题逐条判断与开放分歧（v4）：不专属某个议题，放在议题之后、会议层面的判断之前。 */
  const reviewExtras = showReviewExtras ? (
    <section className={s.meetingLevel} data-outline="review" aria-label="待决题与分歧">
      <MaterialQuestionsSection value={payload.preflight.materialQuestions} />
      <DivergencesSection value={payload.preflight.divergences} />
    </section>
  ) : null;

  /* 不专属某个议题的预审判断（多议题会议、或没有关联议题的同步会）。 */
  const meetingSection = showMeetingSection ? (
    <section className={s.meetingLevel} data-outline="meeting" aria-label={payload.issueIds.length ? "会议层面的判断" : "预审判断"}>
      {payload.issueIds.length && (preflightGroups.length || lensEntries.length) ? <h3 className={s.blockLabel}>会议层面的判断<span>不专属某一个议题</span></h3> : null}
      {lensEntries.length ? (
        <div className={s.leaderLens}>
          <small>一号位追问</small>
          <ol>
            {lensEntries.map((entry) => (
              <li key={entry.id}>{entry.body}<LensAnswers options={entry.ceoDecision?.options} /></li>
            ))}
          </ol>
        </div>
      ) : null}
      {beforePair.map(renderGroup)}
      {pairGroups.length ? <div className={s.pairRow}>{pairGroups.map(renderGroup)}</div> : null}
      {afterPair.map(renderGroup)}
      {noCeoQuestion && !payload.issueIds.length ? (
        /* 问题不设下限：普通同步会可以没有需要 CEO 拍板的事（feedback 18）。 */
        <section className={s.reviewSection}>
          <header><h3>需当场决策的问题</h3></header>
          <p className={s.empty}>本次会议无需当场决策的问题。</p>
        </section>
      ) : null}
    </section>
  ) : null;

  // 会开完了、开会前没有做预审：「会前预审」那一段照样在，内容区只写一句。
  const noPreflight = noPreflightContent(meetingHeld, payload.preflight);
  const preflightView = (
    <div className={s.decisionWorkspace}>
        {uploadError ? <p className={s.error} role="alert">{uploadError}</p> : null}
        {!readOnly && payload.preflight.status === "pending" && !actionOf("meeting.edit_materials") ? (
          /* 未预审：材料编辑卡。预审完成后替换材料要先「返回编辑材料」。 */
          <section className={s.reviewSection}>
            <header>
              <h3>会前材料</h3>
              <span>{payload.materials.length} 份</span>
            </header>
            {payload.materials.map((material) => (
              <p key={material.id} className={s.entryBody}>
                <a href={`/api/meetings/${card.objectRef.id}/materials/${material.id}/download`}>{materialTitle(material.fileName)}</a> · {Math.ceil(material.sizeBytes / 1024)} KB
              </p>
            ))}
            <input ref={materialRef} type="file" multiple accept={MATERIAL_ACCEPT} aria-label="选择会前材料" />
            <div className={s.stageActions}>
              <button type="button" disabled={uploading} onClick={() => void replaceMaterials()}>{uploading ? "解析中…" : "替换材料集"}</button>
              {actionOf("meeting.run_preflight") ? <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.run_preflight")!, {})}>运行预审</button> : null}
            </div>
          </section>
        ) : null}
        {noPreflight ? <p className={s.empty}>该会议没有会前预审。</p> : overview}
        {payload.issueIds.length ? <div className={s.issueList} aria-label="关联议题">{issueBlocks("decision")}</div> : null}
        {reviewExtras}
        {meetingSection}

        {readOnly ? null : (
          <div className={s.prepSection} data-outline="prep" aria-label="会前准备">
            <div className={s.reviewSection}>
              <header>
                <h3>请求补充材料</h3>
                <span>{payload.draft.supplementRequests.length} 条已记录</span>
              </header>
              <label className={s.summaryEdit}>
                <span>请谁补充</span>
                <Select aria-label="请谁补充" value={supplementTarget} onChange={setSupplementTarget}
                  options={dri.map((person) => ({ value: person.personId, label: person.displayName }))} />
              </label>
              <label className={s.summaryEdit}>
                <span>补充内容</span>
                <textarea value={supplementText} onChange={(event) => setSupplementText(event.target.value)} rows={2} />
              </label>
              {actionOf("meeting.request_supplement") ? (
                <div className={s.stageActions}>
                  <button
                    type="button"
                    disabled={pending || !supplementText.trim()}
                    onClick={() =>
                      void run(actionOf("meeting.request_supplement")!, {
                        targetDriId: supplementTarget,
                        text: supplementText.trim(),
                        ...(supplementEntry ? { entryId: supplementEntry } : {}),
                      })
                    }
                  >
                    记录请求
                  </button>
                </div>
              ) : null}
              {payload.draft.supplementRequests.length ? (
                <ul className={s.requestList}>
                  {payload.draft.supplementRequests.map((request) => (
                    <li key={request.id} className={s.requestRow}>
                      <span className={s.requestText}>{EXPORT_LABEL[request.exportStatus] ?? request.exportStatus} · {request.text}</span>
                      <label className={s.requestUpload}>
                        <input
                          type="file"
                          accept={MATERIAL_ACCEPT}
                          aria-label={`为请求上传补充材料：${truncateText(request.text, 24)}`}
                          disabled={supplementBusyId !== null}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void uploadSupplementMaterial(request.id, file);
                          }}
                        />
                        {supplementBusyId === request.id ? <small aria-live="polite">上传中…</small> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
              {supplementError ? <p className={s.error} role="alert">{supplementError}</p> : null}
            </div>

            <div className={s.reviewSection}>
              <header>
                <h3>备注</h3>
              </header>
              <label className={s.summaryEdit}>
                <span>会前备注</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
              </label>
              <div className={s.stageActions}>
                {/* 只在服务端下发了对应 Action 时渲染（与页面其他动作一致），不对缺失的 Action 强制断言。 */}
                {actionOf("meeting.update_draft") ? (
                  <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.update_draft")!, { note })}>
                    保存准备状态
                  </button>
                ) : null}
                {actionOf("meeting.cancel") ? (
                  <>
                    <label className={s.summaryEdit}>
                      <input type="checkbox" checked={cancelArmed} onChange={(event) => setCancelArmed(event.target.checked)} /> 我确认取消这场尚未召开的会议
                    </label>
                    <button type="button" disabled={pending || !cancelArmed} onClick={() => void run(actionOf("meeting.cancel")!, {})}>
                      取消会议
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}
    </div>
  );

  const statusNow = memberReadOnly && ended
    ? outcomeItems.length ? "会后结论已确认" : payload.minutesStatus === "waiting" ? "妙记生成中" : "会议已结束"
    : phase === "live" ? recorderLine(recorder.state) : meetingNow(payload, ended);

  const recordView =
    memberReadOnly && !(isHost && payload.status === "scheduled") ? (
      <section className={s.review}>
        {/* 实际参会的人能看完整纪要和「会上定了」；主持人在这里确认。 */}
        {memberOutcomeSummary(source) ? (
          <section className={s.reviewSection} data-outline="summary">
            <header><h3>会议纪要</h3></header>
            <p className={s.entryBody}>{memberOutcomeSummary(source)}</p>
          </section>
        ) : null}
        <MeetingDecisions decisions={payload.decisions ?? []} />
        <section className={s.reviewSection}>
          <header><h3>会后结论</h3></header>
          {outcomeItems.length ? (
            <>
              {minutes.decisions.length ? <section className={s.reviewSection}>
                <h3>会议共识</h3>
                {decisionGroups(minutes.decisions, outcomeItems).map(({ item, children }) => <div key={item.id}>
                  <p className={s.entryBody}>{cleanDisplayText(item.text)}</p>
                  {children.length ? <ul className={s.subDecisions}>{children.map((child) => <li key={child.id} className={s.subDecision}><p>{cleanDisplayText(child.text)}</p></li>)}</ul> : null}
                </div>)}
              </section> : null}
              {minutes.actions.length ? <section className={s.reviewSection}>
                <h3>待办事项</h3>
                {minutes.actions.map((group) => <div key={group.ownerId} className={s.ownerGroup}>
                  <h4>{people.get(group.ownerId) ?? group.ownerId}</h4>
                  {group.items.map((item) => <p key={item.id} className={s.entryBody}>{cleanDisplayText(item.text)}</p>)}
                </div>)}
              </section> : null}
            </>
          ) : <p className={s.empty}>暂无已确认的会后结论。</p>}
        </section>
      </section>
    ) : payload.status === "cancelled" ? (
      <p className={s.empty}>该会议已取消，无会议记录。</p>
    ) : payload.status === "scheduled" ? (
      <>
      {payload.recording && payload.recording.status !== "done" ? (
        <section className={s.reviewSection} aria-live="polite">
          <header>
            <h3>会议录音</h3>
            <span>{RECORDING_LABEL[payload.recording.status]}</span>
          </header>
          {payload.recording.status === "failed" ? (
            <p className={s.error} role="alert">
              {payload.recording.error ?? "录音转写失败。"}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className={s.reviewSection}>
        <header>
          <h3>导入会议记录</h3>
          {payload.minutesStatus === "waiting" ? <span>飞书妙记生成中</span> : null}
        </header>
        <div className={s.stageActions}>
          <input
            ref={uploadRef}
            type="file"
            accept=".md,.json,application/json,text/markdown"
            className={s.hiddenInput}
            aria-label="选择会议记录文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importTranscriptFile(file);
            }}
          />
          <button type="button" className={s.primaryAction} disabled={uploading} onClick={() => uploadRef.current?.click()}>
            <FileUp size={13} aria-hidden="true" />
            {uploading ? "上传中…" : payload.transcriptCandidate ? "重新导入会议记录" : "导入会议记录"}
          </button>
          {payload.transcriptCandidate && !candidateOpen ? (
            <button type="button" className={s.candidateReopen} onClick={() => setCandidateOpen(true)}>
              查看会议记录候选
            </button>
          ) : null}
        </div>
        {uploadError ? <p className={s.error} role="alert">{uploadError}</p> : null}
      </section>
      </>
    ) : (
      <section className={s.review}>
        {payload.outcome ? (
          <>
            <section className={s.reviewSection} data-outline="summary">
              <header>
                <h3>会议纪要</h3>
              </header>
              <p className={s.entryBody}>{payload.outcome.summary || "抽取尚未产出摘要。"}</p>
            </section>
            <MeetingDecisions decisions={payload.decisions ?? []} />
            {payload.outcome.error ? (
              <p className={s.error} role="alert" title={payload.outcome.error.code}>
                {payload.outcome.error.message}
                {actionOf("meeting.retry_outcome") ? (
                  <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_outcome")!, {})}>
                    重试会后抽取
                  </button>
                ) : null}
              </p>
            ) : null}
            {payload.issueIds.length ? (
              /* 会后条目收回到各自的议题块里确认（feedback 15）；没有议题的放在后面的「其他事项」。 */
              <div className={s.issueList} aria-label="按议题确认会后结论">{issueBlocks("outcome")}</div>
            ) : null}
            {payload.issueIds.length && outcomeGroups.others.length ? (
              <h3 className={s.blockLabel} data-outline="others">其他事项<span>没有关联议题的结论与待办</span></h3>
            ) : null}
            {minutes.decisions.length ? (
              <section className={s.reviewSection}>
                <header>
                  <h3>会议共识</h3>
                  <span className={s.count}>{decisionGroups(minutes.decisions, outcomeItems).length} 条</span>
                </header>
                {minutes.decisions.map(renderItem)}
              </section>
            ) : null}
            {minutes.actions.length ? (
              /* 待办会后自动推给负责人：收成一行，可展开查看，没有要办的操作。 */
              <details className={`${s.reviewSection} ${s.actionDigest}`}>
                <summary>
                  <h3>待办事项</h3>
                  <span className={s.count}>{actionCountText(minutes.actions.flatMap((group) => group.items))}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </summary>
                {minutes.actions.map((group) => (
                  <div key={group.ownerId} className={s.ownerGroup}>
                    <h4>{people.get(group.ownerId) ?? group.ownerId}</h4>
                    {group.items.map(renderItem)}
                  </div>
                ))}
              </details>
            ) : null}
            {minutes.strategic.length ? (
              <section className={s.reviewSection}>
                <header>
                  <h3>提给 CEO 的战略议题</h3>
                  <span className={s.count}>{minutes.strategic.length} 条</span>
                </header>
                {minutes.strategic.map(renderItem)}
              </section>
            ) : null}
            {minutes.others.length ? (
              <section className={s.reviewSection}>
                <header>
                  <h3>其他记录</h3>
                  <span className={s.count}>{minutes.others.length} 条</span>
                </header>
                {minutes.others.map(renderItem)}
              </section>
            ) : null}
          </>
        ) : (
          <p className={s.empty}>逐字稿已保存，会后抽取尚未开始。</p>
        )}
        <section className={s.reviewSection} data-outline="transcript">
          <header>
            <h3>逐字稿</h3>
          </header>
          <p className={s.entryBody}>
            {payload.transcript ? `${payload.transcript.turns.length} 条发言已保存` : "尚未导入逐字稿"}
          </p>
        </section>
        {actionOf("meeting.replace_transcript") ? (
          <section className={`${s.reviewSection} ${s.dangerSection}`}>
            <header>
              <h3>替换逐字稿 · 危险操作</h3>
            </header>
            <input ref={replaceRef} type="file" accept="application/json,.json" aria-label="选择替换用的逐字稿文件" />
            <label className={s.summaryEdit}>
              <input type="checkbox" checked={replaceArmed} onChange={(event) => setReplaceArmed(event.target.checked)} />
              我确认整份替换，现有会后候选随之作废
            </label>
            <div className={s.stageActions}>
              <button type="button" disabled={pending || !replaceArmed} onClick={() => void replaceTranscript()}>
                替换逐字稿
              </button>
            </div>
            {uploadError ? <p className={s.error} role="alert">{uploadError}</p> : null}
          </section>
        ) : null}
      </section>
    );

  const recordTab = memberReadOnly && !isHost ? { ...RECORD_TAB, title: "会议记录：已确认的决定与待办" } : RECORD_TAB;
  const showing = view.current === RECORD_TAB.id ? recordTab : viewedMaterial ? materialTab(viewedMaterial) : meetingHeld ? { ...PREFLIGHT_TAB, title: "会前预审" } : PREFLIGHT_TAB;

  return (
    <section ref={workspaceRef} className={s.workspace} data-testid="meeting-workspace" data-status={payload.status} data-timeline={timeline}
      {...{ [ESCAPE_BACK_ATTR]: viewingMaterialFile ? "true" : undefined }}>
      {confirmDialog}
      <SourceNavigatorProvider value={sourceApi}>
      <DetailFrame
        headingId="meeting-title"
        title={card.title}
        titleTag={titleEdit}
        onBack={() => onNavigate("/")}
        actions={
          <MeetingHeaderActions day={meetingDayWord(payload.scheduledAt)} slot={meetingSlot(payload.scheduledAt, payload.endsAt)} clock={clock}
            timeline={timeline} label={timelineLabel} since={startedAt ?? Date.parse(payload.scheduledAt)}>
            {meetingHeld ? <SegmentedSwitch data-header-switch="" label="会议视图" segments={meetingSegments(true)}
              selected={selectedSegment(view)} onSelect={(id) => setView(pickSegment(id))} /> : null}
          </MeetingHeaderActions>
        }
      >
        <div className={s.reading}>
          <div className={s.pane} data-material-column data-toc={outline ? "true" : undefined}>
            <ObjectMaterialArea objectType="meeting" objectId={card.objectRef.id} baseTabs={tabs}
              selected={view.current} homeTab={view.segment} selectedTab={meetingHeld && selectedSegment(view) ? null : view.current}
              onSelect={(id) => setView((current) => pickMaterial(current, id))}>
            <div className={s.readingGrid} data-toc={outline ? "true" : undefined} data-type-pair={view.current === PREFLIGHT_TAB.id && !viewedMaterial ? "preflight" : undefined}>
              {outline ? <MeetingOutline items={outline} active={outlineActive} onJump={jumpOutline} label={recordShown ? "会后目录" : "议题目录"} /> : null}
              <div className={s.readingMain} data-material-column ref={mainRef} onMouseUp={onQuoteMouseUp}>
                <MeetingStatus phase={phase} facts={facts} now={statusNow} endedAt={payload.endedAt} />
                {(memberReadOnly ? payload.purpose : payload.preflight.taskDefinition?.reviewPurpose) ?
                  <p className={s.agenda}>{stripInternalRefs(memberReadOnly ? payload.purpose : payload.preflight.taskDefinition?.reviewPurpose)}</p> : null}
                {preflightToolbar}
                <section className={s.material} aria-label={showing.title} data-running={payload.preflight.status === "running" && payload.preflight.entries.length ? "true" : undefined}>
                  {view.current === RECORD_TAB.id ? (
                    recordView
                  ) : viewedMaterial ? (
                    <MaterialPane meetingId={card.objectRef.id} material={viewedMaterial} preview={preview} provenance={provenance(viewedMaterial)} />
                  ) : (
                    preflightView
                  )}
                </section>
                <SelectionToolbar
                  selected={quoteSelection}
                  onQuote={() => {
                    if (!quoteSelection) return;
                    workspace.quote(quoteSelection.text);
                    clearQuote();
                  }}
                />
              </div>
            </div>
            </ObjectMaterialArea>
            <ActionFeedback state={state} onRetry={retry} />
          </div>
        </div>
      </DetailFrame>
      {sourceOverlay}
      </SourceNavigatorProvider>
      {(!memberReadOnly || isHost) && payload.transcriptCandidate && candidateOpen ? (
        <TranscriptCandidateDialog
          key={payload.transcriptCandidate.createdAt}
          dialogRef={candidateDialog}
          candidate={payload.transcriptCandidate}
          scheduledAt={payload.scheduledAt}
          participants={payload.participants}
          directory={directory}
          directoryError={directoryError}
          pending={pending}
          state={state}
          hasConfirm={Boolean(actionOf("meeting.confirm_transcript_candidate"))}
          hasDiscard={Boolean(actionOf("meeting.discard_transcript_candidate"))}
          onRetry={retry}
          onClose={() => setCandidateOpen(false)}
          onConfirm={confirmCandidate}
          onDiscard={discardCandidate}
        />
      ) : null}
    </section>
  );
}

/** 成员工作区登记同一张成员投影 Card；主持人只多出本场结束 Action。 */
export function MemberMeetingDetail({ card }: { card: CardRenderProps["card"] }) {
  const workspace = useWorkspace();
  const [currentCard, setCurrentCard] = useState(card);
  useEffect(() => setCurrentCard(card), [card]);
  const cards = useMemo(() => [currentCard], [currentCard]);
  const group = useMemo(() => ({ kind: "thread" as const, objectType: "meeting" as const,
    objectId: card.objectRef.id, viewerId: workspace.viewerId ?? "", members: [] }), [card.objectRef.id, workspace.viewerId]);
  useRegisterDetail({ scope: `meeting:${card.objectRef.id}`, label: currentCard.title, mark: "meeting", cards, group });
  return <MeetingCard card={currentCard} collection={cards} onCard={setCurrentCard}
    onNavigate={(href, origin) => href === "/" ? workspace.close() : workspace.navigate(href, origin)} readOnly />;
}
