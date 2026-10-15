"use client";

import { useEffect, useRef, useState } from "react";
import s from "@/styles/meeting-workspace.module.css";
import { materialTitle } from "@/lib/displayText";

/** 会前材料（meetings.materials）的只读预览：材料页签和「依据」抽屉共用。 */

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

export type MaterialPreview =
  | { state: "idle" | "loading" }
  | { state: "ready"; kind: "pdf"; url: string }
  | { state: "ready"; kind: "html" | "text"; content: string }
  | { state: "error"; error: string };

/** 一份材料的只读预览（材料页签里）：PDF 原样、DOCX 清洗 HTML、MD 纯文本；底下一行出处与下载。任何状态都不含编辑。 */
export function MaterialPane({ meetingId, material, preview, provenance = "" }: { meetingId: string; material: MaterialMeta; preview: MaterialPreview; provenance?: string }) {
  return (
    <div className={s.readerPane} aria-live="polite">
      {preview.state === "loading" || preview.state === "idle" ? <p className={s.empty}>预览加载中…</p> : null}
      {preview.state === "error" ? <p className={s.error} role="alert">{preview.error}</p> : null}
      {preview.state === "ready" && preview.kind === "pdf" ? <iframe className={s.readerFrame} src={preview.url} title={`${materialTitle(material.fileName)} 预览`} /> : null}
      {preview.state === "ready" && preview.kind === "html" ? (
        <iframe
          className={s.readerFrame}
          sandbox=""
          title={`${materialTitle(material.fileName)} 预览`}
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.8 -apple-system,system-ui,sans-serif;color:#282c32;padding:18px;max-width:44em;margin:0 auto}</style>${preview.content}`}
        />
      ) : null}
      {preview.state === "ready" && preview.kind === "text" ? <pre className={s.readerText}>{preview.content}</pre> : null}
      <p className={s.readerPaneFoot}>
        <span className={s.readerBadge}>{MIME_BADGE[material.mimeType] ?? "文件"}</span>
        <span>
          {materialTitle(material.fileName)} · {materialMeta(material)}
          {provenance}
        </span>
        <a href={`/api/meetings/${meetingId}/materials/${material.id}/download`} aria-label={`下载 ${materialTitle(material.fileName)}`}>
          下载原件
        </a>
      </p>
    </div>
  );
}

/** 读一份会前材料的预览；换材料或离开时取消请求、回收 PDF 的 object URL。materialId 为空时不读。 */
export function useMaterialPreview(meetingId: string, materialId: string | null | undefined): MaterialPreview {
  const [preview, setPreview] = useState<MaterialPreview>({ state: "idle" });
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!materialId) return;
    const controller = new AbortController();
    setPreview({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/meetings/${meetingId}/materials/${materialId}/preview`, {
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
  }, [meetingId, materialId]);
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );
  return preview;
}
