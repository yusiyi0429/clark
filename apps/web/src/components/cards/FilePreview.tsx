"use client";

/**
 * 子会话页右边的文件预览（设计 17.2 第 41 条，照 Claude Code 右边的预览）：顶上文件名和关闭，Esc 关；手持上整屏。
 * 能看的：Markdown（排好版）、纯文本和代码（等宽）、图片；HTML 当文本看，不执行；别的类型只给文件名、大小和「打开」。
 * 内容从哪来由 PreviewFile.load 定：交出的产出读云端那份（cloudOutputFile，手机和别的电脑上也能看）；
 * 本会话改过的文件、回答里提到的路径向这台电脑的本机程序读（localSessionFile，只读得到本会话的文件夹或工作树里的）。
 *
 * 本会话改过的文件（localChangedFile，设计第 72 条第一步）：先读改动，有明细就照示意画——页头只有文件名、「改动」开关、放大 / 缩小、关闭；
 * 正文是全文，改过的地方标出来（ChangeDoc）。只知道改过（detail none）、读不到改动的，照上面的样子看文件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { TLocalOutputView, TLocalSessionRestoreResponse } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { ICON } from "@/components/home/StateIcon";
import { sizeText } from "@/lib/home/attachments";
import type { DiffMode, FileChanges } from "@/lib/local/fileChanges";
import { LocalRunnerError, fileChanged, type LocalRunner } from "@/lib/local/runner";
import { filesRestored } from "@/lib/local/sessionFiles";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { showWorkspaceToast } from "@/lib/toast";
import { ChangeDoc } from "./ChangeDoc";
import s from "@/styles/v2-session.module.css";
import ts from "@/styles/conversation-transcript.module.css";
import c from "@/styles/change-view.module.css";

export type PreviewKind = "markdown" | "text" | "image" | "other";
/** 读到的内容。truncated：文本太长只给了前面一截（本机最多 1 MB）；size 是读到才知道的文件大小。 */
export type PreviewContent =
  | { kind: "markdown" | "text"; text: string; truncated?: boolean; size?: number }
  | { kind: "image"; url: string; /** 用完要放掉的（blob 地址）。 */ revoke?: () => void; size?: number }
  | { kind: "other"; size?: number };

/**
 * 这个文件的改动（第 72 条）：看哪一段时间由从哪打开定（对话里那一行看那一轮，右栏看开工到现在）。
 * restore 恢复其中几处，回新的读结果；restoreFile 恢复整个文件（第 71 条，右栏清单里能恢复的才有）。
 */
export type PreviewChanges = {
  load: () => Promise<FileChanges>;
  restore: (ids: string[], revision: string | null) => Promise<FileChanges>;
  restoreFile?: () => Promise<TLocalSessionRestoreResponse>;
};

export type PreviewFile = {
  /** 同一个文件再点一次不重读。 */
  key: string;
  name: string;
  size: number | null;
  /** 新开一页看原文件的地址；没有就不给「打开」（本机的文件没有）。 */
  openHref: string | null;
  /** 不用读就知道的（云端那份认不出类型、太大的：只给文件名、大小和「打开」）。 */
  instant?: PreviewContent;
  load: () => Promise<PreviewContent>;
  changes?: PreviewChanges;
};

/** 云端那份：文本一次最多读这么大，再大的只给文件名、大小和「打开」；图片同理。 */
export const PREVIEW_TEXT_MAX = 1024 * 1024;
export const PREVIEW_IMAGE_MAX = 20 * 1024 * 1024;

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "json", "jsonl", "yml", "yaml", "toml", "ini", "xml", "html", "htm", "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "cs", "php", "sh", "bash", "ps1", "bat", "sql", "diff", "patch", "vue", "svelte", "lua", "r"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/javascript", "application/x-sh", "application/x-yaml", "application/yaml", "application/toml"]);

/** 云端那份按扩展名认，认不出再看类型；超过上限的算「别的」。HTML 归文本。（本机读的由本机程序认。） */
export function previewKind(name: string, mime: string | null, size: number | null = null): PreviewKind {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const type = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  const kind: PreviewKind = MARKDOWN_EXT.has(ext) || type === "text/markdown" ? "markdown"
    : IMAGE_EXT.has(ext) || type.startsWith("image/") ? "image"
    : TEXT_EXT.has(ext) || type.startsWith("text/") || TEXT_MIME.has(type) ? "text" : "other";
  if (size !== null && kind !== "other" && size > (kind === "image" ? PREVIEW_IMAGE_MAX : PREVIEW_TEXT_MAX)) return "other";
  return kind;
}

/**
 * 点改过的地方出哪个恢复（主会话 11/11 定：点了就出能做的那个）：一轮正在跑什么都不出；
 * Word、Excel 转出来的、整份新建或删掉的出「恢复整个文件」（右栏清单里能恢复的才有）；
 * 文本类本机说能按处恢复（restorable）才出「恢复」——看更早一轮、之后文件又改过的不出。
 */
export function restoreKind(diff: Pick<FileChanges, "detail" | "change" | "restorable">, canRestore: boolean, wholeFile: boolean): "some" | "whole" | null {
  if (!canRestore) return null;
  if (diff.detail === "converted" || diff.change !== "modified") return wholeFile ? "whole" : null;
  return diff.restorable ? "some" : null;
}

/** 表格文件（Excel 转出来的）：格子不折行，表太宽就横向滚。 */
const SHEET_EXT = /\.(xlsx|xlsm|xls)$/i;

/** 改动按哪种画：Markdown 文件和 Word、Excel 转出来的按 Markdown 排，别的（纯文本、代码、CSV）等宽。 */
export const diffMode = (data: Pick<FileChanges, "path" | "detail">): DiffMode =>
  data.detail === "converted" || previewKind(data.path, null) === "markdown" ? "markdown" : "text";

/** 交出的产出在云端那份（GET /api/me/local-outputs/:id，本人才读得到）。 */
export function cloudOutputFile(output: Pick<TLocalOutputView, "id" | "title" | "fileName" | "mimeType" | "sizeBytes">): PreviewFile {
  const href = `/api/me/local-outputs/${encodeURIComponent(output.id)}`;
  const name = output.fileName ?? output.title;
  const kind = previewKind(name, output.mimeType, output.sizeBytes);
  return {
    key: `output:${output.id}`, name, size: output.sizeBytes, openHref: href, ...(kind === "other" ? { instant: { kind } } : {}),
    load: async (): Promise<PreviewContent> => {
      if (kind === "other") return { kind };
      const response = await fetch(href);
      if (!response.ok) throw new Error(response.status === 404 ? "找不到这份产出" : "没读到");
      const blob = await response.blob();
      // 云端没报大小的（老产出）读到了才知道：超过上限同样只给「打开」。
      if (blob.size > (kind === "image" ? PREVIEW_IMAGE_MAX : PREVIEW_TEXT_MAX)) return { kind: "other", size: blob.size };
      if (kind === "image") { const url = URL.createObjectURL(blob); return { kind, url, revoke: () => URL.revokeObjectURL(url), size: blob.size }; }
      return { kind, text: await blob.text(), size: blob.size };
    },
  };
}

/** 这台电脑上本会话的一个文件（POST /v1/sessions/:id/files/read）：path 是相对会话根的路径或绝对路径；类型、大小、截没截断由本机程序说。 */
export function localSessionFile(runner: Pick<LocalRunner, "readSessionFile">, sessionId: string, path: string): PreviewFile {
  return {
    key: `local:${sessionId}:${path}`, name: path.replace(/\\/g, "/").split("/").pop() || path, size: null, openHref: null,
    load: async (): Promise<PreviewContent> => {
      const file = await runner.readSessionFile(sessionId, { path });
      if (file.kind === "other" || file.content === null) return { kind: "other", size: file.size };
      if (file.kind === "image") return { kind: "image", url: `data:${file.mimeType};base64,${file.content}`, size: file.size };
      return { kind: file.kind, text: file.content, truncated: file.truncated, size: file.size };
    },
  };
}

/**
 * 本会话改过的一个文件，打开先看改动：从对话里那一行打开看那一轮（给轮号），从右栏「改动的文件」打开看开工到现在。
 * wholeFile：右栏清单里这个文件能恢复（restorable），点改动时可以出「恢复整个文件」。恢复以后叫一声，清单和对话那一行重读。
 */
export function localChangedFile(runner: Pick<LocalRunner, "readSessionFile" | "readFileChanges" | "restoreFileChanges" | "restoreSessionFiles">, sessionId: string, path: string,
  { turn, wholeFile = false }: { turn?: number; wholeFile?: boolean } = {}): PreviewFile {
  const file = localSessionFile(runner, sessionId, path);
  const where = turn ? { range: "turn" as const, turn } : { range: "session" as const };
  return {
    ...file, key: `${file.key}:${turn ?? "session"}`,
    changes: {
      load: () => runner.readFileChanges(sessionId, { path, ...where }),
      restore: async (ids, revision) => { const result = await runner.restoreFileChanges(sessionId, { path, ...where, ids, revision }); filesRestored(sessionId); return result.file; },
      ...(wholeFile ? { restoreFile: async () => { const result = await runner.restoreSessionFiles(sessionId, { paths: [path] }); filesRestored(sessionId); return result; } } : {}),
    },
  };
}

/** 恢复没成时写的那句：一轮正在跑（409），别的。 */
const failText = (error: unknown) => (error instanceof LocalRunnerError && error.status === 409 ? "这一轮还在跑" : "没恢复成");

/**
 * 恢复其中几处，回写给人看的那句（成了为 null）：成了照本机回的新读结果重画（show）；文件又变了（revision 对不上）重读，让本人重新看；
 * 一轮正在跑（409）、别的错不重读。
 */
export async function restoreChanges(changes: Pick<PreviewChanges, "restore">, ids: string[], revision: string | null, show: (next: FileChanges) => void, reload: () => Promise<unknown>): Promise<string | null> {
  try { show(await changes.restore(ids, revision)); return null; }
  catch (error) {
    if (fileChanged(error)) { await reload(); return "文件又变了"; }
    return failText(error);
  }
}

/** 恢复整个文件，回写给人看的那句（成了为 null，重读）：恢复不了的照本机回的原因写（文件被占用）。 */
export async function restoreWholeFile(changes: Pick<PreviewChanges, "restoreFile">, reload: () => Promise<unknown>): Promise<string | null> {
  if (!changes.restoreFile) return null;
  try {
    const result = await changes.restoreFile();
    if (result.failed.length) return result.failed[0]!.message;
  } catch (error) { return failText(error); }
  await reload();
  return null;
}

/**
 * canRestore：点改动出不出「恢复」（一轮正在跑时为 false）。
 * wide / onWide：放大占满子会话页的内容区（对话收起）；不给 onWide 不出这个按钮（手持上本来就是整屏）。
 */
export function FilePreview({ file, onClose, canRestore = true, wide = false, onWide }: {
  file: PreviewFile; onClose: () => void; canRestore?: boolean; wide?: boolean; onWide?: (wide: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<PreviewContent | null>(file.instant ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** 读到的改动：undefined 还在读（或没有改动可读），null 没有明细，照普通文件看。 */
  const [diff, setDiff] = useState<FileChanges | null | undefined>(file.changes ? undefined : null);
  const [marks, setMarks] = useState(true);
  const root = useRef<HTMLElement>(null);
  const show = useCallback((next: FileChanges) => setDiff(next.detail === "none" ? null : next), []);
  const reloadDiff = useCallback(async () => {
    if (!file.changes) return;
    try { show(await file.changes.load()); }
    catch { setDiff(null); }
  }, [file.changes, show]);
  useEffect(() => {
    setMarks(true);
    if (!file.changes) { setDiff(null); return; }
    let alive = true;
    setDiff(undefined);
    file.changes.load().then((next) => { if (alive) show(next); }, () => { if (alive) setDiff(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换了文件才重读
  }, [file.key]);
  const plain = diff === null;
  useEffect(() => {
    if (!plain) return;
    setFailed(null);
    if (file.instant) { setLoaded(file.instant); return; }
    let alive = true;
    let got: PreviewContent | null = null;
    const drop = (content: PreviewContent | null) => { if (content?.kind === "image") content.revoke?.(); };
    setLoaded(null);
    void file.load().then((content) => { if (alive) { got = content; setLoaded(content); } else drop(content); },
      (error: unknown) => { if (alive) setFailed(error instanceof Error ? error.message : ""); });
    return () => { alive = false; drop(got); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换了文件或点了重试才重读
  }, [file.key, attempt, plain]);
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

  const kind = diff ? restoreKind(diff, canRestore, !!file.changes?.restoreFile) : null;
  const restore = async (ids: string[]) => {
    if (!diff || !file.changes) return;
    const failed = kind === "whole" ? await restoreWholeFile(file.changes, reloadDiff) : await restoreChanges(file.changes, ids, diff.revision, show, reloadDiff);
    if (failed) showWorkspaceToast({ text: failed });
    // 新建的恢复了就是删掉了：没有可看的，关掉预览。
    else if (kind === "whole" && diff.change === "added") onClose();
  };

  const size = file.size ?? loaded?.size ?? null;
  const open = file.openHref ? <a href={file.openHref} target="_blank" rel="noopener" className={s.link}>打开</a> : null;
  // 有改动、文件还在时出「改动」开关；删掉的文件只有改动那一份，不出开关。
  const toggle = diff && !!diff.changes?.length && diff.after !== null;
  const zoom = onWide ? (
    <HeroButton variant="ghost" size="sm" isIconOnly aria-label={wide ? "缩小" : "放大"} title={wide ? "缩小" : "放大"} onPress={() => onWide(!wide)} data-testid="file-preview-zoom">
      {wide ? <Minimize2 {...ICON} /> : <Maximize2 {...ICON} />}
    </HeroButton>
  ) : null;
  return (
    <aside ref={root} className={s.preview} aria-label={file.name} tabIndex={-1} data-testid="file-preview" data-kind={diff ? "changes" : loaded?.kind} data-wide={wide ? "" : undefined}>
      <header className={s.previewHead}>
        <b title={file.name}>{file.name}</b>
        {plain && size !== null ? <small>{sizeText(size)}</small> : null}
        {plain && loaded && "truncated" in loaded && loaded.truncated ? <small data-testid="file-preview-truncated">已截断</small> : null}
        <span className={s.previewGap} />
        {toggle ? <button type="button" className={c.toggle} aria-pressed={marks} onClick={() => setMarks(!marks)} data-testid="file-preview-marks">改动</button> : null}
        {plain && loaded && loaded.kind !== "other" ? open : null}
        {zoom}
        <HeroButton variant="ghost" size="sm" isIconOnly aria-label="关闭" title="关闭" onPress={onClose} data-testid="file-preview-close"><X {...ICON} /></HeroButton>
      </header>
      {diff ? (
        <ChangeDoc data={diff} mode={diffMode(diff)} marks={marks} restore={kind} onRestore={restore}
          bodyClass={s.previewBody} docClass={`${diffMode(diff) === "markdown" ? `${ts.prose} ${s.md} ${s.previewDoc}` : s.previewDoc}${SHEET_EXT.test(diff.path) ? ` ${c.sheet}` : ""}`} />
      ) : (
        <div className={s.previewBody} aria-busy={diff === undefined || (!loaded && failed === null) ? true : undefined}>
          {diff === undefined ? null
            : failed !== null ? <FailedLine reason={failed} onRetry={() => setAttempt((n) => n + 1)} />
            : !loaded ? null
            : loaded.kind === "markdown" ? <article className={`${ts.prose} ${s.md} ${s.previewDoc}`}><Markdown remarkPlugins={REMARK_PLUGINS}>{loaded.text}</Markdown></article>
            : loaded.kind === "text" ? <pre className={s.previewCode}>{loaded.text}</pre>
            // eslint-disable-next-line @next/next/no-img-element -- 本人自己的文件，读成 blob 或 data 地址再显示
            : loaded.kind === "image" ? <img className={s.previewImage} src={loaded.url} alt={file.name} />
            : <p className={s.previewOther}>{open}</p>}
        </div>
      )}
    </aside>
  );
}
