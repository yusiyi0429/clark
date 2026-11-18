"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, FileText, Paperclip, X } from "lucide-react";
import type { TTeamDeliverySource } from "@warmap/contracts";
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_COUNT, admit, fileNameOf, sizeText } from "@/lib/home/attachments";
import { monthDayTime } from "@/lib/companyTime";
import { listTeamSources, teamError } from "@/lib/home/teamDelivery";
import s from "./partnerTeam.module.css";

export type TeamFiles = { files: File[]; sources: TTeamDeliverySource[] };
export const emptyTeamFiles = (): TeamFiles => ({ files: [], sources: [] });

export function TeamFilePicker({ selection, onChange, disabled = false }: {
  selection: TeamFiles; onChange: (value: TeamFiles) => void; disabled?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const sourceSection = useId();
  const [picking, setPicking] = useState(false);
  const [versions, setVersions] = useState<TTeamDeliverySource[] | null>(null);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const count = selection.files.length + selection.sources.length;
  useEffect(() => {
    if (!picking) return;
    let live = true;
    setReadError("");
    void listTeamSources().then((items) => { if (live) setVersions(items); }, (cause) => {
      if (live) setReadError(teamError(cause, "没有读到文件版本"));
    });
    return () => { live = false; };
  }, [picking, attempt]);
  const add = (files: File[]) => {
    const next = admit(count, files);
    setError(next.error ?? "");
    if (next.ok.length) onChange({ ...selection, files: [...selection.files, ...next.ok] });
  };
  const toggle = (source: TTeamDeliverySource) => {
    const selected = selection.sources.some((item) => item.id === source.id);
    if (!selected && count >= ATTACHMENT_MAX_COUNT) { setError("最多 20 个附件"); return; }
    setError("");
    onChange({ ...selection, sources: selected ? selection.sources.filter((item) => item.id !== source.id) : [...selection.sources, source] });
  };
  return (
    <fieldset className={s.files} disabled={disabled}
      onDragOver={(event) => { if (!disabled && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setOver(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); setOver(false); if (!disabled) add([...event.dataTransfer.files]); }}
      onPaste={(event) => { if (!disabled && event.clipboardData.files.length) { event.preventDefault(); add([...event.clipboardData.files]); } }}
      data-over={over || undefined}>
      <legend>附件</legend>
      <input hidden type="file" multiple ref={picker} accept={ATTACHMENT_ACCEPT} onChange={(event) => { add([...(event.target.files ?? [])]); event.target.value = ""; }} />
      <div className={s.fileTools}>
        <button type="button" className={s.linkButton} onClick={() => picker.current?.click()}><Paperclip size={14} aria-hidden />添加本机文件</button>
        <button type="button" className={s.linkButton} aria-expanded={picking} aria-controls={sourceSection} onClick={() => setPicking(!picking)}>选已有文件版本</button>
        <small>{over ? "松开添加" : "也可拖入文件"}</small>
      </div>
      {count > 0 ? <ul className={s.fileList}>
        {selection.files.map((file, i) => <li key={i}><FileText size={14} aria-hidden /><span>{fileNameOf(file)} <small>{sizeText(file.size)}</small></span>
          <button type="button" className={s.icon} aria-label={"移除 " + fileNameOf(file)} onClick={() => onChange({ ...selection, files: selection.files.filter((_, at) => at !== i) })}><X size={14} aria-hidden /></button></li>)}
        {selection.sources.map((source) => <li key={source.id}><Check size={14} aria-hidden /><span>{source.fileName} <small>{monthDayTime(source.createdAt)} · {source.sha256.slice(0, 8)}</small></span>
          <button type="button" className={s.icon} aria-label={"移除 " + source.fileName} onClick={() => toggle(source)}><X size={14} aria-hidden /></button></li>)}
      </ul> : null}
      {picking ? <div id={sourceSection} className={s.choices} aria-label="可分享的文件版本">
        {readError ? <div role="alert">{readError} <button className={s.linkButton} type="button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>
          : !versions ? <small role="status">正在读取文件版本</small> : !versions.length ? <small>没有可分享的子会话文件</small> : versions.map((source) => (
            <label className={s.choice} key={source.id}><input type="checkbox" checked={selection.sources.some((item) => item.id === source.id)} onChange={() => toggle(source)} />
              <span>{source.fileName} <small>{sizeText(source.size)} · {monthDayTime(source.createdAt)} · {source.sha256.slice(0, 8)}</small></span>
            </label>
          ))}
      </div> : null}
      {error ? <p role="alert" className={s.error}>{error}</p> : null}
    </fieldset>
  );
}
