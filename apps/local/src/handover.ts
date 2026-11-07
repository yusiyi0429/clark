import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { TLocalHandoverCheck } from "@warmap/contracts";
import { git } from "./git.js";

/** 不是 git 仓库时找最近改过的文件：跳过这些目录。 */
const SKIP_DIRS = new Set([".git", "node_modules", ".tianshu-attachments", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);
const MAX_SCAN = 5_000;

/**
 * 远端地址里的口令去掉：https 的账号口令整个去掉（https://user:token@host/... → https://host/...，令牌常放在用户名的位置）；
 * ssh 等别的只去掉口令、留下用户名（ssh://git@host/... 不动，少了 git@ 就拉不下来）。
 */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, "$1").replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^/@]*@/i, "$1@");
}

/**
 * 交接检查（新首页设计 16.7）：只看 git，不调模型。当前分支、远端、没提交的文件、没推完的本地分支；不是仓库时列最近改过的文件。
 */
export async function handoverCheck(projectId: string, folder: { path: string; label: string } | null, now = new Date()): Promise<TLocalHandoverCheck> {
  const base = { projectId, checkedAt: now.toISOString(), folder };
  if (!folder || !existsSync(folder.path)) return { ...base, folder: null, git: null, recentFiles: null };
  const top = await git(folder.path, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  if (!top) return { ...base, git: null, recentFiles: recentFiles(folder.path) };
  const branch = await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]).then((s) => s.trim() || null, () => null);
  const remotes = (await git(top, ["remote", "-v"]).catch(() => "")).split("\n").filter((l) => l.endsWith("(fetch)"))
    .map((l) => { const [name, url] = l.split(/\s+/); return { name: name!.slice(0, 100), url: stripCredentials(url ?? "").slice(0, 500) }; }).slice(0, 10);
  // 没提交的（含没加进 git 的），-z 免得文件名被转义
  const status = (await git(top, ["status", "--porcelain", "-z", "--untracked-files=all"]).catch(() => "")).split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]!;
    files.push(entry.slice(3));
    if (/^[RC]/.test(entry)) i++; // 改名、复制：后面跟着原来的名字
  }
  // 本地分支里没推完的：没有上游、或者比上游多
  const refs = (await git(top, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"]).catch(() => "")).split("\n").filter(Boolean);
  const unpushed: NonNullable<TLocalHandoverCheck["git"]>["unpushed"] = [];
  for (const line of refs) {
    const [name, upstream, track] = line.split("\t");
    if (!upstream || /gone/.test(track ?? "")) unpushed.push({ branch: name!, upstream: null, ahead: null });
    else {
      const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
      if (ahead > 0) unpushed.push({ branch: name!, upstream, ahead });
    }
  }
  return {
    ...base, recentFiles: null,
    git: { branch, remotes, uncommitted: files.slice(0, 200), uncommittedCount: files.length, unpushed: unpushed.slice(0, 50) },
  };
}

/** 不是 git 仓库的文件夹：最近改过的 30 个文件（最多看 5000 个）。 */
function recentFiles(root: string): NonNullable<TLocalHandoverCheck["recentFiles"]> {
  const found: { path: string; at: number }[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= MAX_SCAN) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (e.isFile()) { try { found.push({ path: p, at: statSync(p).mtimeMs }); } catch { /* 刚被删 */ } }
    }
  };
  walk(root);
  return found.sort((a, b) => b.at - a.at).slice(0, 30).map((f) => ({ path: relative(root, f.path).replace(/\\/g, "/"), modifiedAt: new Date(f.at).toISOString() }));
}

/** 仓库地址里的仓库名（…/Chat_Service.git → Chat_Service）。 */
export function repoName(url: string): string {
  return basename(url.replace(/[/\\]+$/, "").replace(/\.git$/i, "").replace(/^.*[:/]/, "/")) || "repo";
}

/**
 * clone 仓库（16.7 接手）：不经 shell，不弹输入口令（GIT_TERMINAL_PROMPT=0，用本人已有的 git 登录）；再切到交接分支，远端没有就留在默认分支。
 * 失败抛错，message 是 git 的报错。
 */
export async function cloneRepo(url: string, dest: string, branch: string | undefined, timeoutMs = 15 * 60_000): Promise<{ branch: string | null; fellBack: boolean }> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["clone", "--", url, dest], { windowsHide: true, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, maxBuffer: 16 * 1024 * 1024 },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr).trim().split("\n").filter((l) => !/^Cloning into/.test(l)).join("\n") || err.message)) : resolve()));
  });
  let fellBack = false;
  if (branch) {
    const ok = await git(dest, ["switch", branch]).then(() => true, () => false);
    fellBack = !ok;
  }
  const now = await git(dest, ["symbolic-ref", "--short", "-q", "HEAD"]).then((s) => s.trim() || null, () => null);
  return { branch: now, fellBack };
}
