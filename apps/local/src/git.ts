import { execFile } from "node:child_process";
import type { TLocalMergeBlockReason } from "@warmap/contracts";

/**
 * 卡的工作树要用的几条 git（ADR 0038）。用本人电脑上的 git，不经 shell；文件名原样（中文不转义）。
 * 失败时抛错，message 是 git 自己的报错。
 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** 跑一条 git，失败（不是仓库、没有这个分支等）为 null。 */
const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((s) => s.trim(), () => null);

/** 文件夹所在仓库的根、当前分支和最新提交；不是仓库、不在分支上、还没有提交时为 null（卡就在文件夹里做）。 */
export async function repoHead(folder: string): Promise<{ top: string; branch: string; commit: string } | null> {
  const top = await tryGit(folder, ["rev-parse", "--show-toplevel"]);
  const branch = top && (await tryGit(folder, ["symbolic-ref", "--short", "-q", "HEAD"]));
  const commit = branch && (await tryGit(folder, ["rev-parse", "--verify", "-q", "HEAD"]));
  return top && branch && commit ? { top, branch, commit } : null;
}

/** 有改动的文件（含没加进 git 的，untracked 为 true；不含 .gitignore 里的）；干净为空。 */
export async function dirtyFiles(dir: string): Promise<{ path: string; untracked: boolean }[]> {
  const out = await git(dir, ["status", "--porcelain"]);
  return out.split("\n").filter((l) => l.trim()).map((l) => ({ path: l.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, ""), untracked: l.startsWith("??") }));
}

export const changedFiles = async (dir: string): Promise<string[]> => (await dirtyFiles(dir)).map((f) => f.path);

/** 扔掉这几处没提交的改动：改过、删了的已有文件照 HEAD 恢复，没加进 git 的删掉（.gitignore 里的不动）。 */
export async function discardFiles(dir: string, files: { path: string; untracked: boolean }[]): Promise<void> {
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  if (tracked.length) await git(dir, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  if (untracked.length) await git(dir, ["--literal-pathspecs", "clean", "-f", "-d", "-q", "--", ...untracked]);
}

/** 卡的分支名：tianshu/<卡 id 前 8 位>-<标题里的英文和数字>（中文标题就只有 id）。 */
export function branchName(cardId: string, title: string): string {
  const id = cardId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "card";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/^-+|-+$/g, "");
  return `tianshu/${id}${slug ? `-${slug}` : ""}`;
}

/** 从 base 开一个工作树和新分支（分支名被占了就加 -2、-3）。返回实际用的分支名。 */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<string> {
  await tryGit(repo, ["worktree", "prune"]); // 手动删掉的旧工作树还登记着时，同一路径开不出来
  let name = branch;
  for (let n = 2; await tryGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]); n++) name = `${branch}-${n}`;
  await git(repo, ["worktree", "add", "-b", name, path, base]);
  return name;
}

/** 清掉工作树（分支保留）。只在确认没有要留的改动以后调。 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

export const pruneRepo = (repo: string) => tryGit(repo, ["worktree", "prune"]);
export const deleteBranch = (repo: string, branch: string) => tryGit(repo, ["branch", "-D", branch]);

/** 本人没配 git 的名字和邮箱时用这个，免得提交、合并失败。 */
async function identity(dir: string): Promise<string[]> {
  const set = (await tryGit(dir, ["config", "user.name"])) && (await tryGit(dir, ["config", "user.email"]));
  return set ? [] : ["-c", "user.name=天枢本机程序", "-c", "user.email=tianshu-local@localhost"];
}

/**
 * 交回时把工作树里没提交的改动都提交，返回分支上最新的提交。
 * 不跑仓库的提交钩子：工作树是新开的，没装依赖，钩子多半跑不起来，会挡住交回。
 */
export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  if ((await changedFiles(dir)).length) await git(dir, [...(await identity(dir)), "commit", "--no-verify", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

const MAX_PATCH = 40_000;

/** 卡开工以来的改动（基线到交回的提交），给验收员看；太长就截掉后面的。 */
export async function cardDiff(repo: string, base: string, head: string): Promise<{ stat: string; patch: string; truncated: boolean }> {
  const stat = (await git(repo, ["diff", "--stat=200", base, head])).trim();
  const patch = await git(repo, ["diff", base, head]);
  return { stat, patch: patch.slice(0, MAX_PATCH), truncated: patch.length > MAX_PATCH };
}

export type MergeOutcome =
  | { merged: true; commit: string }
  | { merged: false; reason: TLocalMergeBlockReason; message: string; files: string[] };

/** 在主文件夹里把卡的分支合进 baseBranch（--no-ff，留一个合并提交）。主文件夹不在 baseBranch 上、有改动、有冲突都不合，主文件夹原样不动。 */
export async function mergeBranch(folder: string, branch: string, baseBranch: string, message: string): Promise<MergeOutcome> {
  const head = await tryGit(folder, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (head !== baseBranch) {
    return { merged: false, reason: "base_not_checked_out", message: `主文件夹现在${head ? `在 ${head} 上` : "不在任何分支上"}，切回 ${baseBranch} 再合`, files: [] };
  }
  const dirty = await changedFiles(folder);
  if (dirty.length) return { merged: false, reason: "dirty", message: "主文件夹里有没提交的改动，提交或收起来再合", files: dirty.slice(0, 200) };
  try {
    await git(folder, [...(await identity(folder)), "merge", "--no-ff", "-m", message, branch]);
  } catch (e) {
    const files = ((await tryGit(folder, ["diff", "--name-only", "--diff-filter=U"])) ?? "").split("\n").filter(Boolean);
    await tryGit(folder, ["merge", "--abort"]);
    const why = files.length ? "有冲突" : `没合成（${e instanceof Error ? e.message.split("\n")[0] : String(e)}）`;
    return { merged: false, reason: "conflict", message: `${why}，已放弃这次合并，主文件夹没动`, files: files.slice(0, 200) };
  }
  return { merged: true, commit: (await git(folder, ["rev-parse", "HEAD"])).trim() };
}
