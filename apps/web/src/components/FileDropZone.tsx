"use client";

/**
 * 能接文件的区域：拖着文件进窗口时亮虚线框；拖到这块上方时整块高亮，写「松开上传」；松手交给 onFile（只取第一份）。
 * 上传中写「上传中…」，传失败的原因由外面显示。disabled 时就是普通容器。
 */
import { useState, type DragEvent, type ReactNode } from "react";
import { useFileDrag } from "@/lib/useFileDrag";
import s from "@/styles/file-drop-zone.module.css";

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

export function FileDropZone({ onFile, disabled = false, busy = false, className, children }: {
  onFile: (file: File) => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const dragging = useFileDrag();
  const [over, setOver] = useState(false);
  const live = !disabled && !busy;
  const state = busy ? "busy" : !live || !dragging ? undefined : over ? "over" : "ready";
  return (
    <div
      className={[s.zone, className].filter(Boolean).join(" ")}
      data-drop={state}
      onDragOver={live ? (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      } : undefined}
      onDragLeave={live ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      } : undefined}
      onDrop={live ? (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      } : undefined}
    >
      {children}
      {state === "over" || state === "busy" ? <span className={s.hint} role="status">{state === "busy" ? "上传中…" : "松开上传"}</span> : null}
    </div>
  );
}
