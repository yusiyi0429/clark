"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileUp, Pencil, RefreshCw, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { TTranscriptCandidateProjection } from "@warmap/contracts";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { issueScopeLabel } from "./scopeNames";
import { useConfirm } from "@/components/ConfirmDialog";
import { MeetingClock, MeetingHeaderActions, MeetingStatus, meetingDayWord, meetingPhase, meetingSlot } from "@/components/meeting/MeetingHeader";
import { useMeetingRecorder, type RecorderState } from "@/components/meeting/useMeetingRecorder";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { HeaderMaterialToggle, pressMaterial, toggleWhole, useRememberedScroll, type MaterialTab, type MaterialView } from "@/components/shell/MaterialTabs";
import { ObjectMaterialArea } from "@/components/materials/ObjectMaterialArea";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { ActionFeedback, useCardAction, type ActionState } from "@/lib/useCardAction";
import { groupPreflight, pickActiveSection } from "./preflightOutline";
import s from "@/styles/meeting-workspace.module.css";


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

const READINESS_LABEL: Record<string, string> = { ready: "可提交", revise: "修改后提交", blocked: "暂不提交" };
const INPUT_LABEL: Record<string, string> = { available: "已具备", derived: "系统推导", missing: "待补" };

const MIME_BADGE: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/markdown": "MD",
};

/** preview endpoint 按内容类型返回 PDF/清洗 HTML/纯文本；其余类型只能下载。 */
export function previewKind(contentType: string): "pdf" | "html" | "text" | null {
  const type = contentType.split(";")[0].trim();
  if (type === "application/pdf") return "pdf";
  if (type === "text/html") return "html";
  if (type === "text/plain") return "text";
  return null;
}

export type MaterialMeta = { id: string; fileName: string; mimeType: string; sizeBytes: number; pageCount?: number; providedBy?: string | null; uploadedAt: string; kind?: "primary" | "supplement"; supplementFor?: string };

/** “24 页 · 林晓 · 2026-09-20 · 12 KB”：只拼接存在的字段。 */
export function materialMeta(material: MaterialMeta): string {
  return [
    material.pageCount ? `${material.pageCount} 页` : null,
    material.providedBy ?? null,
    material.uploadedAt ? material.uploadedAt.slice(0, 10) : null,
    `${Math.ceil(material.sizeBytes / 1024)} KB`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type MaterialPreview =
  | { state: "idle" | "loading" }
  | { state: "ready"; kind: "pdf"; url: string }
  | { state: "ready"; kind: "html" | "text"; content: string }
  | { state: "error"; error: string };

const MATERIAL_ACCEPT = "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md";

/** 人员目录投影：人员映射下拉与编辑会议的主持 DRI 下拉共用这一份结构。 */
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

/** 一份材料的只读预览（材料页签里）：PDF 原样、DOCX 清洗 HTML、MD 纯文本；底下一行出处与下载。任何状态都不含编辑。 */
export function MaterialPane({ meetingId, material, preview, provenance = "" }: { meetingId: string; material: MaterialMeta; preview: MaterialPreview; provenance?: string }) {
  return (
    <div className={s.readerPane} aria-live="polite">
      {preview.state === "loading" || preview.state === "idle" ? <p className={s.empty}>预览加载中…</p> : null}
      {preview.state === "error" ? <p className={s.error} role="alert">{preview.error}</p> : null}
      {preview.state === "ready" && preview.kind === "pdf" ? <iframe className={s.readerFrame} src={preview.url} title={`${material.fileName} 预览`} /> : null}
      {preview.state === "ready" && preview.kind === "html" ? (
        <iframe
          className={s.readerFrame}
          sandbox=""
          title={`${material.fileName} 预览`}
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.8 -apple-system,system-ui,sans-serif;color:#282c32;padding:18px;max-width:44em;margin:0 auto}</style>${preview.content}`}
        />
      ) : null}
      {preview.state === "ready" && preview.kind === "text" ? <pre className={s.readerText}>{preview.content}</pre> : null}
      <p className={s.readerPaneFoot}>
        <span className={s.readerBadge}>{MIME_BADGE[material.mimeType] ?? "文件"}</span>
        <span>
          {material.fileName} · {materialMeta(material)}
          {provenance}
        </span>
        <a href={`/api/meetings/${meetingId}/materials/${material.id}/download`} aria-label={`下载 ${material.fileName}`}>
          下载原件
        </a>
      </p>
    </div>
  );
}

export type SpeakerMappingRow = {
  speakerName: string;
  turnCount: number;
  personId: string;
  suggestedPersonId: string | null;
  suggestedDisplayName: string | null;
  status: "existing" | "add" | "unmapped";
};

/** 映射表状态：已参与 / 确认后加入 / 未映射；同一个人不能映射多个说话人。 */
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
  const ids = rows.map((row) => row.personId);
  if (new Set(ids).size !== ids.length) return "同一个人不能映射多个说话人";
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
                    <select
                      aria-label={`映射 ${row.speakerName}`}
                      value={row.personId}
                      disabled={pending}
                      onChange={(event) => setMappings({ ...mappings, [row.speakerName]: event.target.value })}
                    >
                      <option value="">请选择人员</option>
                      {row.suggestedPersonId && !directory.some((person) => person.personId === row.suggestedPersonId) ? (
                        <option value={row.suggestedPersonId}>{row.suggestedDisplayName ?? row.suggestedPersonId}</option>
                      ) : null}
                      {directory.map((person) => (
                        <option key={person.personId} value={person.personId}>
                          {person.displayName}
                        </option>
                      ))}
                    </select>
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
            {pending ? "确认中…" : "确认并写入 Transcript"}
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

/** 计时弹出那一小块里的说明：按下「开完了」会发生什么。 */
export function recordingNote(state: RecorderState): string {
  if (state.status === "recording") return "正在录音。按下这一下，停止录音并记为已开完；录音转成文字后，在「会议记录」里确认每位说话人是谁。不取消飞书日程。";
  return `${state.error ?? "这场会没有录音。"}按下这一下，这场会记为已开完，接着在「会议记录」里导入妙记或逐字稿；不取消飞书日程。`;
}

const PREFLIGHT_TAB: MaterialTab = { id: "preflight", label: "AI 预审", title: "AI 预审：会前材料的评审结论" };
const GROUP_MATERIAL_TAB: MaterialTab = { id: "group-materials", label: "群组材料", title: "群组材料" };
/** 整场会的那一页：页头胶囊里的入口。会前在这里导入妙记或逐字稿，会后在这里逐项复核。 */
const RECORD_TAB: MaterialTab = { id: "record", label: "会议记录", title: "会议记录：妙记或逐字稿与会后复核" };
/** 会中录音与「开始会议」／计时留到下一版（用户 2026-09-29 定）：代码保留，这一版页头不放；会后照常导入会议记录。 */
const MEETING_CLOCK_ENABLED = false;

/** 材料页签上的短名：去掉扩展名，补充材料前面写「补充」。 */
export function materialTab(material: MaterialMeta): MaterialTab {
  const name = material.fileName.replace(/\.(pdf|docx|md)$/i, "");
  return { id: material.id, label: material.kind === "supplement" ? `补充 · ${name}` : name, title: `会议材料：${material.fileName}` };
}

type OutcomeItem = NonNullable<MeetingPayload["outcome"]>["items"][number];

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
    return { state: "pending", label: "等 CEO 确认" };
  }
  if (item.kind === "todo") {
    const owner = actionOwner(item, payload);
    if (status === "confirmed") return { state: "confirmed", label: item.review?.effectRef?.startsWith("task:") ? `已推送给${name(owner)}` : "已确认" };
    if (status === "dismissed") return { state: "dismissed", label: "已忽略" };
    return { state: "pending", label: owner === payload.ceoParticipantId ? "CEO 的事，只留在纪要" : "待推送" };
  }
  if (status === "confirmed") return { state: "confirmed", label: "已确认" };
  if (status === "dismissed") return { state: "dismissed", label: "已忽略" };
  return { state: "pending", label: "待处理" };
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
export function recordingInFlight(recording: MeetingPayload["recording"]): boolean {
  return recording?.status === "transcoding" || recording?.status === "uploading" || recording?.status === "transcribing";
}

/** 材料上面那一行灰字里「这一刻的一件事」。 */
export function meetingNow(payload: MeetingPayload, ended: boolean): string {
  if (payload.status === "cancelled") return "已取消";
  if (payload.status === "reviewed") return "会后事项已处理完";
  if (payload.status === "held") {
    if (payload.outcome?.status !== "ready") return "正在整理纪要";
    return payload.outcome.items.some((item) => item.kind === "strategic" && item.review?.status === "pending") ? "纪要已生成 · 等 CEO 确认战略议题" : "纪要已生成";
  }
  if (ended && payload.transcriptCandidate) return "会议记录待确认说话人";
  if (ended && recordingInFlight(payload.recording)) return "录音转写中";
  if (ended && payload.recording?.status === "failed") return "录音转写失败，可导入妙记";
  if (ended) return "待导入会议记录";
  if (payload.preflight.status === "running") return "会前预审中";
  return `会前预审 · ${READINESS_LABEL[payload.preflight.readiness ?? ""] ?? "待预审"}`;
}

/**
 * Meeting 页面（clark 会议二级页，C-08）：矩形页头里是计划时段、会名、材料下拉钮（AI 预审 + 每一份会前材料 + 群组材料 +
 * 添加材料）、会议记录入口（开始会议／计时这一版不放，见 MEETING_CLOCK_ENABLED）；页头下面一行状态，再下面是正在看的那一份。
 * 会前预审、妙记导入、会后逐项复核这些真实功能都在：AI 预审（编辑会议、返回编辑材料、重新预审在它顶部）、材料（只读预览）、
 * 会议记录（导入与复核）。
 */
export function MeetingCard({ card, collection, onCard, onNavigate, readOnly: memberReadOnly = false }: CardRenderProps & { readOnly?: boolean }) {
  const source = payloadOf<MeetingPayload & { purpose?: string | null }>(card);
  // 成员响应只带可见事实；组件内部补空值以复用 CEO 的页头、材料和预审排版。
  const payload: MeetingPayload & { purpose?: string | null } = memberReadOnly ? {
    ...source,
    issueIds: [], ceoParticipantId: "", originRef: null,
    preflight: { status: source.preflight.status, pendingSince: null, runId: null, entries: [], basis: "",
      brief: source.preflight.brief, error: null, generatedAt: null,
      ...(source.preflight.readiness ? { readiness: source.preflight.readiness } : {}),
      ...(source.preflight.summary ? { summary: source.preflight.summary } : {}) },
    draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
    transcript: null, transcriptCandidate: null, recording: null,
  } : source;
  const workspace = useWorkspace();
  const { homeCards } = workspace;
  const { ask, dialog: confirmDialog } = useConfirm();
  const { state, run, retry, pending } = useCardAction(onCard);
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
  const [activeSection, setActiveSection] = useState("core");
  // 编辑会议弹层：只提交改动字段，写入走 opaque action meeting.edit_details。
  const [editOpen, setEditOpen] = useState(false);
  const detailsForm = () => ({ title: card.title, scheduledAt: toCompanyInput(payload.scheduledAt), endsAt: toCompanyInput(payload.endsAt), leadDriId: payload.leadDriId });
  const [editForm, setEditForm] = useState(detailsForm);
  const [driOptions, setDriOptions] = useState<DirectoryOption[]>([]);
  const [driError, setDriError] = useState<string | null>(null);
  // 妙记候选：全量人员目录 + 预览弹层；候选变化（重上传）时靠 key 重置映射。
  const [candidateOpen, setCandidateOpen] = useState(Boolean(payload.transcriptCandidate));
  const [directory, setDirectory] = useState<DirectoryOption[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // 左侧阅读区看哪一份：会前默认 AI 预审；会开完了、有待确认的会议记录或已在复核，默认会议记录（那是下一步要做的事）。
  const [view, setView] = useState<MaterialView>(() => ({
    current:
      payload.status === "held" || payload.status === "reviewed" || (payload.status === "scheduled" && (payload.endedAt || payload.transcriptCandidate))
        ? RECORD_TAB.id
        : PREFLIGHT_TAB.id,
    material: PREFLIGHT_TAB.id,
  }));
  // 「开始会议」计时是这一页的状态（和概念版一样），同时开始录音；「这场会开完了」停下录音交给服务端转写，并写进后台。
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const recorder = useMeetingRecorder(card.objectRef.id);
  const [preview, setPreview] = useState<MaterialPreview>({ state: "idle" });
  const previewUrlRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const materialRef = useRef<HTMLInputElement>(null);
  const candidateDialog = useRef<HTMLDialogElement>(null);

  const isHost = memberReadOnly && payload.leadDriId === workspace.viewerId;
  const actions = memberReadOnly ? card.actions.filter((action) => action.actionType === "meeting.end") : card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const itemAction = (type: string, itemId: string) =>
    actions.find((action) => action.actionType === type && action.itemId === itemId);

  const issues = collection.filter((item) => item.kind === "issue");
  const issueById = new Map(issues.map((item) => [item.objectRef.id, item]));
  const people = new Map(payload.participants.map((person) => [person.personId, person.displayName]));
  const dri = payload.participants.filter((person) => person.roles.includes("dri"));
  const readOnly = memberReadOnly || payload.status !== "scheduled";
  const viewedMaterial = payload.materials.find((material) => material.id === view.current) ?? null;

  useRememberedScroll(`${card.objectRef.id}|${view.current}`);

  useEffect(() => {
    const id = viewedMaterial?.id;
    if (!id) return;
    const controller = new AbortController();
    setPreview({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/meetings/${card.objectRef.id}/materials/${id}/preview`, {
          headers: { accept: "application/pdf, text/html, text/plain" },
          signal: controller.signal,
        });
        if (response.status === 401) {
          window.location.assign("/access");
          return;
        }
        if (!response.ok) throw new Error("材料预览加载失败");
        const kind = previewKind(response.headers.get("content-type") ?? "");
        if (!kind) throw new Error("该类型不支持在线预览，请下载原件");
        if (kind === "pdf") {
          const url = URL.createObjectURL(await response.blob());
          if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = url;
          setPreview({ state: "ready", kind, url });
        } else {
          setPreview({ state: "ready", kind, content: await response.text() });
        }
      } catch (cause) {
        if (!controller.signal.aborted) setPreview({ state: "error", error: (cause as Error).message });
      }
    })();
    return () => controller.abort();
  }, [viewedMaterial?.id, card.objectRef.id]);

  // 离开这一页时回收 PDF 预览的 object URL。
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const candidateKey = payload.transcriptCandidate?.createdAt ?? null;

  // 录音转写中、会后抽取中：每 5 秒取一次会议卡片，状态、候选、纪要跟着更新；候选一到，下面那段就自动打开说话人对应。
  const transcribing = recordingInFlight(payload.recording);
  const extracting = payload.status === "held" && (payload.outcome?.status === "pending" || payload.outcome?.status === "running");
  const refreshing = !memberReadOnly && (transcribing || extracting);
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(async () => {
      const { data } = await browserApi.GET("/api/cards/meetings/{id}", { params: { path: { id: card.objectRef.id } } });
      const next = data?.cards?.[0];
      if (next) onCard(next);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshing, card.objectRef.id, onCard]);

  // 候选出现或重上传后自动打开预览；关闭只收起，不回滚服务端候选。
  useEffect(() => {
    if (candidateKey) setCandidateOpen(true);
  }, [candidateKey]);

  useEffect(() => {
    if (!candidateOpen) return;
    const dialog = candidateDialog.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const onClose = () => setCandidateOpen(false);
    dialog.addEventListener("close", onClose);
    return () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
    };
  }, [candidateOpen]);

  // 映射下拉需要完整人员目录（不限 DRI）；加载失败时确认保持不可用。
  useEffect(() => {
    if (!candidateKey) return;
    let cancelled = false;
    void (async () => {
      const { data, response } = await browserApi.GET("/api/people");
      if (cancelled) return;
      if (!response.ok) {
        setDirectoryError("人员目录加载失败，无法完成说话人映射");
        return;
      }
      setDirectoryError(null);
      setDirectory((data as { people?: DirectoryOption[] } | undefined)?.people ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateKey]);

  function toggle(field: "readIssueIds" | "checkedEntryIds" | "carriedIssueIds", id: string) {
    const current = payload.draft[field];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    const action = actionOf("meeting.update_draft");
    if (action) void run(action, { [field]: next });
  }

  /** 编辑弹层回填当前 Card 事实；主持 DRI 只列人员目录里的 DRI，目录不可用时保留当前值。 */
  async function openEditDetails() {
    setEditForm(detailsForm());
    setDriError(null);
    setEditOpen(true);
    const { data, response } = await browserApi.GET("/api/people");
    if (!response.ok) {
      setDriError("人员目录加载失败，暂时只能保留当前主持 DRI");
      return;
    }
    setDriOptions((((data as { people?: DirectoryOption[] } | undefined)?.people ?? []).filter((person) => person.roles.includes("dri"))));
  }

  /** 只提交真正改动的字段：未改的时间不重写。时间按公司时区提交。 */
  async function saveMeetingDetails() {
    const action = actionOf("meeting.edit_details");
    if (!action) return;
    const initial = detailsForm();
    const patch: { title?: string; scheduledAt?: string; endsAt?: string; leadDriId?: string } = {};
    const title = editForm.title.trim();
    if (title && title !== card.title) patch.title = title;
    if (editForm.scheduledAt && editForm.scheduledAt !== initial.scheduledAt) patch.scheduledAt = fromCompanyInput(editForm.scheduledAt);
    if (editForm.endsAt && editForm.endsAt !== initial.endsAt) patch.endsAt = fromCompanyInput(editForm.endsAt);
    if (editForm.leadDriId && editForm.leadDriId !== payload.leadDriId) patch.leadDriId = editForm.leadDriId;
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
      onCard(body.cards[0]);
      return;
    }
    setUploadError(body.message ?? "Transcript 整份被拒绝");
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
    if (response.ok && body.cards?.[0]) return onCard(body.cards[0]);
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
      setUploadError("请选择要替换成的 Transcript 文件。");
      return;
    }
    let transcript: unknown;
    try {
      transcript = JSON.parse(await file.text());
    } catch {
      setUploadError("Transcript 不是合法 JSON");
      return;
    }
    setUploadError(null);
    void run(action, { transcript, confirmReplace: true });
  }

  const coreEntry = payload.preflight.entries.find((entry) => entry.kind === "core_judgment");
  /** 一号位点评在左侧 amber 参考盒里，正文目录因此只剩其余几段。 */
  const lensEntries = payload.preflight.entries.filter((entry) => entry.kind === "leader_lens");
  const preflightGroups = groupPreflight(payload.preflight.entries, Boolean(payload.preflight.taskDefinition))
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.kind !== "leader_lens") }))
    .filter((group) => group.entries.length > 0);
  const checkedCount = payload.draft.checkedEntryIds.filter((id) => payload.preflight.entries.some((entry) => entry.id === id)).length;
  const sourceLabel = (ref: string) => {
    const [kind, id] = ref.split(":", 2);
    if (kind === "meeting" && id === card.objectRef.id) return "当前 Meeting";
    if (kind === "issue") return issueById.get(id)?.title ?? `关联 Issue · ${id}`;
    if (kind === "research") return `关联 Issue 预研 · ${issueById.get(id)?.title ?? id}`;
    if (kind === "memory") return `企业知识 · ${ref.split("#").at(-1) ?? id}`;
    if (kind === "transcript") return "关联会议 Transcript";
    if (kind === "outcome") return "关联会议 Outcome";
    return ref;
  };

  /** 评审目录 scroll-spy：以阅读页（.ts-detail）顶部为基准，让出页头胶囊和材料页签，取最后一个越过分界线的章节。 */
  const preflightShown = view.current === PREFLIGHT_TAB.id;
  useEffect(() => {
    const scroller = mainRef.current?.closest<HTMLElement>(".ts-detail");
    if (!scroller || !preflightShown || !payload.preflight.taskDefinition) return;
    const sync = () => {
      const boundary = scroller.getBoundingClientRect().top + 120;
      const sections = [...(mainRef.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])].map((section) => ({
        key: section.dataset.section ?? "",
        top: section.getBoundingClientRect().top,
      }));
      setActiveSection(pickActiveSection(sections, boundary));
    };
    sync();
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => scroller.removeEventListener("scroll", sync);
  }, [preflightShown, payload.preflight.taskDefinition]);

  function jump(kind: string) {
    const target = mainRef.current?.querySelector<HTMLElement>(`[data-section="${kind}"]`);
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  /* 下拉永远包含当前主持 DRI：目录加载失败也不会把值改成空。 */
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
    <section key={group.key} className={s.reviewSection} data-section={group.key}>
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
            <details className={s.sources}>
              <summary>查看依据（{entry.sourceRefs.length}）</summary>
              <ul>{entry.sourceRefs.map((ref) => <li key={ref}>{sourceLabel(ref)}</li>)}</ul>
            </details>
            {readOnly ? null : (
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
            )}
          </article>
        );
      })}
    </section>
  );

  /* 页头：计划时段、会议记录入口、开始会议／计时（这一版不放；已取消的会也没有计时）。 */
  const ended = Boolean(payload.endedAt) || payload.status === "held" || payload.status === "reviewed";
  const phase = meetingPhase(startedAt, ended);
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
          setView((current) => ({ ...current, current: RECORD_TAB.id }));
        }}
      />
    );
  const participantNames = payload.participants.map((person) => person.displayName);
  const facts = [
    `${people.get(payload.leadDriId) ?? "主持人待确认"}主持`,
    participantNames.length <= 4 ? `参会：${participantNames.join("、")}` : `${participantNames.length} 人参会`,
  ];
  const tabs = [PREFLIGHT_TAB, ...payload.materials.map(materialTab)];
  const provenance = (material: MaterialMeta) => {
    const request = payload.draft.supplementRequests.find((item) => item.id === material.supplementFor);
    return request ? ` · 回应「${truncateText(request.text, 24)}」` : "";
  };

  const preflightToolbar = readOnly ? null : (
    <div className={s.toolbar}>
      {actionOf("meeting.edit_details") ? (
        <button type="button" disabled={pending} onClick={() => void openEditDetails()}>
          <Pencil size={13} aria-hidden="true" />
          编辑会议
        </button>
      ) : null}
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
      {actionOf("meeting.regenerate_preflight") ? (
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            if (await ask("重新预审会替换当前条目，并清除旧条目的核对和编辑状态。是否继续？")) {
              void run(actionOf("meeting.regenerate_preflight")!, {});
            }
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {pending ? "预审中…" : "重新预审"}
        </button>
      ) : null}
      {editOpen ? (
        <div className={s.editPopover} role="dialog" aria-label="编辑会议">
          <p className={s.editTitle}>编辑会议</p>
          <label className={s.editField}>
            <span>会议标题</span>
            <input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
          </label>
          <label className={s.editField}>
            <span>开始</span>
            <input type="datetime-local" value={editForm.scheduledAt} onChange={(event) => setEditForm({ ...editForm, scheduledAt: event.target.value })} />
          </label>
          <label className={s.editField}>
            <span>结束</span>
            <input type="datetime-local" value={editForm.endsAt} onChange={(event) => setEditForm({ ...editForm, endsAt: event.target.value })} />
          </label>
          <label className={s.editField}>
            <span>主持 DRI</span>
            <span className={s.editSelectWrap}>
              <select value={editForm.leadDriId} onChange={(event) => setEditForm({ ...editForm, leadDriId: event.target.value })}>
                {editDriOptions.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.displayName}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden="true" className={s.editChevron} />
            </span>
          </label>
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
        </div>
      ) : null}
    </div>
  );

  const preflightView = (
    <section className={s.advisorShell}>
      <aside className={s.prioritySidebar} aria-label="会前结论与评审目录">
        <div className={s.readinessBlock}>
          <small>预审结论</small>
          <span className={s.readiness} data-readiness={payload.preflight.readiness ?? "legacy"}>
            {READINESS_LABEL[payload.preflight.readiness ?? ""] ?? "会前材料"}
          </span>
        </div>
        {payload.issueIds.length ? (
          <div className={s.sidebarIssues} aria-label="关联议题">
            <small>关联议题{payload.issueIds.length > 1 ? ` · ${payload.issueIds.length} 项` : ""}</small>
            {payload.issueIds.map((issueId) => {
              const issue = issueById.get(issueId);
              const read = payload.draft.readIssueIds.includes(issueId);
              const carried = payload.draft.carriedIssueIds.includes(issueId);
              return (
                <article key={issueId} className={s.linkedIssue} data-read={read}>
                  <small>{issue ? issueScopeLabel((issue.payload as IssuePayload).location, homeCards) : "议题"}</small>
                  <h4 title={issue?.title ?? issueId}>{issue?.title ?? issueId}</h4>
                  <div className={s.briefActions}>
                    {readOnly ? null : (
                      <>
                        <button type="button" aria-pressed={read} disabled={pending} onClick={() => toggle("readIssueIds", issueId)}>
                          <Check size={12} aria-hidden="true" />
                          已阅
                        </button>
                        <button type="button" aria-pressed={carried} disabled={pending} onClick={() => toggle("carriedIssueIds", issueId)}>
                          带到会议
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => onNavigate(`/issues/${issueId}`)}>
                      打开 Issue
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {lensEntries.length ? (
          <div className={s.leaderLens}>
            <small>一号位追问</small>
            <ol>
              {lensEntries.map((entry) => (
                <li key={entry.id}>{entry.body}</li>
              ))}
            </ol>
          </div>
        ) : null}
        {payload.preflight.inputCoverage ? (
          <div className={s.coverage}>
            <small>四输入边界</small>
            <span>背景 <b>{INPUT_LABEL[payload.preflight.inputCoverage.background]}</b></span>
            <span>目的 <b>{INPUT_LABEL[payload.preflight.inputCoverage.purpose]}</b></span>
            <span>源材料 <b>{INPUT_LABEL[payload.preflight.inputCoverage.sourceMaterial]}</b></span>
            <span>关联会议 <b>{INPUT_LABEL[payload.preflight.inputCoverage.relatedMeeting]}</b></span>
          </div>
        ) : null}
        {payload.preflight.entries.length ? (
          <nav className={s.outline} aria-label="评审目录">
            <div className={s.outlineHead}>
              <small>评审目录</small>
              <span>
                {checkedCount} / {payload.preflight.entries.length}
              </span>
            </div>
            <button type="button" data-active={activeSection === "core"} onClick={() => jump("core")}>
              <span>核心判断</span>
            </button>
            {preflightGroups.map((group) => (
              <button key={group.key} type="button" data-active={activeSection === group.key} onClick={() => jump(group.key)}>
                <span>{group.shortLabel}</span>
                <em>
                  {group.entries.filter((entry) => payload.draft.checkedEntryIds.includes(entry.id)).length}/{group.entries.length}
                </em>
              </button>
            ))}
          </nav>
        ) : null}
      </aside>

      <main className={s.advisorMain} ref={mainRef}>
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
                <a href={`/api/meetings/${card.objectRef.id}/materials/${material.id}/download`}>{material.fileName}</a> · {Math.ceil(material.sizeBytes / 1024)} KB
              </p>
            ))}
            <input ref={materialRef} type="file" multiple accept={MATERIAL_ACCEPT} aria-label="选择会前材料" />
            <div className={s.stageActions}>
              <button type="button" disabled={uploading} onClick={() => void replaceMaterials()}>{uploading ? "解析中…" : "替换材料集"}</button>
              {actionOf("meeting.run_preflight") ? <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.run_preflight")!, {})}>运行预审</button> : null}
            </div>
          </section>
        ) : null}
        <section className={s.judgmentHero} data-section="core">
          <small>核心判断</small>
          <h2>{coreEntry?.title ?? "会前预审"}</h2>
          <p>{(coreEntry?.body ?? payload.preflight.brief) || "预审尚未产出会议简报。"}</p>
          {payload.preflight.summary ? (
            <div className={s.heroSummary}>
              <span><small>最优先动作</small>{payload.preflight.summary.priorityAction}</span>
              <span><small>最关键问题</small>{payload.preflight.summary.criticalIssue}</span>
            </div>
          ) : null}
          {coreEntry ? (
            <details className={s.sources}>
              <summary>查看依据（{coreEntry.sourceRefs.length}）</summary>
              <ul>{coreEntry.sourceRefs.map((ref) => <li key={ref}>{sourceLabel(ref)}</li>)}</ul>
            </details>
          ) : null}
        </section>
        {payload.preflight.error ? (
          <p className={s.error} role="alert" title={payload.preflight.error.code}>
            {payload.preflight.error.message}
            {actionOf("meeting.retry_preflight") ? (
              <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_preflight")!, {})}>
                重试预审
              </button>
            ) : null}
          </p>
        ) : null}

        {payload.preflight.taskDefinition ? (
          <details className={s.taskContext}>
            <summary>材料任务与评审边界</summary>
            <div><small>材料目的</small><p>{payload.preflight.taskDefinition.materialPurpose}</p></div>
            <div><small>本次评审目的</small><p>{payload.preflight.taskDefinition.reviewPurpose}</p></div>
            <div><small>读者下一动作</small><p>{payload.preflight.taskDefinition.readerAction}</p></div>
            <div><small>本材料非目标</small><p>{payload.preflight.taskDefinition.nonGoal}</p></div>
            <div><small>证据边界</small><p>{payload.preflight.basis}</p></div>
          </details>
        ) : null}

        {beforePair.map(renderGroup)}
        {pairGroups.length ? <div className={s.pairRow}>{pairGroups.map(renderGroup)}</div> : null}
        {afterPair.map(renderGroup)}

        {readOnly ? null : (
          <>
            <div className={s.reviewSection}>
              <header>
                <h3>请求补充材料</h3>
                <span>{payload.draft.supplementRequests.length} 条已记录</span>
              </header>
              <label className={s.summaryEdit}>
                <span>目标 DRI</span>
                <select value={supplementTarget} onChange={(event) => setSupplementTarget(event.target.value)} aria-label="目标 DRI">
                  {dri.map((person) => (
                    <option key={person.personId} value={person.personId}>
                      {person.displayName}
                    </option>
                  ))}
                </select>
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
              <p className={s.publishReceipt}>没有真实渠道回执时只记录为待外发，不显示已送达。</p>
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
          </>
        )}
      </main>
    </section>
  );

  /* 会后纪要：共识（决定）、按负责人分组的 Action Item（待办）、提给 CEO 的战略议题，其余照原样列在后面。 */
  const outcomeItems = payload.outcome?.items ?? [];
  const statusNow = memberReadOnly && ended
    ? outcomeItems.length ? "会后结论已确认" : "会议已结束"
    : phase === "live" ? recorderLine(recorder.state) : meetingNow(payload, ended);
  const minutes = {
    decisions: outcomeItems.filter((item) => item.kind === "decision"),
    actions: [...outcomeItems.filter((item) => item.kind === "todo").reduce((groups, item) => {
      const ownerId = actionOwner(item, payload);
      groups.set(ownerId, [...(groups.get(ownerId) ?? []), item]);
      return groups;
    }, new Map<string, typeof outcomeItems>())].map(([ownerId, items]) => ({ ownerId, items })),
    strategic: outcomeItems.filter((item) => item.kind === "strategic"),
    others: outcomeItems.filter((item) => !["decision", "todo", "strategic"].includes(item.kind)),
  };
  const renderItem = (item: (typeof outcomeItems)[number]) => {
    const itemState = outcomeItemState(item, payload, (id) => people.get(id) ?? id);
    return (
      <article key={item.id} className={s.decisionRecord} data-kind={item.kind}>
        <div className={s.itemHead}>
          <span className={s.kindBadge}>{ITEM_LABEL[item.kind] ?? item.kind}</span>
          <p className={s.itemText}>{item.kind === "strategic" && item.title ? item.title : item.text}</p>
        </div>
        {item.kind === "strategic" && item.brief ? <p className={s.entryBody}>{item.brief}</p> : null}
        <blockquote className={s.itemQuote}>
          <p>{item.quote}</p>
        </blockquote>
        <div className={s.itemMeta}>
          <div className={s.itemMetaLeft}>
            <span>{people.get(item.speakerId) ?? item.speakerId}</span>
            {item.dueDate ? <span>{item.dueDate.slice(5).replace("-", "/")} 前</span> : null}
            <span className={s.itemState} data-state={itemState.state}>
              {itemState.label}
            </span>
          </div>
          <div className={s.itemActions}>
            {itemAction("meeting.confirm_item", item.id) ? (
              <button type="button" data-variant="confirm" disabled={pending} onClick={() => void run(itemAction("meeting.confirm_item", item.id)!, {})}>
                {item.kind === "todo" ? "推送" : "确认"}
              </button>
            ) : null}
            {itemAction("meeting.dismiss_item", item.id) ? (
              <button type="button" disabled={pending} onClick={() => void run(itemAction("meeting.dismiss_item", item.id)!, {})}>
                {item.kind === "strategic" ? "不同意" : "忽略"}
              </button>
            ) : null}
            {itemAction("meeting.revoke_effect", item.id) ? (
              <button type="button" disabled={pending} onClick={() => void run(itemAction("meeting.revoke_effect", item.id)!, {})}>
                撤回
              </button>
            ) : null}
          </div>
        </div>
      </article>
    );
  };

  const recordView =
    memberReadOnly ? (
      <section className={s.review}>
        <section className={s.reviewSection}>
          <header><h3>会后结论</h3></header>
          {outcomeItems.length ? (
            <>
              {minutes.decisions.length ? <section className={s.reviewSection}>
                <h3>会议共识</h3>
                {minutes.decisions.map((item) => <p key={item.id} className={s.entryBody}>{item.text}</p>)}
              </section> : null}
              {minutes.actions.length ? <section className={s.reviewSection}>
                <h3>Action Item</h3>
                {minutes.actions.map((group) => <div key={group.ownerId} className={s.ownerGroup}>
                  <h4>{people.get(group.ownerId) ?? group.ownerId}</h4>
                  {group.items.map((item) => <p key={item.id} className={s.entryBody}>{item.text}</p>)}
                </div>)}
              </section> : null}
            </>
          ) : <p className={s.empty}>暂无已确认的会后结论。</p>}
        </section>
      </section>
    ) : payload.status === "cancelled" ? (
      <p className={s.empty}>这场会已取消，没有会议记录。</p>
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
              {payload.recording.error ?? "录音没能转成文字。"}可以改用下面的妙记导入。
            </p>
          ) : (
            <p className={s.entryBody}>录音正在转成文字，转完会自动弹出「确认每位说话人是谁」。一小时的会大约要几分钟。</p>
          )}
        </section>
      ) : null}
      <section className={s.reviewSection}>
        <header>
          <h3>导入会议记录</h3>
        </header>
        <p className={s.entryBody}>
          会后导入飞书妙记 Markdown（.md），确认说话人对应的人之后生成会后复核；也可以导入 warmap-transcript.v1 JSON。任一条不合规则整份拒绝，不保存部分发言。
        </p>
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
            <section className={s.reviewSection}>
              <header>
                <h3>会议纪要</h3>
              </header>
              <p className={s.entryBody}>{payload.outcome.summary || "抽取尚未产出摘要。"}</p>
            </section>
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
            {minutes.decisions.length ? (
              <section className={s.reviewSection}>
                <header>
                  <h3>会议共识</h3>
                  <span className={s.count}>{minutes.decisions.length} 条</span>
                </header>
                {minutes.decisions.map(renderItem)}
              </section>
            ) : null}
            {minutes.actions.length ? (
              <section className={s.reviewSection}>
                <header>
                  <h3>Action Item</h3>
                  <span className={s.count}>{minutes.actions.reduce((sum, group) => sum + group.items.length, 0)} 条 · 已推到负责人的执行事项</span>
                </header>
                {minutes.actions.map((group) => (
                  <div key={group.ownerId} className={s.ownerGroup}>
                    <h4>{people.get(group.ownerId) ?? group.ownerId}</h4>
                    {group.items.map(renderItem)}
                  </div>
                ))}
              </section>
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
          <p className={s.empty}>Transcript 已保存，会后抽取尚未开始。</p>
        )}
        <section className={s.reviewSection}>
          <header>
            <h3>Transcript</h3>
          </header>
          <p className={s.entryBody}>
            {payload.transcript ? `${payload.transcript.turns.length} 条发言已保存 · warmap-transcript.v1` : "尚未导入 Transcript"}
          </p>
          <p className={s.publishReceipt}>会后复核只以 Transcript 为输入；会前材料在材料页签里只读查看。</p>
        </section>
        {actionOf("meeting.replace_transcript") ? (
          <section className={`${s.reviewSection} ${s.dangerSection}`}>
            <header>
              <h3>替换 Transcript · 危险操作</h3>
            </header>
            <p className={s.warnings}>替换会整体使旧 Outcome candidate 与 actionId 失效并重跑抽取；只有没有任何 confirmed effect 时才允许。</p>
            <input ref={replaceRef} type="file" accept="application/json,.json" aria-label="选择替换用的 Transcript 文件" />
            <label className={s.summaryEdit}>
              <input type="checkbox" checked={replaceArmed} onChange={(event) => setReplaceArmed(event.target.checked)} />
              我确认整份替换当前 Transcript
            </label>
            <div className={s.stageActions}>
              <button type="button" disabled={pending || !replaceArmed} onClick={() => void replaceTranscript()}>
                替换 Transcript
              </button>
            </div>
            {uploadError ? <p className={s.error} role="alert">{uploadError}</p> : null}
          </section>
        ) : null}
      </section>
    );

  const recordTab = memberReadOnly ? { ...RECORD_TAB, title: "会议记录：已确认的决定与待办" } : RECORD_TAB;
  const showing = view.current === RECORD_TAB.id ? recordTab : viewedMaterial ? materialTab(viewedMaterial) : PREFLIGHT_TAB;

  return (
    <section className={s.workspace} data-testid="meeting-workspace" data-status={payload.status}>
      {confirmDialog}
      <DetailFrame
        headingId="meeting-title"
        title={card.title}
        onBack={() => onNavigate("/")}
        actions={
          <MeetingHeaderActions day={meetingDayWord(payload.scheduledAt)} slot={meetingSlot(payload.scheduledAt, payload.endsAt)} clock={clock}>
            <HeaderMaterialToggle tab={recordTab} selected={view.current === RECORD_TAB.id} onToggle={() => setView((current) => toggleWhole(current, RECORD_TAB.id))} />
          </MeetingHeaderActions>
        }
      >
        <div className={s.reading}>
          <div className={s.pane}>
            <ObjectMaterialArea objectType="meeting" objectId={card.objectRef.id} baseTabs={tabs} groupTab={GROUP_MATERIAL_TAB}
              selected={view.current} selectedTab={view.current === RECORD_TAB.id ? null : view.current}
              onSelect={(id) => setView((current) => pressMaterial(current, id))}>
            <MeetingStatus phase={phase} facts={facts} now={statusNow} endedAt={payload.endedAt} />
            {(memberReadOnly ? payload.purpose : payload.preflight.taskDefinition?.reviewPurpose) ?
              <p className={s.agenda}>{memberReadOnly ? payload.purpose : payload.preflight.taskDefinition?.reviewPurpose}</p> : null}
            <section className={s.material} aria-label={showing.title}>
              {view.current === RECORD_TAB.id ? (
                recordView
              ) : viewedMaterial ? (
                <MaterialPane meetingId={card.objectRef.id} material={viewedMaterial} preview={preview} provenance={provenance(viewedMaterial)} />
              ) : (
                <>
                  {preflightToolbar}
                  {preflightView}
                </>
              )}
            </section>
            </ObjectMaterialArea>
            <ActionFeedback state={state} onRetry={retry} />
          </div>
        </div>
      </DetailFrame>
      {!memberReadOnly && payload.transcriptCandidate && candidateOpen ? (
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
