// 做法 1 的原型：影子 git 仓库。--git-dir 在本机数据目录，--work-tree 指向本人的文件夹。只用 node: 标准库 + 系统里的 git。
// 不读本人的 git 全局、系统设置（autocrlf、LFS 过滤器、钩子都不生效），每个会话一个暂存区文件，开工那一刻的提交记在 refs/tianshu/<会话>/base。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SKIP_DIRS = ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache", "$RECYCLE.BIN", "System Volume Information"];

const CFG = [
  "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.longpaths=true", "-c", "core.quotepath=false",
  "-c", "gc.auto=0", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=true", "-c", "core.symlinks=false",
  "-c", "core.bigFileThreshold=16m", "-c", "advice.addEmbeddedRepo=false", "-c", "core.hooksPath=NUL",
];

export class Shadow {
  constructor(gitDir, workTree, sessionId) {
    this.gitDir = resolve(gitDir);
    this.workTree = resolve(workTree);
    this.sessionId = sessionId;
    this.index = join(this.gitDir, `index-${sessionId}`);
  }
  env() {
    return {
      ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workTree, GIT_INDEX_FILE: this.index,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "tianshu", GIT_AUTHOR_EMAIL: "local@tianshu", GIT_COMMITTER_NAME: "tianshu", GIT_COMMITTER_EMAIL: "local@tianshu",
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    };
  }
  git(args, opts = {}) {
    return new Promise((res, rej) => {
      const child = spawn("git", [...CFG, ...args], { cwd: this.workTree, env: this.env(), windowsHide: true });
      let out = "", err = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
      if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
      child.on("close", (code) => (code === 0 || opts.allowFail ? res({ code, out, err }) : rej(new Error(`git ${args.join(" ")} → ${code}: ${err.trim()}`))));
    });
  }
  async init() {
    if (!existsSync(join(this.gitDir, "HEAD"))) {
      mkdirSync(this.gitDir, { recursive: true });
      await this.git(["init", "-q"]);
    }
    // 跳过的目录写进 info/exclude；文件夹里自己的 .gitignore 照样生效（普通文件夹里很少有）
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), SKIP_DIRS.map((d) => `${d}/`).join("\n") + "\n" + (this.extraExcludes ?? []).join("\n") + "\n");
  }
  /** 留一份：把文件夹现在的样子记成一个提交，refs/tianshu/<会话>/<name>。返回提交号。 */
  async snapshot(name, parent = null) {
    await this.git(["add", "-A", "--ignore-errors", "--", "."], { allowFail: true }).then((r) => { this.lastAddErr = r.err; this.lastAddCode = r.code; });
    const tree = (await this.git(["write-tree"])).out.trim();
    const commit = (await this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", name])).out.trim();
    await this.git(["update-ref", `refs/tianshu/${this.sessionId}/${name}`, commit]);
    return commit;
  }
  /** 从 base 到文件夹现在：哪些文件新建、改了、删了（-z，路径原样）。 */
  async changes(base) {
    await this.git(["add", "-A", "--ignore-errors", "--", "."], { allowFail: true });
    const tree = (await this.git(["write-tree"])).out.trim();
    const parts = (await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", base, tree])).out.split("\0").filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
    return out;
  }
  /** 恢复一个文件到 base：base 里有就写回（改了的、删了的），base 里没有（执行方新建的）就删掉。 */
  async restore(base, path) {
    const has = (await this.git(["cat-file", "-e", `${base}:${path}`], { allowFail: true })).code === 0;
    if (has) return this.git(["checkout", base, "--", path]);
    rmSync(join(this.workTree, path), { force: true });
    await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
  }
  async restoreAll(base, { deleteCreated = true } = {}) {
    const ch = await this.changes(base);
    const back = ch.filter((c) => c.status !== "A").map((c) => c.path);
    const failed = [];
    // 一次写回多个文件；有被占用的会整个失败，再一个个来，记下失败的
    if (back.length) {
      const r = await this.git(["checkout", base, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: back.join("\0") + "\0", allowFail: true });
      if (r.code !== 0) for (const p of back) await this.git(["checkout", base, "--", p]).catch((e) => failed.push({ path: p, err: e.message }));
    }
    if (deleteCreated) for (const c of ch.filter((c) => c.status === "A")) { try { rmSync(join(this.workTree, c.path)); } catch (e) { failed.push({ path: c.path, err: e.message }); } }
    return { changed: ch.length, failed };
  }
}
