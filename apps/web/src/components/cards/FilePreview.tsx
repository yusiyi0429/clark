"use client";

/**
 * 子会话页右边的文件预览（设计 17.2 第 41 条，照 Claude Code 右边的预览）：顶上文件名和关闭，Esc 关；手持上整屏。
 * 能看的：Markdown（排好版）、纯文本和代码（等宽）、图片；HTML 当文本看，不执行；别的类型只给文件名、大小和「打开」。
 * 内容从哪来由 PreviewFile.load 定：现在是交出的产出在云端那份（cloudOutputFile）；本机读的文件（D 的契约到了以后）给同一个形状就能用。
 */
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { X } from "lucide-react";
import type { TLocalOutputView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { ICON } from "@/components/home/StateIcon";
import { sizeText } from "@/lib/home/attachments";
import { REMARK_PLUGINS } from "@/lib/markdown";
import s from "@/styles/v2-session.module.css";

export type PreviewFile = {
  /** 同一个文件再点一次不重读。 */
  key: string;
  name: string;
  size: number | null;
  mime: string | null;
  /** 新开一页看原文件的地址；没有就不给「打开」。 */
  openHref: string | null;
  load: () => Promise<Blob>;
};

export type PreviewKind = "markdown" | "text" | "image" | "other";

/** 文本一次最多读这么大，再大的只给文件名、大小和「打开」；图片同理。 */
export const PREVIEW_TEXT_MAX = 1024 * 1024;
export const PREVIEW_IMAGE_MAX = 20 * 1024 * 1024;

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "json", "jsonl", "yml", "yaml", "toml", "ini", "xml", "html", "htm", "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "cs", "php", "sh", "bash", "ps1", "bat", "sql", "diff", "patch", "vue", "svelte", "lua", "r"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/javascript", "application/x-sh", "application/x-yaml", "application/yaml", "application/toml"]);

/** 按扩展名认，认不出再看类型；超过上限的算「别的」。HTML 归文本。 */
export function previewKind(name: string, mime: string | null, size: number | null = null): PreviewKind {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const type = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  const kind: PreviewKind = MARKDOWN_EXT.has(ext) || type === "text/markdown" ? "markdown"
    : IMAGE_EXT.has(ext) || type.startsWith("image/") ? "image"
    : TEXT_EXT.has(ext) || type.startsWith("text/") || TEXT_MIME.has(type) ? "text" : "other";
  if (size !== null && kind !== "other" && size > (kind === "image" ? PREVIEW_IMAGE_MAX : PREVIEW_TEXT_MAX)) return "other";
  return kind;
}

/** 交出的产出在云端那份（GET /api/me/local-outputs/:id，本人才读得到）。 */
export function cloudOutputFile(output: Pick<TLocalOutputView, "id" | "title" | "fileName" | "mimeType" | "sizeBytes">): PreviewFile {
  const href = `/api/me/local-outputs/${encodeURIComponent(output.id)}`;
  return {
    key: `output:${output.id}`, name: output.fileName ?? output.title, size: output.sizeBytes, mime: output.mimeType, openHref: href,
    load: async () => {
      const response = await fetch(href);
      if (!response.ok) throw new Error(response.status === 404 ? "找不到这份产出" : "没读到");
      return response.blob();
    },
  };
}

type Loaded = { kind: "markdown" | "text"; text: string } | { kind: "image"; url: string } | { kind: "other" };

export function FilePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const kind = previewKind(file.name, file.mime, file.size);
  const [loaded, setLoaded] = useState<Loaded | null>(kind === "other" ? { kind } : null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (kind === "other") { setLoaded({ kind }); setFailed(null); return; }
    let alive = true, url: string | null = null;
    setLoaded(null);
    setFailed(null);
    void file.load().then(async (blob) => {
      // 云端没报大小的（老产出）读到了才知道：超过上限同样只给「打开」。
      if (blob.size > (kind === "image" ? PREVIEW_IMAGE_MAX : PREVIEW_TEXT_MAX)) { if (alive) setLoaded({ kind: "other" }); return; }
      if (kind === "image") { url = URL.createObjectURL(blob); if (alive) setLoaded({ kind, url }); else URL.revokeObjectURL(url); return; }
      const text = await blob.text();
      if (alive) setLoaded({ kind, text });
    }, (error: unknown) => { if (alive) setFailed(error instanceof Error ? error.message : ""); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换了文件或点了重试才重读
  }, [file.key, kind, attempt]);
  // 打开时焦点进预览；Esc 关（焦点在输入框、菜单、弹层里时归它们自己）。抢在新首页「Esc 回首页」之前接住。
  useEffect(() => { root.current?.focus(); }, [file.key]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"], [role=dialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const open = file.openHref ? <a href={file.openHref} target="_blank" rel="noopener" className={s.link}>打开</a> : null;
  return (
    <aside ref={root} className={s.preview} aria-label={file.name} tabIndex={-1} data-testid="file-preview" data-kind={loaded?.kind ?? kind}>
      <header className={s.previewHead}>
        <b title={file.name}>{file.name}</b>
        {file.size !== null ? <small>{sizeText(file.size)}</small> : null}
        <span className={s.previewGap} />
        {loaded && loaded.kind !== "other" ? open : null}
        <HeroButton variant="ghost" size="sm" isIconOnly aria-label="关闭" title="关闭" onPress={onClose} data-testid="file-preview-close"><X {...ICON} /></HeroButton>
      </header>
      <div className={s.previewBody} aria-busy={!loaded && !failed ? true : undefined}>
        {failed !== null ? <FailedLine reason={failed} onRetry={() => setAttempt((n) => n + 1)} />
          : !loaded ? null
          : loaded.kind === "markdown" ? <article className={`${s.md} ${s.previewDoc}`}><Markdown remarkPlugins={REMARK_PLUGINS}>{loaded.text}</Markdown></article>
          : loaded.kind === "text" ? <pre className={s.previewCode}>{loaded.text}</pre>
          // eslint-disable-next-line @next/next/no-img-element -- 本人自己的文件，读成 blob 再显示
          : loaded.kind === "image" ? <img className={s.previewImage} src={loaded.url} alt={file.name} />
          : <p className={s.previewOther}>{open}</p>}
      </div>
    </aside>
  );
}
