"use client";

/**
 * 对话里一轮末尾那一行（设计第 72 条第一步）：这一轮改过文件时出一行淡字「改了 周报.md · 2 处 ›」，不是按钮的样子；
 * 多个文件各一行，超过 3 个收成「改了 5 个文件 ›」（点了展开成各一行）；全部恢复以后写「已恢复」。
 * 点了在右边打开预览，停在第一处：最近一轮的看这一轮，早先几轮的看开工到现在（接口没有轮次编号）。
 * 手机上、别的电脑上（连不上那台电脑的本机程序）：那一行照样出，点了写「在那台电脑上看」。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChangeRange, TurnFile } from "@/lib/local/fileChanges";
import type { SessionEntry } from "@/lib/local/sessionView";
import c from "@/styles/change-view.module.css";

export type TurnFilesView = {
  /** 打开这个文件的改动；null 是这台电脑上看不到（手机、别的电脑）。 */
  open: ((path: string, range: ChangeRange) => void) | null;
  /** 恢复过了（右栏清单里带 restoredAt）。 */
  restored: (path: string) => boolean;
  /** 最近一轮那一行的编号：它看这一轮，早先的看开工到现在。 */
  latest: number | null;
  /** 这一轮这个文件现在还剩几处（恢复了几处以后重读；读不到明细为 null）。只有最近一轮那一行用。 */
  count?: (path: string) => Promise<number | null>;
  /** 恢复过文件就会变（右栏清单重读了）：最近一轮那一行跟着重读剩几处。 */
  version?: unknown;
};
export const TurnFilesContext = createContext<TurnFilesView | null>(null);

/** 对话记录里最近一轮那一行的编号。 */
export const latestFilesSeq = (entries: readonly SessionEntry[]) => entries.reduce<number | null>((last, entry) => (entry.kind === "files" ? entry.seq : last), null);

/** 收成一行的门槛：超过这么多个文件写「改了 N 个文件」。 */
const FOLD_OVER = 3;
const VERB: Record<TurnFile["change"], string> = { added: "新建", modified: "改了", deleted: "删了" };

/** 一个文件那一行的字：几处只在改了的、有明细的文件上写；恢复过的写「已恢复」。 */
export function turnFileText(file: TurnFile, restored: boolean): string {
  const tail = restored || file.changes === 0 ? " · 已恢复" : file.change === "modified" && file.changes !== null ? ` · ${file.changes} 处` : "";
  return `${VERB[file.change]} ${file.path.replace(/\\/g, "/").split("/").pop()}${tail}`;
}

export function TurnFilesLine({ seq, files }: { seq: number; files: TurnFile[] }) {
  const view = useContext(TurnFilesContext);
  const [unfolded, setUnfolded] = useState(false);
  const [away, setAway] = useState<string | null>(null);
  const latest = view?.latest === seq;
  const range: ChangeRange = latest ? "turn" : "session";
  // 最近一轮：恢复过以后重读还剩几处（恢复了一处，「2 处」变「1 处」；都恢复了写「已恢复」）。
  const [left, setLeft] = useState<Record<string, number | null>>({});
  const count = useRef(view?.count);
  count.current = latest ? view?.count : undefined;
  const version = latest ? view?.version : undefined;
  useEffect(() => {
    const read = count.current;
    if (!read || version === undefined) return;
    let alive = true;
    void Promise.all(files.map(async (file) => [file.path, await read(file.path).catch(() => undefined)] as const)).then((pairs) => {
      if (alive) setLeft(Object.fromEntries(pairs.filter((pair): pair is readonly [string, number | null] => pair[1] !== undefined)));
    });
    return () => { alive = false; };
  }, [files, version]);
  const open = (path: string) => { if (view?.open) view.open(path, range); else setAway(path); };
  if (files.length > FOLD_OVER && !unfolded) {
    return <div className={c.turnFiles}><button type="button" className={c.edited} onClick={() => setUnfolded(true)} data-testid="turn-files">改了 {files.length} 个文件 ›</button></div>;
  }
  return (
    <div className={c.turnFiles}>
      {files.map((file) => (
        <button key={file.path} type="button" className={c.edited} onClick={() => open(file.path)} data-testid="turn-file">
          {away === file.path ? "在那台电脑上看" : `${turnFileText(file.path in left && file.change === "modified" ? { ...file, changes: left[file.path]! } : file, view?.restored(file.path) ?? false)} ›`}
        </button>
      ))}
    </div>
  );
}
