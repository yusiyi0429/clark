"use client";

/**
 * 右栏「改动的文件 N」（17.2 第 41 条；第 71、72 条加恢复）：每个文件一行，标出新建 / 改 / 删，点了在右边看开工到现在的改动。
 * 能恢复的（restorable）给「恢复」，删掉的文件也能恢复；顶上「全部恢复」；恢复过的写「已恢复」。
 * 恢复不了的（文件被占用）照本机回的原因在那一行下面写一句，别的照做。只给执行方直接改的文件留了一份时（undo touched_only），这一组顶上写一行。
 * 一轮正在跑、卡在工作树里做的（canRestore false）不出「恢复」。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TLocalChangedFile, TLocalSessionRestoreResponse, TLocalUndo } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { ICON } from "@/components/home/StateIcon";
import { showWorkspaceToast } from "@/lib/toast";
import s from "@/styles/v2-session.module.css";

export const CHANGE_WORD: Record<NonNullable<TLocalChangedFile["change"]>, string> = { added: "新建", modified: "改", deleted: "删" };
/** 这一组顶上那一行（文字先这样，等主会话定）。 */
export const UNDO_LINE: Partial<Record<TLocalUndo["state"], string>> = { touched_only: "只留了直接改的文件" };

/** 这个文件还能不能点「恢复」：能恢复、这次会话动过以后没恢复过。 */
export const canRestoreFile = (file: TLocalChangedFile) => !!file.restorable && !file.restoredAt;

export function ChangedFiles({ files, undo, canRestore, current, onOpen, onRestore }: {
  files: readonly TLocalChangedFile[]; undo?: TLocalUndo; canRestore: boolean;
  /** 正在右边看的那个文件的 path。 */
  current: string | null;
  /** 点了在右边看；不给（手机、别的电脑上）就不能点。 */
  onOpen?: (path: string) => void;
  onRestore: (paths?: string[]) => Promise<TLocalSessionRestoreResponse>;
}) {
  // 卡在工作树里做的默认收起（同原来）；普通文件夹里做的（带新建 / 改 / 删、能恢复）默认展开。
  const [open, setOpen] = useState(() => files.some((file) => file.change));
  const [busy, setBusy] = useState(false);
  /** 上一次恢复没成的：path → 本机回的原因。 */
  const [failed, setFailed] = useState<Record<string, string>>({});
  const restore = async (paths?: string[]) => {
    setBusy(true);
    try {
      const result = await onRestore(paths);
      setFailed((before) => {
        const next = { ...before };
        for (const path of paths ?? files.map((file) => file.path)) delete next[path];
        for (const entry of result.failed) next[entry.path] = entry.message;
        return next;
      });
    } catch {
      showWorkspaceToast({ text: "没恢复成" });
    } finally { setBusy(false); }
  };
  const restorable = canRestore && files.some(canRestoreFile);
  const note = undo ? UNDO_LINE[undo.state] : undefined;
  return (
    <div className={s.sec} data-testid="changed-files-sec">
      <div className={s.lab}>
        <button type="button" className={s.filesHead} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="changed-files">
          {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}改动的文件 {files.length}
        </button>
        <span className={s.previewGap} />
        {open && restorable ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void restore()} data-testid="restore-all">全部恢复</HeroButton> : null}
      </div>
      {open && note ? <p className={s.faint} data-testid="undo-note">{note}</p> : null}
      {open ? files.map((file) => {
        const word = file.change ? CHANGE_WORD[file.change] : null;
        const name = <span className={s.outTitle}>{file.path}</span>;
        return (
          <div key={file.path} className={s.changedRow} data-testid="changed-file">
            {onOpen ? (
              <button type="button" className={s.output} title={file.path} data-current={current === file.path ? "" : undefined} onClick={() => onOpen(file.path)}>
                {word ? <span className={s.faint}>{word}</span> : null}{name}
                {file.restoredAt ? <span className={s.faint} data-testid="restored">已恢复</span> : null}
              </button>
            ) : (
              <div className={s.output} title={file.path}>{word ? <span className={s.faint}>{word}</span> : null}{name}{file.restoredAt ? <span className={s.faint}>已恢复</span> : null}</div>
            )}
            {canRestore && canRestoreFile(file) ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void restore([file.path])} data-testid="restore-file">恢复</HeroButton> : null}
            {failed[file.path] ? <p className={s.faint} data-testid="restore-failed">{failed[file.path]}</p> : null}
          </div>
        );
      }) : null}
    </div>
  );
}
