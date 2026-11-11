"use client";

/**
 * 对话里一轮末尾那一行（设计第 72 条第一步，事件 files_changed）：这一轮改过文件时出一行淡字「改了 周报.md · 2 处 ›」，不是按钮的样子；
 * 多个文件各一行，超过 3 个收成「改了 5 个文件 ›」（点了展开成各一行）；全部恢复以后写「已恢复」。
 * 点了在右边打开预览，看的是那一轮（带轮号），停在第一处。卡在工作树里的会话本机不发这个事件，没有这一行。
 * 手机上、别的电脑上（连不上那台电脑的本机程序）：那一行照样出，点了写「在那台电脑上看」。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TurnFile } from "@/lib/local/fileChanges";
import type { SessionEntry } from "@/lib/local/sessionView";
import c from "@/styles/change-view.module.css";

export type TurnFilesView = {
  /** 打开这个文件那一轮的改动；null 是这台电脑上看不到（手机、别的电脑）。 */
  open: ((path: string, turn: number) => void) | null;
  /** 恢复过了（右栏清单里带 restoredAt）。 */
  restored: (path: string) => boolean;
  /** 最近一轮那一行的编号：恢复过以后只有它重读剩几处。 */
  latest: number | null;
  /** 那一轮这个文件现在还剩几处（读不到明细为 null）。 */
  count?: (path: string, turn: number) => Promise<number | null>;
  /** 恢复过文件就会变（右栏清单重读了）：最近一轮那一行跟着重读剩几处。 */
  version?: unknown;
};
export const TurnFilesContext = createContext<TurnFilesView | null>(null);

/** 对话记录里最近一轮那一行的编号。 */
export const latestFilesSeq = (entries: readonly SessionEntry[]) => entries.reduce<number | null>((last, entry) => (entry.kind === "files" ? entry.seq : last), null);

/** 收成一行的门槛：超过这么多个文件写「改了 N 个文件」。 */
const FOLD_OVER = 3;
const VERB: Record<TurnFile["change"], string> = { added: "新建", modified: "改了", deleted: "删了" };

/** 一个文件那一行的字：几处只在改了的、有明细的文件上写；剩 0 处或恢复过的写「已恢复」。 */
export function turnFileText(file: Pick<TurnFile, "path" | "change" | "count">, restored: boolean): string {
  const tail = restored || file.count === 0 ? " · 已恢复" : file.change === "modified" && file.count !== null ? ` · ${file.count} 处` : "";
  return `${VERB[file.change]} ${file.path.replace(/\\/g, "/").split("/").pop()}${tail}`;
}

export function TurnFilesLine({ seq, turn, files, more }: { seq: number; turn: number; files: TurnFile[]; more: number }) {
  const view = useContext(TurnFilesContext);
  const [unfolded, setUnfolded] = useState(false);
  const [away, setAway] = useState<string | null>(null);
  // 最近一轮：恢复过以后重读还剩几处（恢复了一处，「2 处」变「1 处」；都恢复了写「已恢复」）。
  const [left, setLeft] = useState<Record<string, number | null>>({});
  const count = useRef(view?.count);
  count.current = view?.count;
  const version = view?.latest === seq ? view.version : undefined;
  useEffect(() => {
    const read = count.current;
    if (!read || version === undefined) return;
    let alive = true;
    void Promise.all(files.map(async (file) => [file.path, await read(file.path, turn).catch(() => undefined)] as const)).then((pairs) => {
      if (alive) setLeft(Object.fromEntries(pairs.filter((pair): pair is readonly [string, number | null] => pair[1] !== undefined)));
    });
    return () => { alive = false; };
  }, [files, turn, version]);
  const open = (path: string) => { if (view?.open) view.open(path, turn); else setAway(path); };
  const total = files.length + more;
  if (total > FOLD_OVER && !unfolded) {
    return <div className={c.turnFiles}><button type="button" className={c.edited} onClick={() => setUnfolded(true)} data-testid="turn-files">改了 {total} 个文件 ›</button></div>;
  }
  return (
    <div className={c.turnFiles}>
      {files.map((file) => (
        <button key={file.path} type="button" className={c.edited} onClick={() => open(file.path)} data-testid="turn-file">
          {away === file.path ? "在那台电脑上看" : `${turnFileText(file.path in left && file.change === "modified" ? { ...file, count: left[file.path]! } : file, view?.restored(file.path) ?? false)} ›`}
        </button>
      ))}
      {more ? <span className={c.edited} data-more="">还有 {more} 个</span> : null}
    </div>
  );
}
