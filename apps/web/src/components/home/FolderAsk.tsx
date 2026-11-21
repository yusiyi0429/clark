"use client";

import { createContext, useContext, useState } from "react";
import { DecisionBox } from "@/components/work/DecisionBox";
import type { TLocalFolder } from "@/lib/local/runner";

/** 「随手」项目在这台电脑上绑的文件夹 id（收在幕后，本人 11/19）：选文件夹的几处不列（外壳给）。 */
export const ScratchFolders = createContext<ReadonlySet<string>>(new Set());
/** 去掉随手项目绑的文件夹。 */
export function useShownFolders<T extends { id: string }>(folders: readonly T[]): readonly T[] {
  const hidden = useContext(ScratchFolders);
  return hidden.size ? folders.filter((folder) => !hidden.has(folder.id)) : folders;
}

/** 选项框里最后一项：本机弹出选择框选别的文件夹。 */
export const PICK_OTHER = "选择其他文件夹";

/** 选了第几项：前面是这台电脑上的文件夹，最后一项（「选择其他文件夹…」）弹本机的选择框，取消回 null。 */
export async function folderChoice(index: number | undefined, folders: readonly TLocalFolder[], pickOther: () => Promise<TLocalFolder | null>): Promise<TLocalFolder | null> {
  return index !== undefined && index < folders.length ? folders[index]! : pickOther();
}

/**
 * 项目还没在这台电脑上绑文件夹时不开工（17.2 第 32 条、设计 18.11）：项目对话里问用哪个文件夹。
 * 选项是这台电脑上允许的文件夹（随手项目绑的不列；下面一行淡色写路径），最后是「选择其他文件夹…」；选完绑到项目上（onBind），开工照常接着走。
 */
export function FolderAsk({ folders: given, onBind, onPickOther }: {
  folders: readonly TLocalFolder[];
  onBind: (folder: TLocalFolder) => Promise<unknown>;
  /** 本机弹出的选择框：选了回那个文件夹，取消回 null。 */
  onPickOther: () => Promise<TLocalFolder | null>;
}) {
  const [busy, setBusy] = useState(false);
  const folders = useShownFolders(given);
  const options = [...folders.map((folder) => ({ label: folder.label, detail: folder.path })), { label: PICK_OTHER }];
  const pick = async ([index]: number[]) => {
    const chosen = await folderChoice(index, folders, onPickOther);
    if (!chosen) return;
    setBusy(true);
    try { await onBind(chosen); } finally { setBusy(false); }
  };
  return <DecisionBox kind="question" testId="folder-ask" title="在哪个文件夹开工？" options={options} onPick={pick} busy={busy} />;
}
