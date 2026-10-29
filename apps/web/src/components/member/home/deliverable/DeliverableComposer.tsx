"use client";

/**
 * 传一个新版本：上一版的材料默认沿用（× 去掉），再加文件（点选或拖进来）、贴链接、写一段现状；「评审这一版」交上去就开始评审。
 * 只有这一块用虚线框，表示可以往里放东西。类型和大小先在这里挡一遍，服务端还会再查。
 */
import { useRef, useState, type DragEvent } from "react";
import { Plus, X } from "lucide-react";
import type { TDeliverableVersion } from "@warmap/contracts";
import { itemTag } from "./deliverableFormat";
import d from "@/styles/task-deliverable.module.css";

const ACCEPT = ".pdf,.docx,.md,.html,.htm,.png,.jpg,.jpeg,.webp";
const DOCUMENT = /\.(pdf|docx|md|html?)$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const MAX_ITEMS = 10;
const MAX_LINKS = 5;

/** 这份文件能不能放进来；不能时返回原因。 */
export function fileProblem(file: File): string | null {
  if (!DOCUMENT.test(file.name) && !IMAGE.test(file.name)) return "支持 PDF、Word、Markdown、HTML 和图片";
  if (IMAGE.test(file.name) && file.size > 5 * 1024 * 1024) return "图片不能超过 5 MB";
  if (file.size > 20 * 1024 * 1024) return "单份文件不能超过 20 MB";
  return null;
}

/** 还没传上去的文件前面的小标，和传上去以后一样（itemTag）。 */
function fileTag(name: string): string {
  if (IMAGE.test(name)) return "图";
  if (/\.pdf$/i.test(name)) return "PDF";
  if (/\.docx$/i.test(name)) return "Word";
  return /\.html?$/i.test(name) ? "HTML" : "MD";
}

/** 贴进来的一条链接：要 http(s)；不合规返回 null。 */
export function normalizeLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function DeliverableComposer({ previous, startWithStatement, onSubmit, onCancel }: {
  /** 上一版（新的版本默认沿用它的材料）；第一版为 null。 */
  previous: TDeliverableVersion | null;
  /** 从「说说现状」进来：先打开写现状的框。 */
  startWithStatement: boolean;
  onSubmit: (input: { files: File[]; links: string[]; statement: string; keep: string[] }) => Promise<string | null>;
  onCancel: (() => void) | null;
}) {
  const [keep, setKeep] = useState<string[]>(() => previous?.items.map((item) => item.id) ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [statementOpen, setStatementOpen] = useState(startWithStatement);
  const [statement, setStatement] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const kept = previous?.items.filter((item) => keep.includes(item.id)) ?? [];
  const fileCount = kept.filter((item) => item.kind !== "link").length + files.length;
  const empty = !kept.length && !files.length && !links.length && !statement.trim();

  const addFiles = (picked: File[]) => {
    setError(null);
    const problem = picked.map(fileProblem).find(Boolean);
    if (problem) return setError(problem);
    if (fileCount + picked.length > MAX_ITEMS) return setError(`一版最多 ${MAX_ITEMS} 份文件`);
    setFiles((current) => [...current, ...picked]);
  };
  const addLink = () => {
    const link = normalizeLink(linkDraft);
    if (!link) return setError("链接要以 http:// 或 https:// 开头");
    if (links.includes(link)) { setLinkDraft(""); return; }
    if (links.length + kept.filter((item) => item.kind === "link").length >= MAX_LINKS) return setError(`一版最多 ${MAX_LINKS} 条链接`);
    setError(null);
    setLinks((current) => [...current, link]);
    setLinkDraft("");
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles([...event.dataTransfer.files]);
  };
  const submit = async () => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    const problem = await onSubmit({ files, links, statement: statement.trim(), keep });
    if (problem) { setError(problem); setBusy(false); }
  };

  return (
    <div className={d.composer}>
      {kept.length || files.length || links.length ? (
        <ul className={d.items} aria-label="这一版的材料">
          {kept.map((item) => (
            <li key={item.id} className={d.item}>
              <span className={d.tag}>{itemTag(item)}</span><span className={d.itemName}>{item.name}</span>
              <button type="button" className={d.remove} aria-label={`去掉 ${item.name}`} disabled={busy} onClick={() => setKeep((current) => current.filter((id) => id !== item.id))}><X size={13} aria-hidden="true" /></button>
            </li>
          ))}
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className={d.item} data-new>
              <span className={d.tag}>{fileTag(file.name)}</span>
              <span className={d.itemName}>{file.name}</span>
              <button type="button" className={d.remove} aria-label={`去掉 ${file.name}`} disabled={busy} onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}><X size={13} aria-hidden="true" /></button>
            </li>
          ))}
          {links.map((link) => (
            <li key={link} className={d.item} data-new>
              <span className={d.tag}>链接</span><span className={d.itemName}>{link.replace(/^https?:\/\//, "")}</span>
              <button type="button" className={d.remove} aria-label="去掉这条链接" disabled={busy} onClick={() => setLinks((current) => current.filter((item) => item !== link))}><X size={13} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={d.drop} data-dragging={dragging || undefined}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <span className={d.dropIcon} aria-hidden="true"><Plus size={18} /></span>
        <div className={d.dropButtons}>
          <button type="button" className={d.plain} disabled={busy} onClick={() => picker.current?.click()}>上传文件</button>
          <button type="button" className={d.plain} disabled={busy} onClick={() => setLinkOpen(true)}>粘贴链接</button>
          <button type="button" className={d.plain} disabled={busy} onClick={() => setStatementOpen(true)}>说说现状</button>
        </div>
        <small className={d.dropHint}>PDF · Word · Markdown · HTML · 图片 · 网页链接</small>
        <input ref={picker} type="file" multiple accept={ACCEPT} hidden onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
      </div>
      {linkOpen ? (
        <form className={d.linkRow} onSubmit={(event) => { event.preventDefault(); addLink(); }}>
          <input value={linkDraft} autoFocus inputMode="url" placeholder="https://" aria-label="链接" disabled={busy} onChange={(event) => setLinkDraft(event.target.value)} />
          <button type="submit" className={d.plain} disabled={busy || !linkDraft.trim()}>添加</button>
        </form>
      ) : null}
      {statementOpen ? (
        <textarea className={d.statementInput} value={statement} maxLength={2000} rows={3} autoFocus={startWithStatement || undefined} disabled={busy}
          placeholder="这一版做到了哪一步" aria-label="现状" onChange={(event) => setStatement(event.target.value)} />
      ) : null}
      {error ? <p className={d.error} role="alert">{error}</p> : null}
      <div className={d.composerActions}>
        {onCancel ? <button type="button" className={d.quiet} disabled={busy} onClick={onCancel}>取消</button> : null}
        <button type="button" className={d.primary} disabled={empty || busy} onClick={() => void submit()}>{busy ? "正在上传…" : "评审这一版"}</button>
      </div>
    </div>
  );
}
