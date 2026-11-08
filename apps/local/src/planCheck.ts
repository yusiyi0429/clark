import { existsSync, readdirSync } from "node:fs";
import { git } from "./git.js";
import { stripCredentials } from "./handover.js";

/**
 * 规划员开拆前的检查（新首页设计 18.11）：项目绑的文件夹现在什么样。只读，只跑 git 的查询命令，不改文件夹，不调模型。
 * 没绑、是空的、不是 git 仓库，规划员先不出派活单，用「问用户」把这几件问清楚（本机在 propose_plan 那里把关）；
 * 有没有远端、文件夹里有什么，交给规划员对着 Task 判断对不对得上。
 */
export type PlanFlag = "unbound" | "empty" | "not_git";
export interface PlanFolderFacts {
  /** 项目在这台电脑上绑的文件夹（或开工时指定的目录）；没绑为 null，规划员在本机给它的专用目录里做。 */
  folder: string | null;
  empty: boolean;
  git: boolean;
  branch: string | null;
  remotes: { name: string; url: string }[];
  /** 顶层的文件和文件夹名（跳过 .git，最多 30 个），给规划员看大概是什么。 */
  top: string[];
  flags: PlanFlag[];
}

const IGNORED = new Set([".git", ".DS_Store", "Thumbs.db", ".tianshu-attachments"]);

export async function planFolderFacts(folder: string | null): Promise<PlanFolderFacts> {
  if (!folder || !existsSync(folder)) return { folder: null, empty: true, git: false, branch: null, remotes: [], top: [], flags: ["unbound"] };
  let names: string[] = [];
  try { names = readdirSync(folder).filter((n) => !IGNORED.has(n)).sort(); } catch { /* 读不了按空的算 */ }
  const top = await git(folder, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  const branch = top ? await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]).then((s) => s.trim() || null, () => null) : null;
  const remotes = top
    ? (await git(top, ["remote", "-v"]).catch(() => "")).split("\n").filter((l) => l.endsWith("(fetch)"))
      .map((l) => { const [name, url] = l.split(/\s+/); return { name: name!.slice(0, 100), url: stripCredentials(url ?? "").slice(0, 300) }; }).slice(0, 5)
    : [];
  const flags: PlanFlag[] = [];
  if (!names.length) flags.push("empty");
  if (!top) flags.push("not_git");
  return { folder, empty: !names.length, git: Boolean(top), branch, remotes, top: names.slice(0, 30), flags };
}

const FLAG_TEXT: Record<PlanFlag, string> = {
  unbound: "这个项目在这台电脑上还没绑文件夹",
  empty: "绑的文件夹是空的",
  not_git: "绑的文件夹不是 git 仓库",
};
export const flagText = (flags: PlanFlag[]) => flags.map((f) => FLAG_TEXT[f]).join("、");

/** 写进规划员系统提示词的那一节：本机看到的现实，和该怎么做。 */
export function planFactsSection(f: PlanFolderFacts): string {
  const lines = [
    "## 开拆前本机看过的文件夹",
    f.folder ? `- 文件夹：${f.folder}` : "- 文件夹：没绑（你现在在本机给这件事建的空目录里，不是项目的文件夹）",
  ];
  if (f.folder) {
    lines.push(`- ${f.empty ? "是空的" : `顶层有：${f.top.join("、")}${f.top.length >= 30 ? "…" : ""}`}`);
    lines.push(`- ${f.git ? `是 git 仓库${f.branch ? `，当前分支 ${f.branch}` : ""}；${f.remotes.length ? `远端 ${f.remotes.map((r) => `${r.name} ${r.url}`).join("，")}` : "没有远端"}` : "不是 git 仓库"}`);
  }
  if (f.flags.length) {
    lines.push(`- 要先问清楚：${flagText(f.flags)}。这时不交派活单：用「问用户」（AskUserQuestion）问本人在哪个文件夹做、要不要新建、要不要连 GitHub 仓库、是不是从别处迁过来的；本人答了再拆。`);
  }
  return lines.join("\n");
}
