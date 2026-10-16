"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { emptySourceContext, parseSourceRef } from "@/cards/meetingSources";
import { payloadOf, type IssuePayload } from "@/cards/payloads";
import { useSourceNavigator } from "@/components/meeting/SourceViewer";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { cleanDisplayText, shortSourceName } from "@/lib/displayText";
import { registerCitationPanel, takePendingCitation, type CitationSurface } from "./citationBridge";
import d from "@/styles/decision-workspace.module.css";
import s from "@/styles/citation-panel.module.css";

/**
 * 外壳里的依据面板（深度讨论 v2）：开在对话左边，和对话同屏。
 * - 右列放大（二级页）：盖在左侧材料那一块上（没有页面依据导航的页，或页内没有的议题研究）；
 * - 首页对话层放大：对话层左边露出来的那一块。
 * 企业知识、群材料（按引用那一版、那一段）、群讨论用会议页「打开依据」同一套面板（SourceViewer）；
 * 议题 / 议题研究在这里直接看研究摘要与判断依据；会议、外部信号跳到对应页面。
 * 关掉：面板上的 ×、Esc（面板自己先接住，外壳这一次不收放大）；放大收起、换页时一起收。
 */

type Rect = { left: number; top: number; width: number; height: number };
type Request = { ref: string; surface: CitationSurface; trigger: HTMLElement | null; nonce: number };

const GAP = 14;

/** 面板放在哪：右列放大盖在左侧材料那一块上；首页对话层放大，用对话层左边那一块。量不到就是 null（不开）。 */
export function citationPanelRect(surface: CitationSurface, trigger: HTMLElement | null, doc: Document = document): Rect | null {
  if (surface === "rail") {
    const pane = doc.querySelector<HTMLElement>('[data-testid="expanded-panel"]');
    const box = pane?.getBoundingClientRect();
    return box && box.width > 0 ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
  }
  const sheet = trigger?.closest<HTMLElement>('[data-testid="conversation-sheet"]') ?? doc.querySelector<HTMLElement>('[data-testid="conversation-sheet"]');
  const box = sheet?.getBoundingClientRect();
  if (!box) return null;
  const width = box.left - GAP * 2;
  return width >= 320 ? { left: GAP, top: box.top, width, height: box.height } : null;
}

export function CitationPanel({ active }: { active: boolean }) {
  const [request, setRequest] = useState<Request | null>(null);
  const nonce = useRef(0);
  useEffect(() => registerCitationPanel((ref, options) => {
    setRequest({ ref, surface: options.surface, trigger: options.trigger ?? null, nonce: ++nonce.current });
  }), []);
  // 放大收起（含换页、变窄自动收起、对话层收起）：面板一起收。
  // 放大成了：平时在出处标记上点了「打开原文」（先放大、排着这一条）的，接着打开它。
  useEffect(() => {
    if (!active) { setRequest(null); return; }
    const next = takePendingCitation();
    if (next) setRequest({ ref: next.ref, surface: next.options.surface, trigger: next.options.trigger ?? null, nonce: ++nonce.current });
  }, [active]);
  if (!active || !request) return null;
  return <PanelBody key={request.nonce} request={request} onClose={() => setRequest(null)} />;
}

function PanelBody({ request, onClose }: { request: Request; onClose: () => void }) {
  const { navigate } = useWorkspace();
  const [rect, setRect] = useState<Rect | null>(() => citationPanelRect(request.surface, request.trigger));
  useLayoutEffect(() => {
    const measure = () => setRect(citationPanelRect(request.surface, request.trigger));
    window.addEventListener("resize", measure);
    // 刚放大（平时点「打开原文」先放大）时左侧那一块可能还没铺开：量不到就逐帧再量，最多约 20 帧。
    let frame = 0, tries = 0;
    const retry = () => {
      const next = citationPanelRect(request.surface, request.trigger);
      if (next) setRect(next);
      else if (++tries < 20) frame = requestAnimationFrame(retry);
    };
    if (!citationPanelRect(request.surface, request.trigger) && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(retry);
    return () => { window.removeEventListener("resize", measure); if (frame) cancelAnimationFrame(frame); };
  }, [request.surface, request.trigger]);
  const parsed = useMemo(() => parseSourceRef(request.ref), [request.ref]);
  const issueId = parsed.kind === "issue" ? parsed.id : parsed.kind === "research" ? parsed.issueId : null;
  const style = rect ? ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height } as CSSProperties) : undefined;
  if (!rect) return null;
  return (
    <div className={s.root} style={style} data-testid="citation-panel" data-surface={request.surface}>
      {issueId ? <IssueEvidence issueId={issueId} research={parsed.kind === "research"} trigger={request.trigger} onClose={onClose}
        onOpenIssue={() => navigate(`/issues/${encodeURIComponent(issueId)}`)} />
        : <SourceInPanel request={request} />}
    </div>
  );
}

const EMPTY_OBJECTS: never[] = [];

/** 企业知识、群材料、群讨论等：同会议页的依据面板；会议、外部信号这类跳到对应页面。 */
function SourceInPanel({ request }: { request: Request }) {
  const { navigate } = useWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const context = useMemo(() => emptySourceContext(), []);
  const { api, overlay } = useSourceNavigator({ context, rootRef: root, onNavigate: (href, origin) => navigate(href, origin), objects: EMPTY_OBJECTS, register: false });
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    api.open(request.ref, { trigger: request.trigger });
  }, [api, request.ref, request.trigger]);
  return <div ref={root} className={s.host}>{overlay}</div>;
}

type IssueLoad = { state: "loading" } | { state: "error" } | { state: "ready"; title: string; payload: IssuePayload };

/** 议题 / 议题研究：研究摘要与判断的依据（同议题页「判断的依据」），可以打开议题页。 */
export function IssueEvidence({ issueId, research, trigger, onClose, onOpenIssue }: {
  issueId: string; research: boolean; trigger: HTMLElement | null; onClose: () => void; onOpenIssue: () => void;
}) {
  const [load, setLoad] = useState<IssueLoad>({ state: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/cards/issues/{id}", { params: { path: { id: issueId } } }).then(
      ({ data }) => {
        const card = data?.cards?.[0];
        if (!alive) return;
        setLoad(card ? { state: "ready", title: card.title, payload: payloadOf<IssuePayload>(card) } : { state: "error" });
      },
      () => { if (alive) setLoad({ state: "error" }); },
    );
    return () => { alive = false; };
  }, [issueId]);
  const close = useRef(onClose);
  close.current = () => {
    onClose();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    // Esc 先关面板：标记已处理，外壳这一次不收放大。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const title = load.state === "ready" ? load.title : "议题";
  const doc = load.state === "ready" ? load.payload.research.doc : undefined;
  return (
    <aside className={d.drawer} role="dialog" aria-modal="false" aria-label={`依据：${title}`} data-source-drawer>
      <header className={d.drawerHead}>
        <div>
          <small>{research ? "议题研究与依据" : "议题"}</small>
          <h2>{title}</h2>
        </div>
        <button ref={closeRef} type="button" className={d.drawerClose} onClick={() => close.current()} aria-label="关闭依据">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className={d.drawerBody}>
        {load.state === "loading" ? <p className={d.muted} role="status">正在读取议题…</p>
          : load.state === "error" ? <p className={d.muted} role="alert">暂无法读取该议题，可能已移出或无查看权限。</p>
            : !doc ? <p className={d.muted}>预研尚未产出判断。</p>
              : (
                <>
                  {doc.summary ? <section className={s.block} aria-label="研究摘要"><h3>研究摘要</h3><p>{cleanDisplayText(doc.summary)}</p></section> : null}
                  {doc.evidence.length ? (
                    <section className={s.block} aria-label="判断的依据">
                      <h3>判断的依据</h3>
                      <ol className={d.paragraphs}>
                        {doc.evidence.map((item, index) => (
                          <li key={`${index}-${item.quote.slice(0, 16)}`}>
                            <span className={d.paragraphNo} aria-hidden="true">{index + 1}</span>
                            <div>
                              <p>{cleanDisplayText(item.quote)}</p>
                              <p className={d.drawerMeta}>
                                {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl)
                                  ? <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">{shortSourceName(item.sourceTitle)}</a>
                                  : shortSourceName(item.sourceTitle)}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                  {doc.unknowns.length ? (
                    <section className={s.block} aria-label="待澄清事项">
                      <h3>待澄清事项</h3>
                      <ul>{doc.unknowns.map((item) => <li key={item}>{cleanDisplayText(item)}</li>)}</ul>
                    </section>
                  ) : null}
                </>
              )}
      </div>
      <footer className={d.drawerFoot}>
        <button type="button" className={d.drawerAction} onClick={onOpenIssue}>
          <ArrowUpRight size={14} aria-hidden="true" />
          打开议题
        </button>
      </footer>
    </aside>
  );
}
