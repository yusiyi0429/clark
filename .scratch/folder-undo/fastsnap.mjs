// 做法 1 的快版本：本机自己遍历文件夹，用 git fast-import 一次写成一个包（不写几万个小对象文件）。
// 自己记一份清单（路径 → 大小、修改时间），之后每一轮只把变了的文件送进去，提交接在上一份后面。
// 恢复照样用 git（按提交取文件）。用法见 bench-fast.mjs。
import { spawn } from "node:child_process";
import { readdirSync, lstatSync, openSync, readSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Shadow, SKIP_DIRS } from "./shadow.mjs";

export const BIG = 32 * 1024 * 1024;

/** 遍历：跳过该跳过的目录、目录联接和符号链接（不跟到文件夹外面）、大文件（单独记下）。 */
export function scan(root) {
  const files = new Map(), big = [], links = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) { links.push(p); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(e.name)) walk(p); continue; }
      if (!e.isFile()) continue;
      let st; try { st = lstatSync(p); } catch { continue; }
      const rel = relative(root, p).split(sep).join("/");
      if (st.size > BIG) { big.push({ rel, size: st.size }); continue; }
      files.set(rel, { size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(root);
  return { files, big, links };
}

const quote = (p) => (/^"|[\n"\\]/.test(p) ? JSON.stringify(p) : p);

export class FastShadow extends Shadow {
  manifestPath() { return join(this.gitDir, `manifest-${this.sessionId}.json`); }
  /** 留一份：parent 为空时整份送；有 parent 时只送和上一份清单比变了的、加上删掉的。返回 { commit, sent, deleted, skipped }。 */
  async fastSnapshot(name, parent = null) {
    const now = scan(this.workTree);
    const prev = parent && existsSync(this.manifestPath()) ? new Map(Object.entries(JSON.parse(readFileSync(this.manifestPath(), "utf8")))) : new Map();
    const changed = [...now.files].filter(([p, m]) => { const o = prev.get(p); return !o || o.size !== m.size || o.mtime !== m.mtime; });
    const deleted = parent ? [...prev.keys()].filter((p) => !now.files.has(p)) : [];
    const child = spawn("git", ["-c", "core.longpaths=true", "-c", "pack.compression=1", "fast-import", "--quiet", "--done", `--export-marks=${join(this.gitDir, "marks")}`], { env: this.env(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const exited = new Promise((r) => child.on("close", r));
    const write = (b) => (child.stdin.write(b) ? null : new Promise((r) => child.stdin.once("drain", r)));
    const skipped = [];
    const ok = [];
    const buf = Buffer.alloc(1 << 20);
    let mark = 0;
    for (const [p, m] of changed) {
      let fd;
      try { fd = openSync(join(this.workTree, p), "r"); } catch (e) { skipped.push({ p, err: e.code }); continue; }
      try {
        const size = m.size;
        const head = Buffer.from(`blob\nmark :${++mark}\ndata ${size}\n`);
        await write(head);
        let left = size, pos = 0;
        while (left > 0) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, left), pos);
          if (n <= 0) break; // 读的时候文件变短了：补零，下一轮会再送
          await write(Buffer.from(buf.subarray(0, n)));
          left -= n; pos += n;
        }
        if (left > 0) await write(Buffer.alloc(left));
        await write("\n");
        ok.push([p, mark]);
      } finally { closeSync(fd); }
    }
    let cmd = `commit refs/tianshu/${this.sessionId}/${name}\ncommitter tianshu <local@tianshu> ${Math.floor(Date.now() / 1000)} +0000\ndata ${Buffer.byteLength(name)}\n${name}\n`;
    if (parent) cmd += `from ${parent}\n`;
    for (const [p, mk] of ok) cmd += `M 100644 :${mk} ${quote(p)}\n`;
    for (const p of deleted) cmd += `D ${quote(p)}\n`;
    await write(cmd + "\ndone\n");
    child.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`fast-import → ${code}: ${err.slice(0, 300)}`);
    // 读不了的文件不算进清单：下一轮再试
    for (const s of skipped) now.files.delete(s.p);
    writeFileSync(this.manifestPath(), JSON.stringify(Object.fromEntries(now.files)));
    const commit = (await this.git(["rev-parse", `refs/tianshu/${this.sessionId}/${name}`])).out.trim();
    return { commit, sent: ok.length, deleted: deleted.length, skipped, big: now.big, links: now.links.length };
  }
}
