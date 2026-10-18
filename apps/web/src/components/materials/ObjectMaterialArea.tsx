"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import { REMARK_PLUGINS } from "@/lib/markdown";
import type { TMaterialDetailResponse, TMaterialRemovedView, TMaterialView } from "@warmap/contracts";
import { ArrowUpRight, Link2, Upload } from "lucide-react";
import { Button, Input, Label, TextField } from "ts-design/primitives";
import { InHeader, MaterialMenu, useRememberedScroll, type MaterialAddAction, type MaterialTab } from "@/components/shell/MaterialTabs";
import { MenuDialog } from "@/components/AccountMenu";
import { TianshuMark } from "@/components/TianshuMark";
import { useConfirm } from "@/components/ConfirmDialog";
import { AnnotationBar, AnnotationComposer, HistoryCard, ProposalBanner, SELECTION_SCRIPT, uploadedVersion, usePollWhileWorking, useMaterialSelection,
  type DecideAnnotation, type MaterialSelection } from "./MaterialAnnotations";
import s from "./materials.module.css";
import { materialTitle } from "@/lib/displayText";

/** 材料区交给正文（执行事项的封面）用的东西：材料清单和放材料的几个动作。 */
export interface MaterialAreaApi {
  materials: TMaterialView[];
  canUpload: boolean;
  uploading: boolean;
  /** 左侧阅读区换成这一份（和在下拉单里选是同一个动作）。 */
  open: (id: string) => void;
  /** 打开选文件（执行事项可以一次选几份，按顺序一份一份传）。 */
  pickFile: () => void;
  /** 打开「粘贴链接」小窗。 */
  pasteLink: () => void;
  /** 「起草文档」：交给天枢；没有时不出这一项。 */
  draft?: () => void;
}

type ObjectType = "issue" | "task" | "meeting";
const date = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** 页签上的短名：带文字层抽取件内部后缀的只留原始标题，其他照旧去掉扩展名。 */
const tabLabel = (fileName: string) => {
  const title = materialTitle(fileName);
  return title !== fileName ? title : fileName.replace(/\.[^.]+$/, "");
};
const endpoint = (type: ObjectType, id: string) => `/api/materials/${type}/${encodeURIComponent(id)}`;
const hasMarkdownSyntax = (text: string) => /(^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|\*\*|__|`|\[[^\]]+\]\(|~~)/m.test(text);
const htmlChangeText = (line: string) => line.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
/** 链接的域名，去掉 www.；地址不合法时原样返回。 */
export const linkHost = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const LINK_PATTERN = /^https?:\/\/\S+$/i;

export function ObjectMaterialArea({ objectType, objectId, baseTabs, homeTab, groupTab, selected, selectedTab, onSelect, links = false, onDraft, deliverables, onChanged, children }:
  { objectType: ObjectType; objectId: string; baseTabs: MaterialTab[]; groupTab?: MaterialTab; selected: string; selectedTab?: string | null; onSelect: (id: string) => void;
    /** 删掉正在看的材料后回到哪一份；不给就回 baseTabs 第一项。页头另有类型切换（SegmentedSwitch）的页，切换的那几份不进下拉单，从这里告诉材料区。 */
    homeTab?: string;
    /** 执行事项（design-12）：能放链接；下拉单的添加项拆成上传文件 / 粘贴链接 / 起草文档；整页能拖文件、粘贴链接。 */
    links?: boolean;
    /** 「起草文档」：交给天枢（打开右列私聊并预填）。 */
    onDraft?: () => void;
    /** 完成后验收时选的交付结果：下拉单里排在前面，其余在「参考材料」后面。 */
    deliverables?: string[] | null;
    /** 本人放进、删掉材料之后，以及对话里的 Agent 改了材料之后（对象的状态可能跟着变）。 */
    onChanged?: () => void;
    children: ReactNode | ((area: MaterialAreaApi) => ReactNode) }) {
  const [materials, setMaterials] = useState<TMaterialView[]>([]);
  const [canUpload, setCanUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [detail, setDetail] = useState<TMaterialDetailResponse | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  /** 批注、恢复、提议改完后重读详情（版本号没变时也要重读批注状态）。 */
  const [reload, setReload] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const { ask, dialog } = useConfirm();
  const base = endpoint(objectType, objectId);
  const material = materials.find((item) => item.id === selected);
  useRememberedScroll(objectType === "meeting" ? undefined : `${objectType}:${objectId}|${selected}`);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const refresh = useCallback(async () => {
    const response = await fetch(base, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const body = await response.json() as { materials: TMaterialView[]; canUpload: boolean };
    setMaterials(body.materials);
    setCanUpload(body.canUpload);
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onEvent = (event: Event) => {
      const object = (event as CustomEvent<{ scope?: string }>).detail;
      if (object?.scope && object.scope !== `${objectType}:${objectId}`) return;
      setReload((value) => value + 1);
      void refresh();
      changed.current?.();
    };
    window.addEventListener("materials-changed", onEvent);
    window.addEventListener("thread-materials-changed", onEvent);
    return () => { window.removeEventListener("materials-changed", onEvent); window.removeEventListener("thread-materials-changed", onEvent); };
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
  // 封面和下拉单上的「在改」：有一份正在按批注改、阅读区又没开着时，隔一会儿重读清单，改完（没改成也一样）就消失。
  const listWorking = !material && materials.some((item) => item.working);
  useEffect(() => {
    if (!listWorking) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [listWorking, refresh]);
  /** 写批注、恢复、处理提议：成功返回 null，失败返回一句给人看的原因。 */
  const post = useCallback(async (path: string, body: unknown): Promise<string | null> => {
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) { window.location.assign("/access"); return "登录已过期"; }
      const value = await response.json().catch(() => ({})) as { message?: string; code?: string };
      if (!response.ok) return response.status === 409 && value.code !== "MATERIAL_ANNOTATION_DECIDED" ? "材料刚被改过，已刷新到最新，请再试一次。" : value.message ?? "没有成功，请重试";
      return null;
    } catch { return "网络断了，请重试"; }
    finally { reloadDetail(); }
  }, [reloadDetail]);
  // 对话里能不能直接让 Agent 改这份：只看本人能不能改（上传者、对象负责人），不能改的只能提议。
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("viewing-material-changed", { detail: {
      scope: `${objectType}:${objectId}`, id: material?.id ?? null, editable: material?.canEdit ?? false, format: material?.format,
    } }));
    return () => { window.dispatchEvent(new CustomEvent("viewing-material-changed", { detail: { scope: `${objectType}:${objectId}`, id: null, editable: false } })); };
  }, [objectType, objectId, material?.id, material?.canEdit, material?.format]);
  const tab = (item: TMaterialView): MaterialTab => item.format === "link"
    ? { id: item.id, label: item.fileName, title: `${item.fileName}（链接）`, kind: "link", hint: linkHost(item.url ?? ""), working: item.working }
    : { id: item.id, label: tabLabel(item.fileName), title: materialTitle(item.fileName), working: item.working, count: item.pending };
  const delivered = deliverables ? materials.filter((item) => deliverables.includes(item.id)) : [];
  const reference = deliverables ? materials.filter((item) => !deliverables.includes(item.id)) : materials;
  const tabs: MaterialTab[] = [...baseTabs, ...(groupTab ? [groupTab] : []), ...delivered.map(tab),
    ...reference.map((item, index) => ({ ...tab(item), ...(delivered.length && index === 0 ? { ruleBefore: "参考材料" } : {}) }))];
  const choose = (id: string) => { setVersion(undefined); onSelect(id); };
  const upload = async (picked: File[]) => {
    if (!picked.length) return;
    setUploadError("");
    const bad = picked.find((item) => !/\.(md|pdf|docx|html|htm)$/i.test(item.name));
    if (bad) return setUploadError("只支持 PDF、Word、Markdown 和 HTML");
    if (picked.some((item) => item.size > 20 * 1024 * 1024)) return setUploadError("单份材料不能超过 20 MB");
    setUploading(true);
    let last: string | null = null;
    try {
      for (const item of picked) {
        const form = new FormData(); form.append("file", item);
        const response = await fetch(base, { method: "POST", body: form });
        const body = await response.json() as TMaterialView & { message?: string };
        if (!response.ok) throw new Error(body.message ?? "上传失败，请重试");
        last = body.id;
      }
      await refresh();
      changed.current?.();
      if (last && !links) choose(last);
    } catch (cause) {
      setUploadError((cause as Error).message);
      // 一份一份传：中途失败时，前面传成的照样列出来。
      if (last) await refresh().then(() => changed.current?.(), () => undefined);
    }
    finally { setUploading(false); if (file.current) file.current.value = ""; }
  };
  /** 贴一条链接；成功返回 null，失败返回原因。同一个地址已经在这件事里时服务端返回原来那一份。 */
  const addLink = useCallback(async (url: string, title?: string): Promise<string | null> => {
    try {
      const response = await fetch(`${base}/links`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), ...(title?.trim() ? { title: title.trim() } : {}) }) });
      if (response.status === 401) { window.location.assign("/access"); return "登录已过期"; }
      const body = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) return body.message ?? "没放进来，请重试";
      await refresh();
      changed.current?.();
      return null;
    } catch { return "网络断了，请重试"; }
  }, [base, refresh]);
  const remove = async () => {
    if (!material || !await ask(`删除《${materialTitle(material.fileName)}》？`, "删除材料")) return;
    const response = await fetch(`${base}/${material.id}`, { method: "DELETE" });
    if (!response.ok) return setUploadError("删除失败，请重试");
    choose(homeTab ?? baseTabs[0]?.id ?? "");
    await refresh();
    changed.current?.();
  };
  // 执行事项整页可以粘贴一条链接（焦点不在输入框里时），等于「粘贴链接」。
  useEffect(() => {
    if (!links || !canUpload) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      const text = event.clipboardData?.getData("text/plain").trim() ?? "";
      if (!LINK_PATTERN.test(text)) return;
      event.preventDefault();
      void addLink(text).then((failure) => setUploadError(failure ?? ""));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [links, canUpload, addLink]);
  const api: MaterialAreaApi = { materials, canUpload, uploading, open: choose, pickFile: () => file.current?.click(),
    pasteLink: () => setLinkOpen(true), draft: onDraft };
  const addActions: MaterialAddAction[] | undefined = links && canUpload ? [
    { id: "upload", label: "上传文件", icon: <Upload size={15} strokeWidth={1.8} aria-hidden />, onPress: api.pickFile },
    { id: "link", label: "粘贴链接", icon: <Link2 size={15} strokeWidth={1.8} aria-hidden />, onPress: api.pasteLink },
    ...(onDraft ? [{ id: "draft", label: "起草文档", icon: <TianshuMark className={s.menuMark} />, onPress: onDraft }] : []),
  ] : undefined;
  const dropping = links && canUpload ? {
    onDragOver: (event: DragEvent<HTMLDivElement>) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(true); },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent<HTMLDivElement>) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); void upload([...event.dataTransfer.files]); },
  } : {};
  return <div className={s.area} data-material-scope={`${objectType}:${objectId}`} data-dragging={dragging || undefined} {...dropping}
    data-viewing-material-id={material?.id ?? ""} data-viewing-material-editable={material?.canEdit ? "true" : "false"}
    data-viewing-material-format={material?.format ?? ""}>
    {((objectType !== "task" && baseTabs.length > 0) || groupTab || materials.length > 0 || canUpload) ? <div className={s.toolbar}>
      <InHeader><MaterialMenu tabs={tabs} selected={selectedTab === undefined ? selected : selectedTab} onSelect={choose}
        label={objectType === "meeting" ? "会议材料" : "材料"} addActions={addActions} onAdd={canUpload && !addActions ? () => file.current?.click() : undefined} /></InHeader>
      {canUpload ? <input ref={file} className={s.hidden} type="file" accept=".md,.pdf,.docx,.html,.htm" multiple={links} aria-label="上传材料"
        onChange={(event) => void upload([...(event.target.files ?? [])])} /> : null}
      {uploading ? <span className={s.uploading} role="status">上传中…</span> : null}
      {uploadError ? <button className={s.uploadError} type="button" onClick={() => setUploadError("")}>{uploadError}</button> : null}
    </div> : null}
    {material ? <div className={s.reader} data-material-scroll>{material.format === "link" ? <LinkReader material={material} onRemove={remove} /> : <MaterialReader material={material} detail={detail}
      base={base} onRemove={remove} onVersion={setVersion}
      onAnnotate={(selection, body, intent) => post(`${base}/${material.id}/annotations`, { clientId: crypto.randomUUID(), version: detail?.version ?? material.version, quote: selection.text, prefix: selection.prefix, suffix: selection.suffix, body, intent })}
      onDecideAnnotation={(id, decision, reason) => post(`${base}/${material.id}/annotations/${encodeURIComponent(id)}/decide`, { decision, ...(reason ? { reason } : {}) })}
      onRestore={(removed) => post(`${base}/${material.id}/restore`, { removedId: removed.id, version: detail?.version ?? material.version })}
      onDecide={(proposalId, decision) => post(`${base}/${material.id}/proposals/${encodeURIComponent(proposalId)}`, { decision })} />}{dialog}</div>
      : groupTab && selected === groupTab.id ? <div className={s.groupList}>
        {materials.length ? <ul>{materials.map((item) => <li key={item.id}><button type="button" onClick={() => choose(item.id)}>{materialTitle(item.fileName)}</button></li>)}</ul>
          : <p className={s.empty}>暂无群组材料</p>}
      </div> : typeof children === "function" ? children(api) : children}
    {linkOpen ? <LinkDialog onClose={() => setLinkOpen(false)} onSubmit={addLink} /> : null}
  </div>;
}

/** 「粘贴链接」：贴地址（标题可不填，默认用域名加路径最后一段）。不抓外部页面。 */
function LinkDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string, title?: string) => Promise<string | null> }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!LINK_PATTERN.test(url.trim())) return setError("请贴完整的 http 或 https 地址");
    setBusy(true); setError("");
    const failure = await onSubmit(url, title);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return <MenuDialog title="粘贴链接" onClose={onClose}>
    <form className={s.linkForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <TextField className={s.linkField} value={url} onChange={setUrl} autoFocus isRequired>
        <Label>地址</Label>
        <Input placeholder="https://" inputMode="url" />
      </TextField>
      <TextField className={s.linkField} value={title} onChange={setTitle}>
        <Label>标题 · 可不填</Label>
        <Input placeholder="留空则使用域名" />
      </TextField>
      {error ? <p className={s.linkError} role="alert">{error}</p> : null}
      <div className={s.linkActions}><Button variant="primary" type="submit" isDisabled={busy || !url.trim()}>{busy ? "添加中…" : "添加链接"}</Button></div>
    </form>
  </MenuDialog>;
}

/** 链接的阅读页：不嵌 iframe（不抓外部页面），只写它是什么、谁放的，点「打开」在新标签页里看。 */
function LinkReader({ material, onRemove }: { material: TMaterialView; onRemove: () => void }) {
  const url = material.url ?? "";
  return <article className={s.document} aria-label={materialTitle(material.fileName)}>
    <div className={s.linkPage}>
      <div className={s.linkFrame} aria-hidden>
        <span className={s.linkBar}><i /><i /><i /><b>{linkHost(url)}</b></span>
        <span className={s.linkBody}><i /><span><i /><i /></span></span>
      </div>
      <h2 className={s.linkTitle}>{materialTitle(material.fileName)}</h2>
      <p className={s.linkMeta}>{linkHost(url)} · {material.owner.displayName} 放进来 · {date(material.createdAt)}
        {material.canDelete ? <button type="button" onClick={() => void onRemove()}>删除</button> : null}</p>
      <a className={s.linkOpen} href={url} target="_blank" rel="noopener noreferrer">打开<ArrowUpRight size={15} strokeWidth={2} aria-hidden /></a>
      <p className={s.linkUrl}>{url}</p>
    </div>
  </article>;
}

export function MaterialReader({ material, detail, base, onRemove, onVersion, onAnnotate, onDecideAnnotation, onRestore, onDecide }:
  { material: TMaterialView; detail: TMaterialDetailResponse | null; base: string; onRemove: () => void; onVersion: (version?: number) => void;
    onAnnotate?: (selection: MaterialSelection, body: string, intent: "note" | "edit") => Promise<string | null>;
    onDecideAnnotation?: DecideAnnotation;
    onRestore?: (removed: TMaterialRemovedView) => Promise<string | null>;
    onDecide?: (proposalId: string, decision: "apply" | "dismiss") => Promise<string | null> }) {
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [html, setHtml] = useState("");
  const [changes, setChanges] = useState(false);
  const host = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { selection, clear, onMouseUp } = useMaterialSelection(host, frame, body);
  useEffect(() => { setChanges(false); clear(); }, [material.id, detail?.version, clear]);
  useEffect(() => {
    if (material.format !== "docx") return;
    let active = true;
    void fetch(`${base}/${material.id}/preview`).then((response) => response.text()).then((value) => { if (active) setHtml(value); });
    return () => { active = false; };
  }, [base, material.id, material.format, material.version]);
  const by = detail?.revision.requestedBy?.displayName ?? material.owner.displayName;
  // 有人上传（或资料包导入）的新版本：写「X上传的新版本 · 改动说明」，不写「让 Agent 改了 N 处」，也不数改动处。
  const uploaded = uploadedVersion(detail?.revision);
  const changeCount = detail?.blocks?.filter((block) => block.change !== null).length ?? 0;
  const htmlChanges = <button type="button" onClick={() => setChanges((value) => !value)} aria-expanded={changes}>{changeCount} 处</button>;
  // 只在看最新版时能写批注；PDF 在浏览器自带阅读器里，选不到文字。
  const annotatable = Boolean(onAnnotate && detail?.latest && material.format !== "pdf");
  return <article ref={host} className={s.document} aria-label={materialTitle(material.fileName)}>
    <p className={s.meta}>{material.origin === "agent" ? `Agent 按${material.owner.displayName}的要求写` : `${material.owner.displayName} 上传`} · {date(material.createdAt)}
      {/* 资料包标明“AI 生成演示素材”的材料（没有真实件）：写在来历后面，和真实材料区分开。 */}
      {material.nature === "ai_generated" ? <span> · AI 整理</span> : null}
      <a href={`${base}/${material.id}/file`}>下载</a>{material.canDelete ? <button type="button" onClick={() => void onRemove()}>删除</button> : null}</p>
    {material.format !== "markdown" && material.format !== "html" ? <p className={s.readOnly}>只读 · 只有 Markdown 和 HTML 能让 Agent 修改{material.format === "pdf" ? "；PDF 暂不支持选中写批注" : "；选中文字可以写批注"}</p> : null}
    {detail?.revision && material.lastRevision ? <div className={s.revision}>
      {detail.latest ? detail.version === 1
        ? `第 1 版 · Agent 按${by}的要求新写 · ${date(detail.revision.at)}`
        : uploaded ? `第 ${detail.version} 版 · ${by}上传的新版本${detail.revision.summary ? ` · ${detail.revision.summary}` : ""} · ${date(detail.revision.at)}`
        : material.format === "html" ? <>第 {detail.version} 版 · {by}让 Agent 改了 {htmlChanges} · {date(detail.revision.at)}</>
          : `第 ${detail.version} 版 · ${by}让 Agent 改了 ${changeCount} 处 · ${date(detail.revision.at)}`
        : material.format === "html" && detail.version > 1 && !uploaded ? <>这是第 {detail.version} 版，不是最新 · 改了 {htmlChanges}</>
          : `这是第 ${detail.version} 版，不是最新`}
      <button type="button" onClick={() => setHistory((value) => !value)} aria-expanded={history}>改动记录</button>
      {!detail.latest ? <button type="button" onClick={() => onVersion(undefined)}>回到最新</button> : null}
    </div> : null}
    {detail?.latest && onDecide ? detail.proposals.filter((item) => item.status === "pending").map((item) => <ProposalBanner key={item.id} proposal={item} onDecide={(decision) => onDecide(item.id, decision)} />) : null}
    {detail?.latest && onRestore ? <AnnotationBar detail={detail} onRestore={onRestore} onDecide={onDecideAnnotation} /> : null}
    {history && detail ? <ol className={s.history}>{detail.revisions.map((item) => <li key={item.version}>
      <button type="button" onClick={() => { onVersion(item.version); setHistory(false); }}>第 {item.version} 版 · {item.requestedBy?.displayName ?? material.owner.displayName}{item.version > 1 && uploadedVersion(item) ? "上传" : ""} · {date(item.at)} · {item.summary ?? (item.version > 1 ? "新版本" : "上传原件")}</button>
    </li>)}</ol> : null}
    {material.format === "html" && changes && detail ? <ol className={s.changeList}>{detail.blocks?.filter((block) => block.change !== null).map((block, index) => <li key={index}>
      {block.change?.kind === "modified" ? <><strong>修改</strong><span>原来：{htmlChangeText(block.change.before)}</span><span>现在：{htmlChangeText(block.text)}</span></>
        : block.change?.kind === "removed" ? <><strong>删除</strong><span>{htmlChangeText(block.change.before)}</span></>
          : <><strong>新增</strong><span>{htmlChangeText(block.text)}</span></>}
    </li>)}</ol> : null}
    {!detail ? <p role="status">正在读取材料…</p> : material.format === "pdf"
      ? <iframe className={s.frame} src={`${base}/${material.id}/preview`} title={`${materialTitle(material.fileName)} 预览`} />
      : material.format === "html" ? <iframe ref={frame} className={s.frame} sandbox="allow-scripts" src={`${base}/${material.id}/preview?version=${detail.version}`} title={`${materialTitle(material.fileName)} 预览`} />
      : material.format === "docx" ? <iframe ref={frame} className={s.frame} sandbox="allow-scripts" title={`${materialTitle(material.fileName)} 预览`} srcDoc={annotatable ? html + SELECTION_SCRIPT : html} />
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
          return <div key={index} className={s.block}><Markdown remarkPlugins={REMARK_PLUGINS}>{blocks.slice(index, end).filter((item) => item.change?.kind !== "removed").map((item) => item.text).join("\n")}</Markdown></div>;
        }
        // 悬停：有历史（看最新版时）显示批注和历次改动，否则只显示这一版的原文。
        const popup = open === index ? block.history.length ? <HistoryCard history={block.history} />
          : block.change?.kind === "modified" ? <ChangePopup before={block.change.before} detail={detail} /> : null : null;
        const hover = { onMouseEnter: () => setOpen(index), onFocus: () => setOpen(index), onClick: () => setOpen(open === index ? null : index) };
        if (block.change?.kind === "modified" && hasMarkdownSyntax(block.text)) return <div key={index} className={s.block} onMouseLeave={() => setOpen(null)}>
          <div className={s.formattedChange} role="button" tabIndex={0} aria-label="查看批注和修改历史" {...hover}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === index ? null : index); } }}>
            <Markdown remarkPlugins={REMARK_PLUGINS}>{block.text}</Markdown>
          </div>{popup}</div>;
        if (block.change?.kind === "modified") return <div key={index} className={`${s.block} ${s.plain}`} onMouseLeave={() => setOpen(null)}>
          {block.change.spans.map((span, part) => span.changed ? <button key={part} type="button" className={s.changed} aria-label="查看批注和修改历史" {...hover}>{span.text}</button> : <span key={part}>{span.text}</span>)}
          {popup}</div>;
        // 这一版没动、但以前改过：左边一道浅线，悬停看历史。
        if (block.history.length) return <div key={index} className={`${s.block} ${s.hadChange}`} tabIndex={0} aria-label="查看批注和修改历史" onMouseLeave={() => setOpen(null)} {...hover}>
          <Markdown remarkPlugins={REMARK_PLUGINS}>{block.text}</Markdown>{popup}</div>;
        return <div key={index} className={s.block}><Markdown remarkPlugins={REMARK_PLUGINS}>{block.text}</Markdown></div>;
      })}</div>}
    {selection && annotatable && onAnnotate ? <AnnotationComposer selection={selection} canEdit={material.canEdit} onClose={clear}
      onSubmit={(text, intent) => onAnnotate(selection, text, intent)} /> : null}
  </article>;
}
function ChangePopup({ before, detail }: { before: string; detail: TMaterialDetailResponse }) {
  const by = detail.revision.requestedBy?.displayName;
  return <div className={s.popup} role="note"><span>原来：{before}</span><small>{uploadedVersion(detail.revision)
    ? `${by ?? detail.material.owner.displayName}上传的新版本` : `${by ?? "Agent"}让 Agent 改的`} · {date(detail.revision.at)}</small></div>;
}
