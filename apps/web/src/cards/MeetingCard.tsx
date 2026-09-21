"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, FileUp, Files, RefreshCw, X } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import { groupPreflight, pickActiveSection } from "./preflightOutline";
import { ConversationDock } from "@/conversation/ConversationDock";
import s from "@/styles/meeting-workspace.module.css";


const ITEM_LABEL: Record<string, string> = {
  decision: "决定",
  todo: "普通待办",
  ceoJudgment: "CEO 判断",
  reopenWhen: "复议条件",
  open: "未收敛事项",
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

/** 状态行（tp8t9 Header Meta）：状态 · 材料口径 · 份数 · 最近更新。 */
export function materialStateLine(
  status: "scheduled" | "held" | "reviewed" | "cancelled",
  readiness: string | undefined,
  materials: MaterialMeta[],
): string {
  const latest = materials.map((material) => material.uploadedAt).sort().at(-1);
  const phase =
    status === "scheduled"
      ? `会前预审 · ${readiness === "ready" ? "已就绪 · 材料只读" : readiness === "revise" ? "修改后提交 · 材料可替换" : "待预审"}`
      : status === "cancelled"
        ? "已取消 · 材料只读"
        : "Outcome 复核 · 材料已归档只读";
  return `${phase} · ${materials.length} 份${latest ? ` · 最近更新 ${latest.slice(0, 10)}` : ""}`;
}

export type MaterialPreview =
  | { state: "idle" | "loading" }
  | { state: "ready"; kind: "pdf"; url: string }
  | { state: "ready"; kind: "html" | "text"; content: string }
  | { state: "error"; error: string };

const MATERIAL_ACCEPT = "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md";

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

const MATERIAL_DIALOG_NOTE = "只读依据 · 不参与判断与抽取，原始材料不会自动改写预审结论";

/** pen Flow Stage Bar：四步固定；状态机映射到激活步（cancelled 无激活步）。 */
export const STAGE_STEPS = ["新增会议", "会前预审", "会议进行", "Outcome 复核"] as const;

export function activeStageIndex(status: "scheduled" | "held" | "reviewed" | "cancelled"): number {
  if (status === "scheduled") return 1;
  if (status === "cancelled") return -1;
  return 3;
}

/** 四步流程条：完成步绿勾、激活步 #E8F1FF/#007AFF、未到步灰；右侧状态行用真实材料/预审事实。 */
function StageBar({ status, statusLine }: { status: "scheduled" | "held" | "reviewed" | "cancelled"; statusLine: string }) {
  const active = activeStageIndex(status);
  return (
    <div className={s.stageRow}>
      <div className={s.stageBar} aria-label="会议阶段">
        <ol className={s.stageSteps}>
          {STAGE_STEPS.map((label, index) => (
            <li key={label} className={s.stageStep} data-state={index < active ? "done" : index === active ? "active" : "idle"}>
              {index < active ? <Check size={13} aria-hidden="true" /> : <span className={s.stageNo}>{String(index + 1).padStart(2, "0")}</span>}
              <span>{label}</span>
              {index < STAGE_STEPS.length - 1 ? <ChevronRight size={14} aria-hidden="true" className={s.stageSep} /> : null}
            </li>
          ))}
        </ol>
        <span className={s.stageStatus}>{statusLine}</span>
      </div>
    </div>
  );
}

/** 原始材料只读弹窗：列表 + 预览（PDF iframe / DOCX 清洗 HTML / MD 纯文本）+ 下载；任何状态都不含编辑。 */
export function MaterialReaderModal({
  dialogRef,
  meetingId,
  materials,
  selectedId,
  preview,
  stateLine,
  transcriptMeta,
  supplementRequests,
  note,
  onClose,
  onSelect,
}: {
  dialogRef: { current: HTMLDialogElement | null };
  meetingId: string;
  materials: MaterialMeta[];
  selectedId: string | null;
  preview: MaterialPreview;
  stateLine: string;
  /** Outcome 只读上下文：逐字稿没有预览/下载端点，作为静态条目展示。 */
  transcriptMeta: { count: number; schemaVersion: string } | null;
  /** 补充材料出处：supplementFor → 请求文本；读者只看到归档事实。 */
  supplementRequests?: { id: string; text: string }[];
  note: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const selected = materials.find((material) => material.id === selectedId) ?? null;
  const { primary, supplements } = splitMaterials(materials);
  const provenance = (material: MaterialMeta) => {
    const request = supplementRequests?.find((item) => item.id === material.supplementFor);
    return request ? ` · 回应「${truncateText(request.text, 24)}」` : "";
  };
  const readerItem = (material: MaterialMeta, supplement = false) => (
    <div key={material.id} className={s.readerItem} data-active={material.id === selectedId}>
      <button
        type="button"
        className={s.readerSelect}
        aria-current={material.id === selectedId ? "true" : undefined}
        onClick={() => onSelect(material.id)}
      >
        <span className={s.readerBadge}>{MIME_BADGE[material.mimeType] ?? "文件"}</span>
        <span className={s.readerName}>{material.fileName}</span>
        <small>{materialMeta(material)}{supplement ? provenance(material) : ""}</small>
      </button>
      <a
        className={s.readerDownload}
        href={`/api/meetings/${meetingId}/materials/${material.id}/download`}
        aria-label={`下载 ${material.fileName}`}
      >
        下载
      </a>
    </div>
  );
  return (
    <dialog ref={dialogRef} className={s.materialReader} aria-label="会议原始材料">
      <header className={s.readerHeader}>
        <div>
          <h2>会议原始材料</h2>
          <p className={s.readerStateLine}>{stateLine}</p>
          <p>{MATERIAL_DIALOG_NOTE}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭原始材料">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className={s.readerBody}>
        <nav className={s.readerList} aria-label="材料列表">
          <details className={s.readerGroup} open>
            <summary>
              会前材料
              <span>{primary.length} 份</span>
            </summary>
            {primary.map((material) => readerItem(material))}
          </details>
          {supplements.length ? (
            <details className={s.readerGroup} open>
              <summary>
                补充材料
                <span>{supplements.length} 份</span>
              </summary>
              {supplements.map((material) => readerItem(material, true))}
            </details>
          ) : null}
          {transcriptMeta ? (
            <details className={s.readerGroup} open>
              <summary>
                会议逐字稿
                <span>1 份</span>
              </summary>
              <div className={s.readerItem} data-static="true">
                <span className={s.readerBadge}>JSON</span>
                <span className={s.readerName}>会议逐字稿（{transcriptMeta.schemaVersion}）</span>
                <small>{transcriptMeta.count} 条发言 · 会后采集 · 仅页面内查看，无独立下载</small>
              </div>
            </details>
          ) : null}
        </nav>
        <div className={s.readerPane} aria-live="polite">
          {preview.state === "loading" || preview.state === "idle" ? <p className={s.empty}>预览加载中…</p> : null}
          {preview.state === "error" ? <p className={s.error} role="alert">{preview.error}</p> : null}
          {preview.state === "ready" && preview.kind === "pdf" ? (
            <iframe className={s.readerFrame} src={preview.url} title={selected ? `${selected.fileName} 预览` : "材料预览"} />
          ) : null}
          {preview.state === "ready" && preview.kind === "html" ? (
            <iframe
              className={s.readerFrame}
              sandbox=""
              title={selected ? `${selected.fileName} 预览` : "材料预览"}
              srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.8 -apple-system,system-ui,sans-serif;color:#282c32;padding:18px;max-width:44em;margin:0 auto}</style>${preview.content}`}
            />
          ) : null}
          {preview.state === "ready" && preview.kind === "text" ? <pre className={s.readerText}>{preview.content}</pre> : null}
          {preview.state === "ready" && selected ? (
            <p className={s.readerPaneFoot}>
              {selected.fileName} · {materialMeta(selected)}
              <a href={`/api/meetings/${meetingId}/materials/${selected.id}/download`}>下载原件</a>
            </p>
          ) : null}
        </div>
      </div>
      <footer className={s.readerFooter}>
        <p>{note}</p>
      </footer>
    </dialog>
  );
}

/** Meeting 页面：会前预审、Transcript 导入/替换与 MeetingOutcome 逐项确认都在这里。 */
export function MeetingCard({ card, collection, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<MeetingPayload>(card);
  const { state, run, retry, pending } = useCardAction(onCard);
  const [note, setNote] = useState(payload.draft.note);
  const [supplementText, setSupplementText] = useState("");
  const [supplementEntry, setSupplementEntry] = useState("");
  const [supplementTarget, setSupplementTarget] = useState(payload.leadDriId);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // 补充材料：仅 scheduled 分支渲染入口；状态只存内存，成功后由后端返回的新 Card 驱动。
  const [supplementBusyId, setSupplementBusyId] = useState<string | null>(null);
  const [supplementError, setSupplementError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("core");
  // 原始材料只读弹窗：选择 + 预览取自 preview endpoint；不在弹窗内提供任何编辑。
  const [readerOpen, setReaderOpen] = useState(false);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MaterialPreview>({ state: "idle" });
  const readerDialog = useRef<HTMLDialogElement>(null);
  const readerCloseRef = useRef<HTMLButtonElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const materialRef = useRef<HTMLInputElement>(null);

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const itemAction = (type: string, itemId: string) =>
    actions.find((action) => action.actionType === type && action.itemId === itemId);

  const issues = collection.filter((item) => item.kind === "issue");
  const issueById = new Map(issues.map((item) => [item.objectRef.id, item]));
  const people = new Map(payload.participants.map((person) => [person.personId, person.displayName]));
  const dri = payload.participants.filter((person) => person.roles.includes("dri"));

  function openMaterialReader() {
    setReaderOpen(true);
    setSelectedMaterialId((current) => current ?? payload.materials[0]?.id ?? null);
    requestAnimationFrame(() => readerCloseRef.current?.focus({ preventScroll: true }));
  }

  function closeMaterialReader() {
    setReaderOpen(false);
    setSelectedMaterialId(null);
    setPreview({ state: "idle" });
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  useEffect(() => {
    if (!readerOpen) return;
    const dialog = readerDialog.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Escape 的原生 close 也要同步 React 状态并回收 object URL。
    dialog.addEventListener("close", closeMaterialReader);
    return () => {
      dialog.removeEventListener("close", closeMaterialReader);
      if (dialog.open) dialog.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerOpen]);

  useEffect(() => {
    if (!readerOpen || !selectedMaterialId) return;
    const controller = new AbortController();
    setPreview({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/meetings/${card.objectRef.id}/materials/${selectedMaterialId}/preview`, {
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
  }, [readerOpen, selectedMaterialId, card.objectRef.id]);

  function toggle(field: "readIssueIds" | "checkedEntryIds" | "carriedIssueIds", id: string) {
    const current = payload.draft[field];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    const action = actionOf("meeting.update_draft");
    if (action) void run(action, { [field]: next });
  }

  /** 首次导入：multipart 单文件；与 DRI service API 共用同一校验边界。 */
  async function uploadTranscript() {
    const file = uploadRef.current?.files?.[0];
    if (!file) {
      setUploadError("请先选择 warmap-transcript.v1 JSON 文件。");
      return;
    }
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

  async function replaceMaterials() {
    const files = materialRef.current?.files;
    if (!files?.length) {
      setUploadError("请先选择至少一份会前材料；空选择不会替换现有材料。");
      return;
    }
    if (payload.materials.length && !window.confirm("替换会清空当前材料集、补充材料与预审候选。是否继续？")) return;
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
  /** pen 把一号位点评从正文目录移进左侧 amber 参考盒，正文目录因此只剩其余六段。 */
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

  /** 评审目录 scroll-spy：以正文滚动容器顶部为基准，取最后一个越过分界线的章节。 */
  useEffect(() => {
    const main = mainRef.current;
    if (!main || payload.status !== "scheduled" || !payload.preflight.taskDefinition) return;
    const sync = () => {
      const boundary = main.getBoundingClientRect().top + 96;
      const sections = [...main.querySelectorAll<HTMLElement>("[data-section]")].map((section) => ({
        key: section.dataset.section ?? "",
        top: section.getBoundingClientRect().top,
      }));
      setActiveSection(pickActiveSection(sections, boundary));
    };
    sync();
    main.addEventListener("scroll", sync, { passive: true });
    return () => main.removeEventListener("scroll", sync);
  }, [payload.status, payload.preflight.taskDefinition]);

  function jump(kind: string) {
    const target = mainRef.current?.querySelector<HTMLElement>(`[data-section="${kind}"]`);
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  /* Header 右侧 Secondary Seg Group：只摆真实可用的动作，段间 1×18 分隔。 */
  const segments: { key: string; node: ReactNode }[] = [];
  if (payload.status === "scheduled" && actionOf("meeting.edit_materials")) {
    segments.push({
      key: "edit",
      node: (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (window.confirm("返回编辑会使当前预审候选失效。是否继续？")) void run(actionOf("meeting.edit_materials")!, {});
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          返回编辑材料
        </button>
      ),
    });
  }
  if (payload.materials.length) {
    segments.push({
      key: "reader",
      node: (
        <button type="button" onClick={openMaterialReader}>
          <Files size={13} aria-hidden="true" />
          查看原始材料
        </button>
      ),
    });
  }
  if (payload.status === "scheduled" && actionOf("meeting.regenerate_preflight")) {
    segments.push({
      key: "regen",
      node: (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (window.confirm("重新预审会替换当前条目，并清除旧条目的核对和编辑状态。是否继续？")) {
              void run(actionOf("meeting.regenerate_preflight")!, {});
            }
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {pending ? "预审中…" : "重新预审"}
        </button>
      ),
    });
  }

  const stageLine = materialStateLine(payload.status, payload.preflight.readiness, payload.materials);

  /* pen Signals & Risks Row：积极信号与潜在风险两卡并排；其余章节整宽。 */
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
          </article>
        );
      })}
    </section>
  );

  return (
    <section className={s.workspace} data-testid="meeting-workspace" aria-labelledby="meeting-title">
      <header className={s.header}>
        <div className={s.headerTitle}>
          <span>
            {payload.status === "scheduled" ? "会前预审" : payload.status === "cancelled" ? "已取消" : "Outcome 复核"} ·{" "}
            {payload.scheduledAt.slice(0, 16).replace("T", " ")} · 主责 DRI {people.get(payload.leadDriId) ?? payload.leadDriId} ·{" "}
            {payload.participants.length} 人参会
          </span>
          <h1 id="meeting-title">{card.title}</h1>
        </div>
        <div className={s.headerRight}>
          {segments.length ? (
            <div className={s.segGroup}>
              {segments.map((segment, index) => (
                <span key={segment.key} className={s.segItem}>
                  {index > 0 ? <span className={s.segDivider} aria-hidden="true" /> : null}
                  {segment.node}
                </span>
              ))}
            </div>
          ) : null}
          {payload.status === "scheduled" ? (
            <>
              <input
                ref={uploadRef}
                type="file"
                accept="application/json,.json"
                className={s.hiddenInput}
                aria-label="选择 Transcript 文件"
                onChange={(event) => {
                  if (event.target.files?.length) void uploadTranscript();
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className={s.primaryAction}
                disabled={uploading}
                onClick={() => uploadRef.current?.click()}
              >
                <FileUp size={13} aria-hidden="true" />
                {uploading ? "上传中…" : "上传会议逐字稿 · 进入复盘"}
              </button>
            </>
          ) : null}
          <button type="button" className={s.close} onClick={() => onNavigate("/")} aria-label="返回首页">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>
      <StageBar status={payload.status} statusLine={stageLine} />

      <div className={s.materials}>
        {payload.status === "scheduled" ? (
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
                        <small>{issue ? (issue.payload as IssuePayload).location.level : "Issue"}</small>
                        <h4 title={issue?.title ?? issueId}>{issue?.title ?? issueId}</h4>
                        <div className={s.briefActions}>
                          <button type="button" aria-pressed={read} disabled={pending} onClick={() => toggle("readIssueIds", issueId)}>
                            <Check size={12} aria-hidden="true" />
                            已阅
                          </button>
                          <button type="button" aria-pressed={carried} disabled={pending} onClick={() => toggle("carriedIssueIds", issueId)}>
                            带到会议
                          </button>
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
                    <button
                      key={group.key}
                      type="button"
                      data-active={activeSection === group.key}
                      onClick={() => jump(group.key)}
                    >
                      <span>{group.shortLabel}</span>
                      <em>
                        {group.entries.filter((entry) => payload.draft.checkedEntryIds.includes(entry.id)).length}/
                        {group.entries.length}
                      </em>
                    </button>
                  ))}
                </nav>
              ) : null}
            </aside>

            <main className={s.advisorMain} ref={mainRef}>
              {uploadError ? <p className={s.error} role="alert">{uploadError}</p> : null}
              {payload.preflight.status === "pending" && !actionOf("meeting.edit_materials") ? (
                /* scheduled 未预审：材料编辑卡（白卡，按钮 13px/9 14/r10）。预审完成后材料入口在 Header。 */
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
                  <input ref={materialRef} type="file" multiple accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md" aria-label="选择会前材料" />
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
              <p className={s.error} role="alert">
                {payload.preflight.error.code}：{payload.preflight.error.message}
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
                <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.update_draft")!, { note })}>
                  保存准备状态
                </button>
                <label className={s.summaryEdit}>
                  <input type="checkbox" checked={cancelArmed} onChange={(event) => setCancelArmed(event.target.checked)} /> 我确认取消这场尚未召开的会议
                </label>
                <button type="button" disabled={pending || !cancelArmed} onClick={() => void run(actionOf("meeting.cancel")!, {})}>
                  取消会议
                </button>
              </div>
            </div>

              <p className={s.publishReceipt}>上传逐字稿（warmap-transcript.v1）在右上角；任一条不合规则整份拒绝，不保存部分 turns。</p>
              <ActionFeedback state={state} onRetry={retry} />
            </main>

            <ConversationDock
              scope={card.conversation?.scope ?? `meeting:${card.objectRef.id}`}
              label={card.title}
              availableCards={collection}
              variant="sidebar"
              sidebar={{ title: "会前对话 · 本场会议", tone: "light", open: true, placeholder: "问点什么…" }}
            />
          </section>
        ) : (
          <section className={s.review}>
            <div className={s.reviewColumn}>
              {payload.outcome ? (
                <>
                  <section className={s.reviewSection}>
                    <header>
                      <h3>会后抽取摘要</h3>
                    </header>
                    <p className={s.entryBody}>{payload.outcome.summary || "抽取尚未产出摘要。"}</p>
                  </section>
                  {payload.outcome.error ? (
                    <p className={s.error} role="alert">
                      {payload.outcome.error.code}：{payload.outcome.error.message}
                      {actionOf("meeting.retry_outcome") ? (
                        <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_outcome")!, {})}>
                          重试会后抽取
                        </button>
                      ) : null}
                    </p>
                  ) : null}
                  <section className={s.reviewSection}>
                    <header>
                      <h3>逐项处理</h3>
                      <span className={s.count}>{payload.outcome.items.length} 条</span>
                    </header>
                    {payload.outcome.items.map((item) => {
                      const itemState =
                        item.review?.status === "confirmed"
                          ? "confirmed"
                          : item.review?.status === "dismissed"
                            ? "dismissed"
                            : item.kind === "open"
                              ? "open"
                              : "pending";
                      return (
                        <article key={item.id} className={s.decisionRecord} data-kind={item.kind}>
                          <div className={s.itemHead}>
                            <span className={s.kindBadge}>{ITEM_LABEL[item.kind] ?? item.kind}</span>
                            <p className={s.itemText}>{item.text}</p>
                          </div>
                          <blockquote className={s.itemQuote}>
                            <p>{item.quote}</p>
                          </blockquote>
                          <div className={s.itemMeta}>
                            <div className={s.itemMetaLeft}>
                              <span>{people.get(item.speakerId) ?? item.speakerId}</span>
                              <span className={s.itemState} data-state={itemState}>
                                {itemState === "confirmed"
                                  ? `已确认${item.review?.handoff ? ` · ${EXPORT_LABEL[item.review.handoff.exportStatus] ?? item.review.handoff.exportStatus}` : ""}`
                                  : itemState === "dismissed"
                                    ? "已忽略"
                                    : itemState === "open"
                                      ? "仅展示，不产生效果"
                                      : "待处理"}
                              </span>
                            </div>
                            <div className={s.itemActions}>
                              {itemAction("meeting.confirm_item", item.id) ? (
                                <button
                                  type="button"
                                  data-variant="confirm"
                                  disabled={pending}
                                  onClick={() => void run(itemAction("meeting.confirm_item", item.id)!, {})}
                                >
                                  确认
                                </button>
                              ) : null}
                              {itemAction("meeting.dismiss_item", item.id) ? (
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => void run(itemAction("meeting.dismiss_item", item.id)!, {})}
                                >
                                  忽略
                                </button>
                              ) : null}
                              {itemAction("meeting.revoke_effect", item.id) ? (
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => void run(itemAction("meeting.revoke_effect", item.id)!, {})}
                                >
                                  撤回
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </section>
                </>
              ) : (
                <p className={s.empty}>Transcript 已保存，会后抽取尚未开始。</p>
              )}
              <ActionFeedback state={state} onRetry={retry} />
            </div>

            <div className={s.reviewColumn}>
              <section className={s.reviewSection}>
                <header>
                  <h3>原始会前材料</h3>
                  <span>
                    {payload.materials.length} 份
                    {payload.materials.length ? (
                      <button type="button" className={s.readerOpen} onClick={openMaterialReader}>查看原始材料</button>
                    ) : null}
                  </span>
                </header>
                {payload.materials.map((material) => <p key={material.id} className={s.entryBody}><a href={`/api/meetings/${card.objectRef.id}/materials/${material.id}/download`}>{material.fileName}</a></p>)}
                <p className={s.publishReceipt}>材料仅供查看；Outcome 只以 Transcript 为输入。</p>
              </section>
              <section className={s.reviewSection}>
                <header>
                  <h3>Transcript</h3>
                </header>
                <p className={s.entryBody}>
                  {payload.transcript ? `${payload.transcript.turns.length} 条发言已保存 · warmap-transcript.v1` : "尚未导入 Transcript"}
                </p>
              </section>

              {actionOf("meeting.replace_transcript") ? (
                <section className={`${s.reviewSection} ${s.dangerSection}`}>
                  <header>
                    <h3>替换 Transcript · 危险操作</h3>
                  </header>
                  <p className={s.warnings}>
                    替换会整体使旧 Outcome candidate 与 actionId 失效并重跑抽取；只有没有任何 confirmed effect 时才允许。
                  </p>
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
                </section>
              ) : null}
            </div>

            <ConversationDock
              scope={card.conversation?.scope ?? `meeting:${card.objectRef.id}`}
              label={card.title}
              availableCards={collection}
              variant="sidebar"
              sidebar={{ title: "会议材料对话", tone: "light", open: true, placeholder: "问点什么…" }}
            />
          </section>
        )}

        <p className={s.publishReceipt}>
          参与人：{payload.participants.map((person) => person.displayName).join("、")} · 关联 Issue {payload.issueIds.length} 个
        </p>
        {readerOpen ? (
          <MaterialReaderModal
            dialogRef={readerDialog}
            meetingId={card.objectRef.id}
            materials={payload.materials}
            selectedId={selectedMaterialId}
            preview={preview}
            stateLine={materialStateLine(payload.status, payload.preflight.readiness, payload.materials)}
            supplementRequests={payload.draft.supplementRequests}
            transcriptMeta={
              payload.status !== "scheduled" && payload.transcript
                ? { count: payload.transcript.turns.length, schemaVersion: payload.transcript.schemaVersion }
                : null
            }
            note={
              payload.status === "scheduled"
                ? payload.preflight.status === "ready"
                  ? "材料集当前只读；替换需先「返回编辑材料」，替换后旧预审结论失效。"
                  : "替换材料集请使用「会前材料」区的上传控件；替换后旧预审结论失效。"
                : "Outcome 只以 Transcript 为输入；材料仅供查看。"
            }
            onClose={closeMaterialReader}
            onSelect={(id) => setSelectedMaterialId(id)}
          />
        ) : null}
      </div>
    </section>
  );
}
