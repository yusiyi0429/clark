"use client";

/**
 * 新建一次记忆导入（7a-3）：ChatGPT 的记忆只能复制粘贴；Claude 的可以粘贴，也可以上传导出包（zip / memories json）。
 * 粘贴框不写占位说明，只有一个粘贴图标；「复制提示词」把让对方 AI 逐条列出记忆的提示词放进剪贴板，原文折叠，点开才看得到（界面上唯一的引导文字）。
 * 提交后回调 onCreated，由宿主切到确认组件（MemoryImportReview）。
 */

import { useRef, useState, type DragEvent } from "react";
import { HeroButton } from "@/components/HeroButton";
import { ArrowUpRight, Check, ChevronDown, ClipboardPaste, Copy, FileUp, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { MEMORY_EXPORT_PROMPT, SOURCE_HOME, SOURCE_LABEL, textFile, uploadFile, type ImportFile, type MemoryImport } from "./memoryModel";
import s from "./memory.module.css";

type Source = "chatgpt" | "claude";
const ACCEPT = ".zip,.json,.md,.txt";
const MAX_PASTE = 64 * 1024;

const size = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字` : `${chars} 字`);

export function MemoryImportPanel({ onCreated }: { onCreated: (created: MemoryImport) => void }) {
  const [source, setSource] = useState<Source>("chatgpt");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const ready = Boolean(text.trim() || files.length) && text.length <= MAX_PASTE;

  const copy = async () => {
    try { await navigator.clipboard.writeText(MEMORY_EXPORT_PROMPT); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setShowPrompt(true); }
  };
  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    setFiles((current) => [...current, ...[...list].filter((file) => /\.(zip|json|md|txt)$/i.test(file.name) && !current.some((item) => item.name === file.name))]);
  };
  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); if (source === "claude") addFiles(event.dataTransfer.files); };
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const payload: ImportFile[] = [];
      if (text.trim()) payload.push(await textFile("paste-1.txt", text));
      for (const file of files) payload.push(await uploadFile(file));
      const { data, response } = await browserApi.POST("/api/me/memory/imports", { body: { source, files: payload } });
      if (!data) { setError(response.status === 413 ? "文件太大" : response.status === 400 ? "读不出来" : "没导入成功"); return; }
      setText("");
      setFiles([]);
      onCreated(data);
    } catch {
      setError("没导入成功");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.panel}>
      <SegmentedSwitch label="来源" selected={source} onSelect={(next) => { setSource(next); setFiles([]); }}
        segments={[{ id: "chatgpt", label: "ChatGPT" }, { id: "claude", label: "Claude" }]} />
      <div className={s.promptBar}>
        <HeroButton variant="tertiary" size="sm" onPress={() => void copy()}>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}{copied ? "已复制" : "复制提示词"}
        </HeroButton>
        <button type="button" className={s.disclose} aria-expanded={showPrompt} aria-label="提示词原文" onClick={() => setShowPrompt(!showPrompt)}>
          <ChevronDown size={16} aria-hidden />
        </button>
        <a className={s.outLink} href={SOURCE_HOME[source]} target="_blank" rel="noreferrer">{SOURCE_LABEL[source]}<ArrowUpRight size={14} aria-hidden /></a>
      </div>
      {showPrompt ? <pre className={s.prompt} data-memory-prompt="">{MEMORY_EXPORT_PROMPT}</pre> : null}
      <div className={s.pasteBox} data-dragging={dragging ? "" : undefined}
        onDragOver={(event) => { if (source === "claude") { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <textarea aria-label="粘贴" value={text} onChange={(event) => setText(event.target.value)} rows={7} spellCheck={false} />
        {!text ? <ClipboardPaste className={s.pasteIcon} size={22} strokeWidth={1.6} aria-hidden /> : null}
        <div className={s.pasteFoot}>
          {text ? <span className={s.meta} data-over={text.length > MAX_PASTE ? "" : undefined}>{size(text.length)}{text.length > MAX_PASTE ? " · 64k 上限" : ""}</span> : <span />}
          {source === "claude" ? (
            <>
              <input ref={picker} type="file" accept={ACCEPT} multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
              <HeroButton variant="ghost" size="sm" isIconOnly aria-label="上传导出文件" onPress={() => picker.current?.click()}><FileUp size={16} aria-hidden /></HeroButton>
            </>
          ) : null}
        </div>
      </div>
      {files.length ? (
        <ul className={s.fileList}>
          {files.map((file) => (
            <li key={file.name}>
              <span>{file.name}</span><small>{(file.size / 1024).toFixed(file.size < 10_240 ? 1 : 0)} KB</small>
              <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(files.filter((item) => item !== file))}><X size={14} aria-hidden /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={s.reviewBar}>
        {error ? <span className={s.error} role="alert">{error}</span> : null}
        <HeroButton variant="primary" size="sm" isDisabled={!ready || busy} onPress={() => void submit()}>{busy ? "导入中…" : "导入"}</HeroButton>
      </div>
    </div>
  );
}
