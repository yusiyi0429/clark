"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TMaterialDetailResponse, TMaterialRemovedView, TMaterialView } from "@warmap/contracts";
import { InHeader, MaterialMenu, useRememberedScroll, type MaterialTab } from "@/components/shell/MaterialTabs";
import { useConfirm } from "@/components/ConfirmDialog";
import { AnnotationBar, AnnotationComposer, HistoryCard, ProposalBanner, SELECTION_SCRIPT, usePollWhileWorking, useMaterialSelection, type MaterialSelection } from "./MaterialAnnotations";
import s from "./materials.module.css";

type ObjectType = "issue" | "task" | "meeting";
const date = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const endpoint = (type: ObjectType, id: string) => `/api/materials/${type}/${encodeURIComponent(id)}`;
const hasMarkdownSyntax = (text: string) => /(^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|\*\*|__|`|\[[^\]]+\]\(|~~)/m.test(text);
const htmlChangeText = (line: string) => line.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

export function ObjectMaterialArea({ objectType, objectId, baseTabs, groupTab, selected, selectedTab, onSelect, children }:
  { objectType: ObjectType; objectId: string; baseTabs: MaterialTab[]; groupTab?: MaterialTab; selected: string; selectedTab?: string | null; onSelect: (id: string) => void; children: ReactNode }) {
  const [materials, setMaterials] = useState<TMaterialView[]>([]);
  const [canUpload, setCanUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [detail, setDetail] = useState<TMaterialDetailResponse | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  /** 批注、恢复、提议改完后重读详情（版本号没变时也要重读批注状态）。 */
  const [reload, setReload] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const { ask, dialog } = useConfirm();
  const base = endpoint(objectType, objectId);
  const material = materials.find((item) => item.id === selected);
  useRememberedScroll(objectType === "meeting" ? undefined : `${objectType}:${objectId}|${selected}`);
  const refresh = useCallback(async () => {
    const response = await fetch(base, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = await response.json() as { materials: TMaterialView[]; canUpload: boolean };
    setMaterials(body.materials);
    setCanUpload(body.canUpload);
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const changed = (event: Event) => {
      const object = (event as CustomEvent<{ scope?: string }>).detail;
      if (!object?.scope || object.scope === `${objectType}:${objectId}`) void refresh();
    };
    window.addEventListener("materials-changed", changed);
    window.addEventListener("thread-materials-changed", changed);
    return () => { window.removeEventListener("materials-changed", changed); window.removeEventListener("thread-materials-changed", changed); };
  }, [objectType, objectId, refresh]);
  useEffect(() => {
    if (!material) { setDetail(null); return; }
    let active = true;
    const url = `${base}/${material.id}${version ? `?version=${version}` : ""}`;
    void fetch(url, { headers: { accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error("材料读取失败，请重试");
      return response.json() as Promise<TMaterialDetailResponse>;
    }).then((value) => { if (active) setDetail(value); }).catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [base, material?.id, material?.version, version, reload]);
  const reloadDetail = useCallback(() => { setReload((value) => value + 1); void refresh(); }, [refresh]);
  usePollWhileWorking(detail, reloadDetail);
  /** 写批注、恢复、处理提议：成功返回 null，失败返回一句给人看的原因。 */
  const post = useCallback(async (path: string, body: unknown): Promise<string | null> => {
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) { window.location.assign("/access"); return "登录已过期"; }
      const value = await response.json().catch(() => ({})) as { message?: string; code?: string };
      if (!response.ok) return response.status === 409 ? "材料刚被改过，已刷新到最新，请再试一次。" : value.message ?? "没有成功，请重试";
      return null;
    } catch { return "网络断了，请重试"; }
    finally { reloadDetail(); }
  }, [reloadDetail]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("viewing-material-changed", { detail: {
      scope: `${objectType}:${objectId}`, id: material?.id ?? null, editable: material?.editable ?? false, format: material?.format,
    } }));
    return () => { window.dispatchEvent(new CustomEvent("viewing-material-changed", { detail: { scope: `${objectType}:${objectId}`, id: null, editable: false } })); };
  }, [objectType, objectId, material?.id, material?.editable, material?.format]);
  const tabs = [...baseTabs, ...(groupTab ? [groupTab] : []), ...materials.map((item) => ({ id: item.id, label: item.fileName.replace(/\.[^.]+$/, ""), title: item.fileName }))];
  const choose = (id: string) => { setVersion(undefined); onSelect(id); };
  const upload = async (picked?: File) => {
    if (!picked) return;
    setUploadError("");
    if (!/\.(md|pdf|docx|html|htm)$/i.test(picked.name)) return setUploadError("只支持 PDF、Word、Markdown 和 HTML");
    if (picked.size > 20 * 1024 * 1024) return setUploadError("单份材料不能超过 20 MB");
    setUploading(true);
    try {
      const form = new FormData(); form.append("file", picked);
      const response = await fetch(base, { method: "POST", body: form });
      const body = await response.json() as TMaterialView & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "上传失败，请重试");
      await refresh();
      choose(body.id);
    } catch (cause) { setUploadError((cause as Error).message); }
    finally { setUploading(false); if (file.current) file.current.value = ""; }
  };
  const remove = async () => {
    if (!material || !await ask(`删除《${material.fileName}》？`, "删除材料")) return;
    const response = await fetch(`${base}/${material.id}`, { method: "DELETE" });
    if (!response.ok) return setUploadError("删除失败，请重试");
    choose(baseTabs[0]?.id ?? "");
    await refresh();
  };
  return <div className={s.area} data-material-scope={`${objectType}:${objectId}`}
    data-viewing-material-id={material?.id ?? ""} data-viewing-material-editable={material?.editable ? "true" : "false"}
    data-viewing-material-format={material?.format ?? ""}>
    {(objectType === "issue" || objectType === "meeting" || materials.length > 0 || canUpload) ? <div className={s.toolbar}>
      <InHeader><MaterialMenu tabs={tabs} selected={selectedTab === undefined ? selected : selectedTab} onSelect={choose}
        label={objectType === "meeting" ? "会议材料" : "材料"} onAdd={canUpload ? () => file.current?.click() : undefined} /></InHeader>
      {canUpload ? <input ref={file} className={s.hidden} type="file" accept=".md,.pdf,.docx,.html,.htm" aria-label="上传材料" onChange={(event) => void upload(event.target.files?.[0])} /> : null}
      {uploading ? <span className={s.uploading} role="status">上传中…</span> : null}
      {uploadError ? <button className={s.uploadError} type="button" onClick={() => setUploadError("")}>{uploadError}</button> : null}
    </div> : null}
    {material ? <div className={s.reader} data-material-scroll><MaterialReader material={material} detail={detail}
      base={base} onRemove={remove} onVersion={setVersion}
      onAnnotate={(selection, body) => post(`${base}/${material.id}/annotations`, { clientId: crypto.randomUUID(), version: detail?.version ?? material.version, quote: selection.text, prefix: selection.prefix, suffix: selection.suffix, body })}
      onRestore={(removed) => post(`${base}/${material.id}/restore`, { removedId: removed.id, version: detail?.version ?? material.version })}
      onDecide={(proposalId, decision) => post(`${base}/${material.id}/proposals/${encodeURIComponent(proposalId)}`, { decision })} />{dialog}</div>
      : groupTab && selected === groupTab.id ? <div className={s.groupList}>
        {materials.length ? <ul>{materials.map((item) => <li key={item.id}><button type="button" onClick={() => choose(item.id)}>{item.fileName}</button></li>)}</ul>
          : <p className={s.empty}>还没有群组材料，从材料下拉单里的「添加材料」上传。</p>}
      </div> : children}
  </div>;
}

export function MaterialReader({ material, detail, base, onRemove, onVersion, onAnnotate, onRestore, onDecide }:
  { material: TMaterialView; detail: TMaterialDetailResponse | null; base: string; onRemove: () => void; onVersion: (version?: number) => void;
    onAnnotate?: (selection: MaterialSelection, body: string) => Promise<string | null>;
    onRestore?: (removed: TMaterialRemovedView) => Promise<string | null>;
    onDecide?: (proposalId: string, decision: "apply" | "dismiss") => Promise<string | null> }) {
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [html, setHtml] = useState("");
  const [changes, setChanges] = useState(false);
  const host = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { selection, clear, onMouseUp } = useMaterialSelection(host, frame);
  useEffect(() => { setChanges(false); clear(); }, [material.id, detail?.version, clear]);
  useEffect(() => {
    if (material.format !== "docx") return;
    let active = true;
    void fetch(`${base}/${material.id}/preview`).then((response) => response.text()).then((value) => { if (active) setHtml(value); });
    return () => { active = false; };
  }, [base, material.id, material.format, material.version]);
  const by = detail?.revision.requestedBy?.displayName ?? material.owner.displayName;
  const changeCount = detail?.blocks?.filter((block) => block.change !== null).length ?? 0;
  const htmlChanges = <button type="button" onClick={() => setChanges((value) => !value)} aria-expanded={changes}>{changeCount} 处</button>;
  // 只在看最新版时能写批注；PDF 在浏览器自带阅读器里，选不到文字。
  const annotatable = Boolean(onAnnotate && detail?.latest && material.format !== "pdf");
  return <article ref={host} className={s.document} aria-label={material.fileName}>
    <p className={s.meta}>{material.origin === "agent" ? `Agent 按${material.owner.displayName}的要求写` : `${material.owner.displayName} 上传`} · {date(material.createdAt)}
      <a href={`${base}/${material.id}/file`}>下载</a>{material.canDelete ? <button type="button" onClick={() => void onRemove()}>删除</button> : null}</p>
    {material.format !== "markdown" && material.format !== "html" ? <p className={s.readOnly}>只读 · 只有 Markdown 和 HTML 能让 Agent 修改{material.format === "pdf" ? "；PDF 暂不支持选中写批注" : "；选中文字可以写批注"}</p> : null}
    {detail?.revision && material.lastRevision ? <div className={s.revision}>
      {detail.latest ? detail.version === 1
        ? `第 1 版 · Agent 按${by}的要求新写 · ${date(detail.revision.at)}`
        : material.format === "html" ? <>第 {detail.version} 版 · {by}让 Agent 改了 {htmlChanges} · {date(detail.revision.at)}</>
          : `第 ${detail.version} 版 · ${by}让 Agent 改了 ${changeCount} 处 · ${date(detail.revision.at)}`
        : material.format === "html" && detail.version > 1 ? <>这是第 {detail.version} 版，不是最新 · 改了 {htmlChanges}</>
          : `这是第 ${detail.version} 版，不是最新`}
      <button type="button" onClick={() => setHistory((value) => !value)} aria-expanded={history}>改动记录</button>
      {!detail.latest ? <button type="button" onClick={() => onVersion(undefined)}>回到最新</button> : null}
    </div> : null}
    {detail?.latest && onDecide ? detail.proposals.filter((item) => item.status === "pending").map((item) => <ProposalBanner key={item.id} proposal={item} onDecide={(decision) => onDecide(item.id, decision)} />) : null}
    {detail?.latest && onRestore ? <AnnotationBar detail={detail} onRestore={onRestore} /> : null}
    {history && detail ? <ol className={s.history}>{detail.revisions.map((item) => <li key={item.version}>
      <button type="button" onClick={() => { onVersion(item.version); setHistory(false); }}>第 {item.version} 版 · {item.requestedBy?.displayName ?? material.owner.displayName} · {date(item.at)} · {item.summary ?? "上传原件"}</button>
    </li>)}</ol> : null}
    {material.format === "html" && changes && detail ? <ol className={s.changeList}>{detail.blocks?.filter((block) => block.change !== null).map((block, index) => <li key={index}>
      {block.change?.kind === "modified" ? <><strong>修改</strong><span>原来：{htmlChangeText(block.change.before)}</span><span>现在：{htmlChangeText(block.text)}</span></>
        : block.change?.kind === "removed" ? <><strong>删除</strong><span>{htmlChangeText(block.change.before)}</span></>
          : <><strong>新增</strong><span>{htmlChangeText(block.text)}</span></>}
    </li>)}</ol> : null}
    {!detail ? <p role="status">正在读取材料…</p> : material.format === "pdf"
      ? <iframe className={s.frame} src={`${base}/${material.id}/preview`} title={`${material.fileName} 预览`} />
      : material.format === "html" ? <iframe ref={frame} className={s.frame} sandbox="allow-scripts" src={`${base}/${material.id}/preview?version=${detail.version}`} title={`${material.fileName} 预览`} />
      : material.format === "docx" ? <iframe ref={frame} className={s.frame} sandbox="allow-scripts" title={`${material.fileName} 预览`} srcDoc={annotatable ? html + SELECTION_SCRIPT : html} />
      : <div ref={body} className={s.markdown} onMouseUp={annotatable ? () => onMouseUp(body.current) : undefined}>{detail.blocks?.map((block, index, blocks) => {
        // 删掉的内容正文里不显示，统一在「已删除 N 段」（垃圾篓）里看、恢复。
        if (block.change?.kind === "removed") return null;
        const quiet = (item: typeof block) => item.change?.kind !== "modified" && !item.history.length;
        const listItem = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(block.text);
        if (listItem && quiet(block)) {
          const previous = blocks.slice(0, index).reverse().find((item) => item.change?.kind !== "removed");
          if (previous && /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(previous.text) && quiet(previous)) return null;
          let end = index + 1;
          while (end < blocks.length && (blocks[end].change?.kind === "removed" || (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(blocks[end].text) && quiet(blocks[end])))) end++;
          return <div key={index} className={s.block}><Markdown remarkPlugins={[remarkGfm]}>{blocks.slice(index, end).filter((item) => item.change?.kind !== "removed").map((item) => item.text).join("\n")}</Markdown></div>;
        }
        // 悬停：有历史（看最新版时）显示批注和历次改动，否则只显示这一版的原文。
        const popup = open === index ? block.history.length ? <HistoryCard history={block.history} />
          : block.change?.kind === "modified" ? <ChangePopup before={block.change.before} detail={detail} /> : null : null;
        const hover = { onMouseEnter: () => setOpen(index), onFocus: () => setOpen(index), onClick: () => setOpen(open === index ? null : index) };
        if (block.change?.kind === "modified" && hasMarkdownSyntax(block.text)) return <div key={index} className={s.block} onMouseLeave={() => setOpen(null)}>
          <div className={s.formattedChange} role="button" tabIndex={0} aria-label="查看批注和修改历史" {...hover}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === index ? null : index); } }}>
            <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
          </div>{popup}</div>;
        if (block.change?.kind === "modified") return <div key={index} className={`${s.block} ${s.plain}`} onMouseLeave={() => setOpen(null)}>
          {block.change.spans.map((span, part) => span.changed ? <button key={part} type="button" className={s.changed} aria-label="查看批注和修改历史" {...hover}>{span.text}</button> : <span key={part}>{span.text}</span>)}
          {popup}</div>;
        // 这一版没动、但以前改过：左边一道浅线，悬停看历史。
        if (block.history.length) return <div key={index} className={`${s.block} ${s.hadChange}`} tabIndex={0} aria-label="查看批注和修改历史" onMouseLeave={() => setOpen(null)} {...hover}>
          <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>{popup}</div>;
        return <div key={index} className={s.block}><Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown></div>;
      })}</div>}
    {selection && annotatable && onAnnotate ? <AnnotationComposer selection={selection} editable={material.editable} onClose={clear}
      onSubmit={(text) => onAnnotate(selection, text)} /> : null}
  </article>;
}
function ChangePopup({ before, detail }: { before: string; detail: TMaterialDetailResponse }) {
  return <div className={s.popup} role="note"><span>原来：{before}</span><small>{detail.revision.requestedBy?.displayName ?? "Agent"}让 Agent 改的 · {date(detail.revision.at)}</small></div>;
}
