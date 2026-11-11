import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * 影子仓库（ADR 0039）：--git-dir 在本机数据目录，--work-tree 指向本人的文件夹，给它留一份、按提交取回文件。
 * 不读本人的 git 全局、系统设置（autocrlf、LFS 过滤器、钩子都不掺进来）；每个会话一个暂存区文件（index-<会话>），提交挂在 refs/tianshu/<会话>/ 下。
 * git add 直接写包（core.bigFileThreshold=1，不写几万个小对象文件，11/11 实测比普通 add 快一倍），目录状态用 Git for Windows 的批量读取（core.fscache）。
 */
const CFG = [
  "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.longpaths=true", "-c", "core.quotepath=false", "-c", "gc.auto=0",
  "-c", "core.fsmonitor=false", "-c", "core.symlinks=false", "-c", "core.fscache=true", "-c", "core.bigFileThreshold=1", "-c", "core.compression=1",
  "-c", "advice.addEmbeddedRepo=false",
];

/** 不留的目录（能重新生成的）：照样有「改前拷一份」，命令删、挪里面的已有文件照样问。 */
export const SKIP_DIRS = ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache", "$RECYCLE.BIN", "System Volume Information"];

export interface ScanLimits { files: number; bytes: number; bigFile: number; ms: number }
export interface ScanResult {
  files: number;
  bytes: number;
  /** 不进快照的（相对路径，正斜杠）：目录联接和符号链接（git 会顺着跟到外面）、套着的 git 仓库、大文件。 */
  excludes: string[];
  /** 超过了文件数、大小或数的时间。 */
  tooLarge: boolean;
  /** 给了 pick 时：挑中的文件（相对路径，正斜杠）。只给它们留一份，别的不碰。 */
  included?: string[];
}

/** 同步盘里只留的文档类文件（11/11：不写代码的同事改的是 Word、Excel）。 */
export const DOC_EXT = new Set([".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".md", ".markdown", ".txt", ".csv", ".tsv", ".rtf", ".odt", ".ods", ".odp", ".pdf"]);
/**
 * 同步盘的占位文件（只在云端、本地没内容）：大小不为 0、占的盘块数为 0。读它会触发下载，不能碰。
 * 几百字节的小文件在本地也可能是 0 块（内容存在目录项里），一律当占位跳过，往安全那边错。
 */
export const isPlaceholder = (size: number, blocks: number) => size > 0 && blocks === 0;

const posix = (p: string) => p.split(sep).join("/");

/** 先数一遍：数文件和大小，找出不进快照的；超过任一限度就停，tooLarge。只读，不跟链接。 */
export async function scan(root: string, limits: ScanLimits, pick?: (rel: string, size: number, blocks: number) => boolean): Promise<ScanResult> {
  const t0 = Date.now();
  const out: ScanResult = { files: 0, bytes: 0, excludes: [], tooLarge: false, ...(pick ? { included: [] } : {}) };
  const over = () => out.files > limits.files || out.bytes > limits.bytes || Date.now() - t0 > limits.ms;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root && entries.some((e) => e.name === ".git")) { out.excludes.push(posix(relative(root, dir))); return; }
    for (const e of entries) {
      if (out.tooLarge || (out.tooLarge = over())) return;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) { out.excludes.push(posix(relative(root, p))); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(e.name)) await walk(p); continue; }
      if (!e.isFile()) continue;
      const st = await lstat(p).catch(() => null);
      const size = st?.size ?? 0;
      if (pick) {
        // 只留挑中的：别的不数、不碰（同步盘里不读占位文件）
        if (!st || size > limits.bigFile || !pick(posix(relative(root, p)), size, st.blocks)) continue;
        out.included!.push(posix(relative(root, p)));
      } else if (size > limits.bigFile) { out.excludes.push(posix(relative(root, p))); continue; }
      out.files += 1;
      out.bytes += size;
    }
  };
  await walk(root);
  out.tooLarge ||= over();
  return out;
}

export interface Change { status: "A" | "M" | "D"; path: string }

export class Shadow {
  constructor(readonly gitDir: string, readonly workTree: string) {}

  private run(args: string[], o: { index?: string; input?: string; raw?: boolean } = {}): Promise<{ code: number; out: Buffer; err: string }> {
    return new Promise((done, fail) => {
      const child = spawn("git", [...CFG, ...args], {
        cwd: this.workTree, windowsHide: true,
        env: {
          ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workTree, ...(o.index ? { GIT_INDEX_FILE: o.index } : {}),
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
          GIT_AUTHOR_NAME: "tianshu", GIT_AUTHOR_EMAIL: "local@tianshu", GIT_COMMITTER_NAME: "tianshu", GIT_COMMITTER_EMAIL: "local@tianshu",
        },
      });
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 4000) err += d; });
      child.on("error", fail);
      child.on("close", (code) => done({ code: code ?? 1, out: Buffer.concat(out), err }));
      child.stdin.end(o.input ?? "");
    });
  }

  private async ok(args: string[], o: { index?: string; input?: string } = {}): Promise<string> {
    const r = await this.run(args, o);
    if (r.code !== 0) throw new Error(`git ${args[0]}：${r.err.trim().split("\n").pop() ?? r.code}`);
    return r.out.toString("utf8").trim();
  }

  async init(): Promise<void> {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    mkdirSync(this.gitDir, { recursive: true });
    await this.ok(["init", "-q"]);
    // 排除全写成 pathspec（-f 才能留下文件夹自己 .gitignore 里的），info/exclude 留空
    writeFileSync(join(this.gitDir, "info", "exclude"), "");
  }

  /** 留一份：把文件夹现在的样子记成一个提交，挂在 ref 上。读不了的文件（被独占、没权限）跳过。返回提交号。 */
  async snapshot(index: string, ref: string, parent: string | null, excludes: string[], message: string, include?: string[]): Promise<string> {
    // 给了 include（同步盘里只留文档）：只送这些，加上上一份里有的（删掉的也记下）；别的文件一个都不读
    const tracked = include ? (await this.run(["ls-files", "-z"], { index })).out.toString("utf8").split("\0").filter(Boolean) : [];
    const spec = include
      ? [...new Set([...include, ...tracked])].map((p) => `:(literal)${p}`)
      : [".", ...SKIP_DIRS.map((d) => `:(exclude,glob)**/${d}/**`), ...excludes.map((p) => `:(exclude,literal)${p}`)];
    // 一个文件都没有（同步盘里没有本地的文档）：不 add，留一份空的
    if (spec.length) {
      const add = await this.run(["add", "-A", "-f", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { index, input: spec.join("\0") + "\0" });
      if (add.code > 1) throw new Error(`git add：${add.err.trim().split("\n").pop()}`);
    }
    const tree = await this.ok(["write-tree"], { index });
    const commit = await this.ok(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { index });
    await this.ok(["update-ref", ref, commit]);
    return commit;
  }

  /** 两份之间：哪些文件新建、改了、删了（不认改名）。 */
  async diff(a: string, b: string): Promise<Change[]> {
    const parts = (await this.run(["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b])).out.toString("utf8").split("\0").filter(Boolean);
    const out: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!.charAt(0) as Change["status"], path: parts[i + 1]! });
    return out;
  }

  /** 那一份里这个文件的内容；没有这个文件为 null。 */
  async read(commit: string, path: string): Promise<Buffer | null> {
    const r = await this.run(["cat-file", "blob", `${commit}:${path}`]);
    return r.code === 0 ? r.out : null;
  }

  /** 这个会话的提交和暂存区都不要了（对象留在仓库里，整个仓库没人用了再删）。 */
  async drop(sessionId: string): Promise<void> {
    const refs = (await this.run(["for-each-ref", "--format=%(refname)", `refs/tianshu/${sessionId}/`])).out.toString("utf8").split("\n").filter(Boolean);
    for (const ref of refs) await this.run(["update-ref", "-d", ref]);
  }

  /** 还有没有会话的提交挂着。 */
  async used(): Promise<boolean> {
    return (await this.run(["for-each-ref", "--count=1", "--format=%(refname)", "refs/tianshu/"])).out.toString("utf8").trim().length > 0;
  }
}

