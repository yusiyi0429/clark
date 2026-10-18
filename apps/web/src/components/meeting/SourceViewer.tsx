"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Markdown from "react-markdown";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { ArrowUpRight, CornerUpLeft, Download, MessageSquareQuote, X } from "lucide-react";
import type { TDecisionHistoryChange } from "@warmap/contracts";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { monthDayTime } from "@/lib/companyTime";
import { MaterialPane, useMaterialPreview } from "./meetingMaterialPreview";
import { briefFlash, flashElement, readingScroller, revealElement, scrollToElement } from "./readingScroll";
import { registerPageCitations } from "@/conversation/citationBridge";
import {
  clip,
  emptySourceContext,
  parseSourceRef,
  sourceLabel,
  sourceTarget,
  type HistoryHit,
  type LegacyMaterial,
  type SourceContext,
  type SourceMaterial,
  type SourceTarget,
} from "@/cards/meetingSources";
import d from "@/styles/decision-workspace.module.css";
import { knowledgeName } from "@/lib/displayText";

/**
 * 依据直达（feedback 14 / H07）：页面里每一个来源都是一颗按钮。
 * - 同一页里的历史决定、执行变化、会后条目：滚过去并闪一下，右下角出现「回到刚才的位置」；
 * - 群材料（按引用时那一版、那一段）、旧会前材料、群讨论、企业知识等：在侧边「依据」抽屉里打开，关上就回到原处，
 *   正文的滚动位置不动；
 * - 外部信号、别的会议、别的议题：跳过去，返回时由页面恢复到原议题。
 * 没有可读正文的来源（PDF 原件、链接）写明限制并给下载 / 打开，不假装有预览。
 */

export type SourceObject = { objectType: "meeting" | "issue"; objectId: string };

export type SourceNavigatorApi = {
  context: SourceContext;
  /** flash: "brief"——从对话里的来源点过来（深度讨论 v2）：页内定位只短暂高亮约 1.2s。 */
  open: (ref: string, options?: { issueId?: string | null; trigger?: HTMLElement | null; flash?: "brief" }) => void;
};

const NavigatorContext = createContext<SourceNavigatorApi | null>(null);
export const SourceNavigatorProvider = NavigatorContext.Provider;
export const useSourceNavigatorApi = () => useContext(NavigatorContext);

type DrawerTarget = Extract<SourceTarget, { type: "material" | "legacy-material" | "discussion" | "detail" }>;
type DrawerState = { target: DrawerTarget; issueId: string | null; ref: string; trigger: HTMLElement | null };

export function useSourceNavigator({ context, rootRef, onNavigate, onShowRecord, objects, meetingId, beforeLeave, register = true }: {
  context: SourceContext;
  /** 页面根（会议 / 议题工作区）：锚点在它里面找，抽屉也挂在它里面。 */
  rootRef: RefObject<HTMLElement | null>;
  onNavigate: (href: string, origin?: Element | null) => void;
  onShowRecord?: () => void;
  /** 材料与群讨论可能属于的对象（当前会议、关联议题、相关会议），按顺序查找。 */
  objects: SourceObject[];
  /** 会前材料（旧材料）所在的会议。 */
  meetingId?: string | null;
  /** 跳到别的页面之前：记下现在读到的议题和位置，回来时恢复。 */
  beforeLeave?: () => void;
  /** 登记给对话（conversation/citationBridge）：深度讨论里点回答的来源，交给这一页定位或打开。外壳自己的依据面板不登记。 */
  register?: boolean;
}): { api: SourceNavigatorApi; overlay: ReactNode } {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  /** 定位前的滚动位置和那个滚动容器（.ts-detail）：「回到刚才的位置」用。 */
  const [returnTo, setReturnTo] = useState<{ scroller: HTMLElement; top: number } | null>(null);

  const dispatch = useCallback((target: SourceTarget, ref: string, issueId: string | null, trigger: HTMLElement | null, flash?: "brief") => {
    switch (target.type) {
      case "anchor": {
        const element = rootRef.current?.querySelector<HTMLElement>(`#${CSS.escape(target.anchorId)}`) ?? null;
        if (!element) {
          if (target.fallback) dispatch(target.fallback, ref, issueId, trigger, flash);
          return;
        }
        revealElement(element);
        const scroller = readingScroller(element);
        const before = scrollToElement(element);
        if (scroller && before !== null) setReturnTo({ scroller, top: before });
        if (flash === "brief") briefFlash(element);
        else flashElement(element);
        return;
      }
      case "route":
        beforeLeave?.();
        onNavigate(target.href, trigger);
        return;
      case "record":
        onShowRecord?.();
        return;
      case "none":
        return;
      default:
        setDrawer({ target, issueId, ref, trigger });
    }
  }, [beforeLeave, onNavigate, onShowRecord, rootRef]);

  const open = useCallback((ref: string, options: { issueId?: string | null; trigger?: HTMLElement | null; flash?: "brief" } = {}) => {
    dispatch(sourceTarget(ref, context, options.issueId), ref, options.issueId ?? null, options.trigger ?? null, options.flash);
  }, [context, dispatch]);

  const api = useMemo(() => ({ context, open }), [context, open]);
  // 登记给对话：登记一次，取最新的 context / open（ref 里放最新值，不随每次渲染注销重登）。
  const latest = useRef(api);
  latest.current = api;
  useEffect(() => {
    if (!register) return;
    return registerPageCitations({
      get context() { return latest.current.context; },
      root: () => rootRef.current,
      open: (ref, options) => latest.current.open(ref, options),
    });
  }, [register, rootRef]);

  const close = useCallback(() => {
    const trigger = drawer?.trigger;
    setDrawer(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [drawer]);

  const goBack = useCallback(() => {
    if (returnTo?.scroller.isConnected !== false) returnTo?.scroller.scrollTo({ top: returnTo.top });
    setReturnTo(null);
  }, [returnTo]);

  const overlay = (
    <>
      {drawer ? <SourceDrawer key={`${drawer.ref}|${drawer.issueId ?? ""}`} state={drawer} context={context} objects={objects} meetingId={meetingId ?? null}
        onClose={close} onOpen={(ref) => open(ref, { issueId: drawer.issueId, trigger: drawer.trigger })} /> : null}
      {returnTo && !drawer ? (
        <div className={d.returnChip} role="group" aria-label="定位到依据后">
          <button type="button" onClick={goBack}>
            <CornerUpLeft size={14} aria-hidden="true" />
            回到刚才的位置
          </button>
          <button type="button" className={d.returnDismiss} aria-label="不返回原位置" onClick={() => setReturnTo(null)}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
  return { api, overlay };
}

/** 一条依据：可以打开的是按钮，当前会议本身只是文字。 */
export function SourceChip({ sourceRef, issueId }: { sourceRef: string; issueId?: string | null }) {
  const navigator = useSourceNavigatorApi();
  if (!navigator) return <span className={d.sourceStatic} data-source-ref={sourceRef}>{sourceLabel(sourceRef, emptySourceContext(), issueId)}</span>;
  const label = sourceLabel(sourceRef, navigator.context, issueId);
  const target = sourceTarget(sourceRef, navigator.context, issueId);
  if (target.type === "none") return <span className={d.sourceStatic} data-source-ref={sourceRef}>{label}</span>;
  return (
    <button type="button" className={d.sourceChip} data-source-ref={sourceRef} data-source-kind={parseSourceRef(sourceRef).kind}
      title={target.type === "route" ? `打开对应页面：${label}` : `打开依据：${label}`}
      onClick={(event) => navigator.open(sourceRef, { issueId, trigger: event.currentTarget })}>
      {label}
      {target.type === "route" ? <ArrowUpRight size={11} aria-hidden="true" /> : null}
    </button>
  );
}

/** 依据一行：「依据」两个字后面一串按钮；去重，最多 10 条。 */
export function SourceList({ refs, issueId, label = "依据" }: { refs: string[]; issueId?: string | null; label?: string }) {
  const unique = [...new Set(refs)].slice(0, 10);
  if (!unique.length) return null;
  return (
    <div className={d.sourceRow}>
      <small>{label}</small>
      {unique.map((ref) => <SourceChip key={ref} sourceRef={ref} issueId={issueId} />)}
    </div>
  );
}

const KIND_TITLE: Record<DrawerTarget["type"], string> = {
  material: "群材料",
  "legacy-material": "会前材料",
  discussion: "群讨论",
  detail: "依据",
};

function SourceDrawer({ state, context, objects, meetingId, onClose, onOpen }: {
  state: DrawerState;
  context: SourceContext;
  objects: SourceObject[];
  meetingId: string | null;
  onClose: () => void;
  onOpen: (ref: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const label = sourceLabel(state.ref, context, state.issueId);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    // Escape 只关抽屉：标记已处理，外壳（C-06）就不会接着关掉整页。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const { target } = state;
  return (
    <aside className={d.drawer} role="dialog" aria-modal="false" aria-label={`依据：${label}`} data-source-drawer>
      <header className={d.drawerHead}>
        <div>
          <small>{target.type === "detail" ? detailKind(target) : KIND_TITLE[target.type]}</small>
          <h2>{label}</h2>
        </div>
        <button ref={closeRef} type="button" className={d.drawerClose} onClick={onClose} aria-label="关闭依据，回到议题">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {target.type === "material" ? <MaterialSource target={target} objects={objects} label={label} />
        : target.type === "legacy-material" && meetingId ? <LegacySource meetingId={meetingId} material={target.material} />
          : target.type === "discussion" ? <DiscussionSource target={target} objects={objects} label={label} />
            : target.type === "detail" ? <DetailSource target={target} label={label} onOpen={onOpen} />
              : <div className={d.drawerBody}><p className={d.muted}>这条依据暂时无法打开。</p></div>}
    </aside>
  );
}

function detailKind(target: Extract<SourceTarget, { type: "detail" }>): string {
  switch (target.parsed.kind) {
    case "decision": return "历史决定";
    case "fact": return "执行事实";
    case "feedback": return "阶段反馈";
    case "memory": return "企业知识";
    default: return "依据";
  }
}

/** 追问这段：把原文作为引用放进当前对象的对话，不改输入框里已有的话。 */
function QuoteButton({ text, label }: { text: string; label: string }) {
  const { quote } = useWorkspace();
  if (!text.trim()) return null;
  return (
    <button type="button" className={d.drawerAction} onClick={() => quote(text, { label })}>
      <MessageSquareQuote size={14} aria-hidden="true" />
      在对话里追问
    </button>
  );
}

type MaterialText = {
  materialId: string;
  fileName: string;
  format: "markdown" | "html" | "pdf" | "docx" | "link";
  version: number;
  currentVersion: number;
  readable: boolean;
  paragraphs: string[];
  url?: string | null;
};

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

/** 材料在哪个对象下：预审快照里有就直接用，没有就在相关对象的材料清单里找。 */
async function resolveMaterial(materialId: string, known: SourceMaterial | null, objects: SourceObject[], signal: AbortSignal): Promise<SourceMaterial | null> {
  if (known) return known;
  for (const object of objects) {
    const response = await fetch(`/api/materials/${object.objectType}/${encodeURIComponent(object.objectId)}`, { headers: { accept: "application/json" }, signal });
    if (!response.ok) continue;
    const body = (await response.json()) as { materials?: { id: string; fileName: string; format: string; version: number }[] };
    const found = body.materials?.find((material) => material.id === materialId);
    if (found) return { ...object, fileName: found.fileName, format: found.format, version: found.version };
  }
  // 相关对象里都没有（对话回答里的引用不带对象）：按材料 id 问它在哪个对象下，权限同材料清单。
  const located = await fetch(`/api/materials/locate/${encodeURIComponent(materialId)}`, { headers: { accept: "application/json" }, signal });
  if (!located.ok) return null;
  const body = (await located.json().catch(() => null)) as { objectType?: string; objectId?: string; fileName?: string; format?: string; version?: number } | null;
  if ((body?.objectType !== "issue" && body?.objectType !== "meeting") || !body.objectId || !body.fileName) return null;
  return { objectType: body.objectType, objectId: body.objectId, fileName: body.fileName, format: body.format, version: body.version };
}

const MATERIAL_ERROR: Record<string, string> = {
  MATERIAL_REVISION_NOT_FOUND: "该版本已不存在。",
  MATERIAL_NOT_FOUND: "该材料已删除，或无查看权限。",
};

function MaterialSource({ target, objects, label }: { target: Extract<SourceTarget, { type: "material" }>; objects: SourceObject[]; label: string }) {
  const [load, setLoad] = useState<Load<{ text: MaterialText; object: SourceMaterial }>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    void (async () => {
      try {
        const object = await resolveMaterial(target.materialId, target.material, objects, controller.signal);
        if (!object) throw new Error("未找到该材料：可能已删除，或无查看权限。");
        const base = `/api/materials/${object.objectType}/${encodeURIComponent(object.objectId)}/${encodeURIComponent(target.materialId)}`;
        const response = await fetch(`${base}/text?version=${target.version}`, { headers: { accept: "application/json" }, signal: controller.signal });
        if (response.status === 401) {
          window.location.assign("/access");
          return;
        }
        const body = (await response.json().catch(() => ({}))) as MaterialText & { code?: string; message?: string };
        if (!response.ok) throw new Error(MATERIAL_ERROR[body.code ?? ""] ?? "该版本材料读取失败。");
        if (!controller.signal.aborted) setLoad({ state: "ready", value: { text: body, object } });
      } catch (cause) {
        if (!controller.signal.aborted) setLoad({ state: "error", message: (cause as Error).message || "材料读取失败。" });
      }
    })();
    return () => controller.abort();
  }, [target.materialId, target.material, target.version, objects, attempt]);

  // 打开就停在被引用的那一段（只滚抽屉自己，不动正文）。
  useEffect(() => {
    if (load.state !== "ready" || !target.paragraph) return;
    const body = bodyRef.current;
    const cited = body?.querySelector<HTMLElement>(`[data-paragraph="${target.paragraph}"]`);
    if (body && cited) body.scrollTop = Math.max(0, cited.offsetTop - 96);
  }, [load.state, target.paragraph]);

  if (load.state === "loading") return <div className={d.drawerBody}><p className={d.muted} role="status">正在读取该版本材料…</p></div>;
  if (load.state === "error") {
    return (
      <div className={d.drawerBody}>
        <p className={d.errorLine} role="alert">{load.message}<button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button></p>
      </div>
    );
  }
  const { text, object } = load.value;
  const base = `/api/materials/${object.objectType}/${encodeURIComponent(object.objectId)}/${encodeURIComponent(target.materialId)}`;
  const cited = target.paragraph ? text.paragraphs[target.paragraph - 1] ?? null : null;
  const original = text.format === "pdf" || text.format === "docx";
  const markdown = text.format === "markdown";
  return (
    <>
      <div className={d.drawerBody} ref={bodyRef}>
        <p className={d.drawerMeta}>
          {object.objectType === "issue" ? "议题群材料" : "会议群材料"} · 第 {text.version} 版
          {text.currentVersion > text.version ? <span className={d.notice}>这是当时引用的第 {text.version} 版，当前已是第 {text.currentVersion} 版</span> : null}
        </p>
        {text.format === "link" ? (
          <p className={d.muted}>外部链接 · 未读取内容{text.url ? <a href={text.url} target="_blank" rel="noopener noreferrer">打开链接</a> : null}</p>
        ) : !text.readable ? (
          <p className={d.muted}>该版本无可读文字，请下载原件查看</p>
        ) : (
          <>
            {target.paragraph ? (
              cited ? (
                <section className={d.cited} aria-label={`引用的第 ${target.paragraph} 段`}>
                  <small>引用的第 {target.paragraph} 段</small>
                  {markdown ? <Markdown remarkPlugins={REMARK_PLUGINS}>{cited}</Markdown> : <p>{cited}</p>}
                </section>
              ) : <p className={d.notice}>引用的第 {target.paragraph} 段在这一版里找不到，下面是这一版全文。</p>
            ) : null}
            <ol className={d.paragraphs} aria-label={`第 ${text.version} 版全文`}>
              {text.paragraphs.map((paragraph, index) => (
                <li key={index} data-paragraph={index + 1} data-cited={target.paragraph === index + 1 || undefined}>
                  <span className={d.paragraphNo} aria-hidden="true">{index + 1}</span>
                  <div>{markdown ? <Markdown remarkPlugins={REMARK_PLUGINS}>{paragraph}</Markdown> : <p>{paragraph}</p>}</div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      <footer className={d.drawerFoot}>
        {text.format !== "link" ? (
          <a className={d.drawerAction} href={`${base}/file`}>
            <Download size={14} aria-hidden="true" />
            {original ? "下载原件" : "下载当前版"}
          </a>
        ) : null}
        {text.format === "pdf" || text.format === "docx" ? (
          <a className={d.drawerAction} href={`${base}/preview`} target="_blank" rel="noopener noreferrer">
            <ArrowUpRight size={14} aria-hidden="true" />
            打开原件预览
          </a>
        ) : null}
        <QuoteButton text={cited ?? ""} label={label} />
      </footer>
    </>
  );
}

function LegacySource({ meetingId, material }: { meetingId: string; material: LegacyMaterial }) {
  const preview = useMaterialPreview(meetingId, material.id);
  return (
    <div className={d.drawerBody}>
      <MaterialPane meetingId={meetingId} material={material} preview={preview} />
    </div>
  );
}

type ThreadMessage = { id: number; authorName: string | null; content: string; createdAt: string; quote: { text?: string } | null };

function DiscussionSource({ target, objects, label }: { target: Extract<SourceTarget, { type: "discussion" }>; objects: SourceObject[]; label: string }) {
  const known = target.change;
  const [load, setLoad] = useState<Load<ThreadMessage | null>>(known ? { state: "ready", value: null } : { state: "loading" });
  useEffect(() => {
    if (known) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for (const object of objects) {
          const response = await fetch(`/api/threads/${object.objectType}/${encodeURIComponent(object.objectId)}/messages?after=${Math.max(0, target.messageId - 1)}`,
            { headers: { accept: "application/json" }, signal: controller.signal });
          if (!response.ok) continue;
          const body = (await response.json()) as { messages?: ThreadMessage[] };
          const found = body.messages?.find((message) => message.id === target.messageId);
          if (found) {
            setLoad({ state: "ready", value: found });
            return;
          }
        }
        setLoad({ state: "ready", value: null });
      } catch (cause) {
        if (!controller.signal.aborted) setLoad({ state: "error", message: (cause as Error).message || "群讨论读取失败。" });
      }
    })();
    return () => controller.abort();
  }, [known, objects, target.messageId]);
  if (known) return <ChangeDetail change={known} label={label} />;
  if (load.state === "loading") return <div className={d.drawerBody}><p className={d.muted} role="status">正在读取这条群讨论…</p></div>;
  if (load.state === "error") return <div className={d.drawerBody}><p className={d.errorLine} role="alert">{load.message}</p></div>;
  const message = load.value;
  if (!message) return <div className={d.drawerBody}><p className={d.muted}>该群讨论不在可查看的群组中，或已删除。</p></div>;
  return (
    <>
      <div className={d.drawerBody}>
        <p className={d.drawerMeta}>{message.authorName ?? "群成员"} · {monthDayTime(message.createdAt)} · 群内个人发言</p>
        {message.quote?.text ? <blockquote className={d.quoteBlock}>{message.quote.text}</blockquote> : null}
        <p className={d.messageText}>{message.content}</p>
      </div>
      <footer className={d.drawerFoot}><QuoteButton text={message.content} label={label} /></footer>
    </>
  );
}

const CHANGE_KIND: Record<TDecisionHistoryChange["kind"], string> = {
  monthly_feedback: "阶段反馈",
  discussion: "群讨论",
  material_revision: "材料更新",
  signal: "外部信号",
  execution_fact: "执行事实",
};

function ChangeDetail({ change, label }: { change: TDecisionHistoryChange; label: string }) {
  return (
    <>
      <div className={d.drawerBody}>
        <p className={d.drawerMeta}>
          {CHANGE_KIND[change.kind]} · {monthDayTime(change.at)}{change.author ? ` · ${change.author.displayName}` : ""}
          {change.kind === "discussion" ? " · 群内个人发言" : ""}
        </p>
        {change.stance ? <p className={d.drawerMeta}>发言性质：{change.stance}</p> : null}
        <p className={d.messageText}>{change.text}</p>
        <p className={d.drawerMeta}>出处：{change.sourceRef}</p>
      </div>
      <footer className={d.drawerFoot}><QuoteButton text={change.text} label={label} /></footer>
    </>
  );
}

function DetailSource({ target, label, onOpen }: { target: Extract<SourceTarget, { type: "detail" }>; label: string; onOpen: (ref: string) => void }) {
  const hit: HistoryHit | null = target.hit;
  if (target.parsed.kind === "memory") return <KnowledgeSource file={target.parsed.file} section={target.parsed.section} label={label} />;
  if (hit && (hit.layer === "effective" || hit.layer === "inactive")) {
    const entry = hit.entry;
    const meetingRef = entry.source.meetingId ? `meeting:${entry.source.meetingId}` : null;
    return (
      <>
        <div className={d.drawerBody}>
          <p className={d.drawerMeta}>
            {entry.status === "effective" ? "仍有效" : entry.status === "revoked" ? "已撤回，不再约束" : "已被替代，不再约束"} · {monthDayTime(entry.decidedAt)}
            {entry.decidedBy ? ` · ${entry.decidedBy.displayName}` : ""}
          </p>
          <p className={d.messageText}>{entry.text}</p>
          {entry.source.quote ? <blockquote className={d.quoteBlock}>{entry.source.quote}</blockquote> : null}
          {entry.source.importedRef ? <p className={d.drawerMeta}>出处：{entry.source.importedRef}</p> : null}
          {entry.source.meetingTitle ? <p className={d.drawerMeta}>来源会议：{entry.source.meetingTitle}</p> : null}
        </div>
        <footer className={d.drawerFoot}>
          {meetingRef ? <button type="button" className={d.drawerAction} onClick={() => onOpen(meetingRef)}><ArrowUpRight size={14} aria-hidden="true" />打开来源会议</button> : null}
          <QuoteButton text={entry.text} label={label} />
        </footer>
      </>
    );
  }
  if (hit?.layer === "change") return <ChangeDetail change={hit.change} label={label} />;
  return (
    <div className={d.drawerBody}>
      <p className={d.muted}>该依据暂无法在此打开</p>
      <p className={d.drawerMeta}>{clip(label, 40)}</p>
    </div>
  );
}

export type KnowledgeSection = { id: string; title: string; updatedAt: string | null; passages: { id: string; text: string }[] };

/** 企业知识原文：`memory:<文件>.md#s<n>` 取一节，不带节号取整份。失败时抛出给一号位看的说明。 */
export async function fetchKnowledgeSource(file: string, section: number | null, signal?: AbortSignal): Promise<KnowledgeSection[] | null> {
  const ref = `memory:${file}${section ? `#s${section}` : ""}`;
  const response = await fetch(`/api/knowledge/source?ref=${encodeURIComponent(ref)}`, { headers: { accept: "application/json" }, signal });
  if (response.status === 401) {
    window.location.assign("/access");
    return null;
  }
  const body = (await response.json().catch(() => ({}))) as { sections?: KnowledgeSection[]; code?: string };
  if (response.status === 404 || body.code === "KNOWLEDGE_NOT_FOUND") throw new Error("企业知识中未找到该节，可能已改版。");
  if (!response.ok || !Array.isArray(body.sections)) throw new Error("该节原文暂未读取成功。");
  return body.sections;
}

/** 依据面板里的企业知识：直接显示原文（和群材料段落同样的排版）；读不出来时可以让天枢去找。 */
export function KnowledgeSource({ file, section, label }: { file: string; section: number | null; label: string }) {
  const { compose } = useWorkspace();
  const [load, setLoad] = useState<Load<KnowledgeSection[]>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    void fetchKnowledgeSource(file, section, controller.signal).then(
      (sections) => { if (sections && !controller.signal.aborted) setLoad({ state: "ready", value: sections }); },
      (cause: Error) => { if (!controller.signal.aborted) setLoad({ state: "error", message: cause.message || "该节原文暂未读取成功。" }); },
    );
    return () => controller.abort();
  }, [file, section, attempt]);

  const name = knowledgeName(file);
  const where = section ? `第 ${section} 节` : "";
  if (load.state === "loading") return <div className={d.drawerBody}><p className={d.muted} role="status">正在读取该节原文…</p></div>;
  if (load.state === "error") {
    return (
      <>
        <div className={d.drawerBody}>
          <p className={d.knowledgeNote} role="alert">{load.message}</p>
          <button type="button" className={d.knowledgeRetry} onClick={() => setAttempt((value) => value + 1)}>重试</button>
        </div>
        <footer className={d.drawerFoot}>
          <button type="button" className={d.drawerAction} onClick={() => compose(`请给我看企业知识《${name}》${where}的原文和出处`)}>
            <MessageSquareQuote size={14} aria-hidden="true" />
            让 Agent 给我看原文
          </button>
        </footer>
      </>
    );
  }
  const sections = load.value;
  const updated = sections.map((item) => item.updatedAt).filter(Boolean).sort().at(-1);
  const text = sections.flatMap((item) => item.passages.map((passage) => passage.text)).join("\n\n");
  return (
    <>
      <div className={d.drawerBody}>
        <p className={d.drawerMeta}>企业知识《{name}》{where ? ` · ${where}` : " · 全文"}{updated ? ` · 更新于 ${monthDayTime(updated)}` : ""}</p>
        {sections.map((item) => (
          <section key={item.id} className={d.knowledgeSection} aria-label={item.title || name}>
            {item.title ? <h3>{item.title}</h3> : null}
            {!item.passages.length ? <p className={d.knowledgeNote}>该节无正文。</p> : null}
            <ol className={d.paragraphs}>
              {item.passages.map((passage, index) => (
                <li key={passage.id}>
                  <span className={d.paragraphNo} aria-hidden="true">{index + 1}</span>
                  <div><Markdown remarkPlugins={REMARK_PLUGINS}>{passage.text}</Markdown></div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {section ? <footer className={d.drawerFoot}><QuoteButton text={text} label={label} /></footer> : null}
    </>
  );
}
