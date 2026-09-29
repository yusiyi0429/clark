"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TMaterialDetailResponse, TMaterialView } from "@warmap/contracts";
import { InHeader, MaterialMenu, useRememberedScroll, type MaterialTab } from "@/components/shell/MaterialTabs";
import { useConfirm } from "@/components/ConfirmDialog";
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
  }, [base, material?.id, material?.version, version]);
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
      base={base} onRemove={remove} onVersion={setVersion} />{dialog}</div>
      : groupTab && selected === groupTab.id ? <div className={s.groupList}>
        {materials.length ? <ul>{materials.map((item) => <li key={item.id}><button type="button" onClick={() => choose(item.id)}>{item.fileName}</button></li>)}</ul>
          : <p className={s.empty}>还没有群组材料，从材料下拉单里的「添加材料」上传。</p>}
      </div> : children}
  </div>;
}

export function MaterialReader({ material, detail, base, onRemove, onVersion }:
  { material: TMaterialView; detail: TMaterialDetailResponse | null; base: string; onRemove: () => void; onVersion: (version?: number) => void }) {
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [html, setHtml] = useState("");
  const [changes, setChanges] = useState(false);
  useEffect(() => { setChanges(false); }, [material.id, detail?.version]);
  useEffect(() => {
    if (material.format !== "docx") return;
    let active = true;
    void fetch(`${base}/${material.id}/preview`).then((response) => response.text()).then((value) => { if (active) setHtml(value); });
    return () => { active = false; };
  }, [base, material.id, material.format, material.version]);
  const by = detail?.revision.requestedBy?.displayName ?? material.owner.displayName;
  const changeCount = detail?.blocks?.filter((block) => block.change !== null).length ?? 0;
  const htmlChanges = <button type="button" onClick={() => setChanges((value) => !value)} aria-expanded={changes}>{changeCount} 处</button>;
  return <article className={s.document} aria-label={material.fileName}>
    <p className={s.meta}>{material.origin === "agent" ? `Agent 按${material.owner.displayName}的要求写` : `${material.owner.displayName} 上传`} · {date(material.createdAt)}
      <a href={`${base}/${material.id}/file`}>下载</a>{material.canDelete ? <button type="button" onClick={() => void onRemove()}>删除</button> : null}</p>
    {material.format !== "markdown" && material.format !== "html" ? <p className={s.readOnly}>只读 · 只有 Markdown 和 HTML 能让 Agent 修改</p> : null}
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
      : material.format === "html" ? <iframe className={s.frame} sandbox="allow-scripts" src={`${base}/${material.id}/preview?version=${detail.version}`} title={`${material.fileName} 预览`} />
      : material.format === "docx" ? <iframe className={s.frame} sandbox="" title={`${material.fileName} 预览`} srcDoc={html} />
      : <div className={s.markdown}>{detail.blocks?.map((block, index, blocks) => {
        const listItem = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(block.text);
        if (listItem && block.change?.kind !== "modified") {
          const previous = blocks[index - 1];
          if (previous && /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(previous.text) && previous.change?.kind !== "modified") return null;
          let end = index + 1;
          while (end < blocks.length && /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(blocks[end].text)
            && blocks[end].change?.kind !== "modified") end++;
          return <div key={index} className={s.block}><Markdown remarkPlugins={[remarkGfm]}>{blocks.slice(index, end).map((item) => item.text).join("\n")}</Markdown></div>;
        }
        if (block.change?.kind === "removed") return <div key={index} className={s.block} onMouseLeave={() => setOpen(null)}><button type="button" className={s.removed} onMouseEnter={() => setOpen(index)} onFocus={() => setOpen(index)} onClick={() => setOpen(open === index ? null : index)} aria-label="查看删掉的原文">⋯</button>
          {open === index ? <ChangePopup before={block.change.before} detail={detail} /> : null}</div>;
        if (block.change?.kind === "modified" && hasMarkdownSyntax(block.text)) return <div key={index} className={s.block} onMouseLeave={() => setOpen(null)}>
          <div className={s.formattedChange} role="button" tabIndex={0} aria-label="查看修改前的原文"
            onMouseEnter={() => setOpen(index)} onFocus={() => setOpen(index)}
            onClick={() => setOpen(open === index ? null : index)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === index ? null : index); } }}>
            <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
          </div>{open === index ? <ChangePopup before={block.change.before} detail={detail} /> : null}</div>;
        if (block.change?.kind === "modified") return <div key={index} className={`${s.block} ${s.plain}`} onMouseLeave={() => setOpen(null)}>
          {block.change.spans.map((span, part) => span.changed ? <button key={part} type="button" className={s.changed}
            title={`原来：${block.change?.kind === "modified" ? block.change.before : ""}`} onMouseEnter={() => setOpen(index)} onFocus={() => setOpen(index)} onClick={() => setOpen(open === index ? null : index)}>{span.text}</button> : <span key={part}>{span.text}</span>)}
          {open === index ? <ChangePopup before={block.change.before} detail={detail} /> : null}</div>;
        return <div key={index} className={s.block}><Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown></div>;
      })}</div>}
  </article>;
}
function ChangePopup({ before, detail }: { before: string; detail: TMaterialDetailResponse }) {
  return <div className={s.popup} role="note"><span>原来：{before}</span><small>{detail.revision.requestedBy?.displayName ?? "Agent"}让 Agent 改的 · {date(detail.revision.at)}</small></div>;
}
