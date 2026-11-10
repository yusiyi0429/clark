/**
 * 本会话写过、改过的文件（设计 17.2 第 41 条，本机 GET /v1/sessions/:id/files）：右栏「改动的文件 N」列它；回答里提到的路径对得上它才能点。
 * 老版本的本机程序没有这条路由（404）、新版本还没实现（501）时当没有：不画那一组，回答里的路径也不能点。
 */
import { useEffect, useState } from "react";
import type { TLocalChangedFile } from "@warmap/contracts";
import type { LocalRunner } from "./runner";
import type { SessionEntry } from "./sessionView";

/** 回答里的一处写法规整成能比的样子：反斜杠换成正斜杠，去掉开头的「./」和末尾的行号（a.ts:12、a.ts:12-30）。 */
const tidy = (text: string) => text.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(?:[-:]\d+)?$/, "");

/** 回答里提到的这一处是不是本会话改过的文件：相对会话根的路径或绝对路径对得上才算，不猜（只写文件名的不算）；不在了的不算。 */
export function matchChangedFile(files: readonly TLocalChangedFile[], mention: string): TLocalChangedFile | null {
  const want = tidy(mention);
  if (!want) return null;
  const lower = want.toLowerCase();
  return files.find((file) => file.exists && (file.path === want || tidy(file.absolutePath).toLowerCase() === lower)) ?? null;
}

const WRITE_STEP = /^(改文件|写文件|改|写) /;
/** 什么时候重读一次清单：会话的状态变了，或又做完一步改文件、写文件（不跟着每个事件读，本机那边要跑 git）。 */
export function filesSignal(status: string | null, entries: readonly SessionEntry[]): string {
  return `${status ?? ""}|${entries.filter((entry) => entry.kind === "step" && entry.done && WRITE_STEP.test(entry.title)).length}`;
}

export function useSessionFiles(runner: Pick<LocalRunner, "listSessionFiles">, sessionId: string | null, signal: string): TLocalChangedFile[] {
  const [files, setFiles] = useState<TLocalChangedFile[]>([]);
  useEffect(() => {
    if (!sessionId) { setFiles([]); return; }
    let alive = true;
    // 读不到（老版本、还没实现、断线）留着上一次的；第一次就读不到就是空的。
    void runner.listSessionFiles(sessionId).then((data) => { if (alive) setFiles(data.files); }, () => undefined);
    return () => { alive = false; };
  }, [runner, sessionId, signal]);
  return files;
}
