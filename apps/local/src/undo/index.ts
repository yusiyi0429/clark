import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { copyFile, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TLocalRestoreFailure, TLocalSessionRestoreResponse, TLocalUndo } from "@warmap/contracts";
import { isInside } from "../folders.js";
import { readJson, writeJsonAtomic } from "../store.js";
import { Copies } from "./copies.js";
import { DOC_EXT, SKIP_DIRS, Shadow, isPlaceholder, scan, type Change } from "./shadow.js";
import { commandPaths } from "../agents/pathGuard.js";

/**
 * 改、删前留一份（11/11 本人定，ADR 0039，契约 LocalUndo）。每个不在 git 工作树里做的会话一个 SessionUndo：
 * - 工作目录是本人的普通文件夹：开工时在后台整份留一份（影子仓库），每一轮开始前、结束后各留一份，命令、脚本、子 agent 改的都能恢复；
 * - 文件夹太大、在同步盘里、盘不够、没留成，或工作目录是本机自己的专用目录：只「改前拷一份」（执行方用改文件工具改的已有文件）。
 * 恢复回到「这个会话第一次动它之前」：快照里是它第一次变了的那一轮开始前那份，拷的是第一次拷的那份；会话新建的删掉。恢复前先留一份现在的样子。
 */
export const UNDO_LIMITS = {
  files: 30_000,
  bytes: 3 * 1024 ** 3,
  bigFile: 32 * 1024 ** 2,
  scanMs: 3_000,
  /** 命令等这一轮开头那份最多等多久，等不到按「只改前拷一份」的规矩办（删挪覆盖照样问）。 */
  commandWaitMs: 10_000,
  keepDays: 14,
  totalBytes: 20 * 1024 ** 3,
  freeShare: 0.1,
  /** 盘上至少还要剩：这次要留的 × 2 + 5GB。 */
  spareBytes: 5 * 1024 ** 3,
};

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WIN = process.platform === "win32";
const norm = (p: string) => (WIN ? resolve(p).toLowerCase() : resolve(p));
const posix = (p: string) => p.split(sep).join("/");
const IN_USE = new Set(["EBUSY", "EPERM", "EACCES"]);

/** 同步盘：整份留会把云端的占位文件全下载下来，恢复、删除会同步到别的设备。按路径认（Node 读不了「占位」属性）。 */
const SYNC_NAMES = /[\\/](OneDrive[^\\/]*|Dropbox|iCloudDrive|iCloud Drive|Nutstore|坚果云[^\\/]*|BaiduSyncdisk|百度网盘同步[^\\/]*|WPS云盘|WPSDrive|Google Drive)([\\/]|$)/i;
export function isSyncFolder(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const roots = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter((r): r is string => Boolean(r));
  return roots.some((r) => isInside(r, p)) || SYNC_NAMES.test(resolve(p));
}

interface Turn {
  /** 第几轮（1 起，同 files_changed 的 turn）。 */
  n?: number;
  start: string;
  end: string | null;
  /** 这一轮里变了的（start → end），轮结束时算好。 */
  changed?: Change[];
}
interface Meta {
  root: string | null;
  gitDir: string | null;
  state: TLocalUndo["state"];
  reason?: NonNullable<TLocalUndo["reason"]>;
  message?: string;
  excludes: string[];
  turns: Turn[];
  /** 恢复过的（规范化路径 → 时间）；之后会话又改了它就去掉。 */
  restored: Record<string, string>;
  lastActivity: string;
  /** 同步盘里：只给本地已有的文档类文件留一份（不读占位文件，11/11）。 */
  docsOnly?: boolean;
  /** 到第几轮了（执行方每轮开头报 agent_info 加一）、这一轮还在不在做。 */
  turn?: number;
  inTurn?: boolean;
}

/** 一个文件在一段时间里的前后两份（第 72 条）：null 是那时没有这个文件；before 为 undefined 是拿不到改前那份（只知道改过）。 */
export interface ChangePair {
  abs: string;
  /** 会话根里的相对路径（正斜杠），根外面的是绝对路径。 */
  path: string;
  turn: number | null;
  before: Buffer | null | undefined;
  after: Buffer | null;
  /** after 就是磁盘上现在的样子（能按处恢复的前提）。 */
  afterIsDisk: boolean;
}

/** 一轮结束时这一轮动过的文件（files_changed 的原料）。 */
export interface TurnFile { abs: string; path: string; change: "added" | "modified" | "deleted" }

export interface UndoFile {
  /** 会话根里的相对路径（正斜杠），根外面的是绝对路径。 */
  path: string;
  absolutePath: string;
  source: "snapshot" | "copy";
  change: "added" | "modified" | "deleted";
  restorable: boolean;
  restoredAt?: string;
}

export class SessionUndo {
  private readonly copies: Copies;
  private readonly shadow: Shadow | null;
  private readonly index: string;
  /** 正在留的那一份（开工、轮开始、轮结束排成一串）。 */
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private opened = false;
  /** 同步盘里最近一份留下的文档（规范化绝对路径）：只有它们算快照管得住。 */
  private docs = new Set<string>();

  constructor(
    readonly id: string,
    private readonly dir: string,
    private meta: Meta,
    private readonly hooks: { isOwn(p: string): boolean; changed(): void; notice(level: "info" | "warn", text: string): void; free(path: string): number; turnFiles?(turn: number, files: TurnFile[]): void },
  ) {
    this.copies = new Copies(dir);
    this.shadow = meta.gitDir && meta.root ? new Shadow(meta.gitDir, meta.root) : null;
    this.index = meta.gitDir ? join(meta.gitDir, `index-${id}`) : "";
  }

  view(): TLocalUndo {
    return { state: this.meta.state, ...(this.meta.reason ? { reason: this.meta.reason } : {}), ...(this.meta.message ? { message: this.meta.message } : {}) };
  }

  private save() {
    this.meta.lastActivity = new Date().toISOString();
    writeJsonAtomic(join(this.dir, "meta.json"), this.meta);
  }

  private set(state: TLocalUndo["state"], reason?: NonNullable<TLocalUndo["reason"]>, message?: string) {
    this.meta.state = state;
    if (reason) this.meta.reason = reason; else delete this.meta.reason;
    if (message) this.meta.message = message.slice(0, 500); else delete this.meta.message;
    this.save();
    this.hooks.changed();
  }

  private chain<T>(fn: () => Promise<T>): Promise<T> {
    this.busy += 1;
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined).finally(() => { this.busy -= 1; });
    return p;
  }

  /** 开工（和拉起执行方同时）：先数一遍，够小就整份留一份；不等。本机重启后续上的会话不再重做。 */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    if (this.meta.state !== "preparing" || !this.shadow) return;
    void this.chain(async () => {
      const root = this.meta.root!;
      // 同步盘里：只留本地已有的文档类文件（不读占位文件，免得把云端的都下载下来）
      this.meta.docsOnly = isSyncFolder(root);
      let s = await this.scanNow();
      // 太大：也退到只留文档（11/11 主会话定）；连文档都太多才只改前拷一份
      const tooLarge = s.tooLarge && !this.meta.docsOnly;
      if (tooLarge) { this.meta.docsOnly = true; s = await this.scanNow(); }
      if (s.tooLarge) return this.degrade("too_large", "这个文件夹太大，只给执行方直接改的文件留一份");
      if (this.hooks.free(this.dir) < s.bytes * 2 + UNDO_LIMITS.spareBytes) return this.degrade("disk_full", "本机的盘不够，只给执行方直接改的文件留一份");
      try {
        await this.shadow!.init();
        const base = await this.shadow!.snapshot(this.index, this.ref(0, "start"), null, s.excludes, "开工前", s.included);
        this.meta.excludes = s.excludes;
        this.meta.turns = [{ start: base, end: null }];
        if (tooLarge) this.set("ready", "too_large", "这个文件夹太大，只给里面的文档留一份");
        else if (this.meta.docsOnly) this.set("ready", "sync_folder", "这个文件夹在同步盘里，只给本地已有的文档留一份");
        else this.set("ready");
      } catch (e) {
        this.degrade("failed", `没留成：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** 数一遍；同步盘里只挑本地已有的文档类文件（不超过 32MB、不是占位）。 */
  private async scanNow() {
    const limits = { files: UNDO_LIMITS.files, bytes: UNDO_LIMITS.bytes, bigFile: UNDO_LIMITS.bigFile, ms: UNDO_LIMITS.scanMs };
    if (!this.meta.docsOnly) return scan(this.meta.root!, limits);
    const s = await scan(this.meta.root!, limits, (rel, size, blocks) => DOC_EXT.has(extname(rel).toLowerCase()) && !isPlaceholder(size, blocks));
    this.docs = new Set(s.included!.map((r) => norm(join(this.meta.root!, r))));
    return s;
  }

  /** 每一轮前后留一份时：同步盘里重新挑一遍要留的文档（新建的文档也算）。 */
  private async include(): Promise<string[] | undefined> {
    return this.meta.docsOnly ? (await this.scanNow()).included : undefined;
  }

  private degrade(reason: NonNullable<TLocalUndo["reason"]>, text: string) {
    this.set("touched_only", reason, text);
    this.hooks.notice("warn", `${text}；用命令删、挪、覆盖已有文件时照样问你`);
  }

  private ref(n: number, at: "start" | "end") {
    return `refs/tianshu/${this.id}/t${n}-${at}`;
  }

  /** 执行方的事件：新的一轮开始（agent_info）前留一份，一轮结束（turn_end）后留一份并记下这一轮改了哪些。 */
  onEvent(type: string): void {
    if (type === "agent_info") {
      if (!this.meta.inTurn) { this.meta.turn = (this.meta.turn ?? 0) + 1; this.meta.inTurn = true; this.save(); }
      this.turnStart(this.meta.turn!);
    } else if (type === "turn_end" && this.meta.inTurn) {
      this.meta.inTurn = false;
      this.save();
      this.turnEnd(this.meta.turn!);
    }
  }

  private turnStart(n: number) {
    if (!this.shadow || this.meta.state === "touched_only") return;
    void this.chain(async () => {
      const turns = this.meta.turns;
      const last = turns.at(-1);
      if (this.meta.state !== "ready" || !last) return;
      // 开工那份就是第一轮的开头；一轮里又报一次不重留
      if (last.end === null) { last.n ??= n; this.save(); return; }
      const start = await this.shadow!.snapshot(this.index, this.ref(turns.length, "start"), last.end, this.meta.excludes, `第 ${n} 轮开始前`, await this.include());
      turns.push({ n, start, end: null });
      this.save();
    }).catch((e) => this.degrade("failed", `没留成：${e instanceof Error ? e.message : String(e)}`));
  }

  /** 一轮结束：整份留了的再留一份、记下这一轮变了哪些；不管哪种都把这一轮动过的文件报出去（files_changed）。 */
  private turnEnd(n: number) {
    void this.chain(async () => {
      const files: TurnFile[] = [];
      const turns = this.meta.turns;
      const last = turns.at(-1);
      if (this.shadow && this.meta.state === "ready" && last && last.end === null) {
        last.n ??= n;
        last.end = await this.shadow.snapshot(this.index, this.ref(turns.length - 1, "end"), last.start, this.meta.excludes, `第 ${n} 轮结束后`, await this.include());
        last.changed = await this.shadow.diff(last.start, last.end);
        for (const c of last.changed) {
          delete this.meta.restored[norm(join(this.meta.root!, c.path))];
          files.push({ abs: join(this.meta.root!, c.path), path: c.path, change: c.status === "A" ? "added" : c.status === "D" ? "deleted" : "modified" });
        }
      }
      const seen = new Set(files.map((f) => norm(f.abs)));
      for (const e of this.copies.list()) {
        const v = this.copies.version(e, n);
        if (!v || seen.has(norm(e.path)) || !this.copies.changedSince(e.path, v)) continue;
        files.push({ abs: e.path, path: this.relOf(e.path), change: !v.copy ? "added" : existsSync(e.path) ? "modified" : "deleted" });
      }
      this.save();
      this.hooks.changed();
      if (files.length) this.hooks.turnFiles?.(n, files.sort((a, b) => a.path.localeCompare(b.path)));
    }).catch((e) => this.degrade("failed", `没留成：${e instanceof Error ? e.message : String(e)}`));
  }

  private relOf(abs: string): string {
    const root = this.meta.root;
    return root && isInside(root, abs) ? posix(relative(root, abs)) : posix(abs);
  }

  /** 最近做完的那一轮（一轮正在做时是上一轮）。 */
  latestTurn(): number | null {
    const t = (this.meta.turn ?? 0) - (this.meta.inTurn ? 1 : 0);
    return t > 0 ? t : null;
  }

  /**
   * 一个文件在一段时间里的前后两份（第 72 条）：range turn 是那一轮开始前 → 那一轮结束后（最近做完的那一轮、现在没在做时，结束后取磁盘上现在的）；
   * session 是会话第一次动它之前 → 磁盘上现在。这个会话（那一轮）没动过它回 null。
   */
  async pair(path: string, range: "turn" | "session", turn?: number): Promise<ChangePair | null> {
    await this.queue;
    const root = this.meta.root;
    const abs = root && !isAbsolute(path) ? join(root, path) : resolve(path);
    const disk = existsSync(abs) ? readFileSync(abs) : null;
    const latest = this.latestTurn();
    const n = range === "turn" ? turn ?? latest : null;
    if (range === "turn" && !n) return null;
    const rel = root && isInside(root, abs) ? posix(relative(root, abs)) : null;
    const same = (p: string) => (WIN ? p.toLowerCase() === rel!.toLowerCase() : p === rel);
    if (this.shadow && rel) {
      const ended = this.meta.turns.filter((t) => t.end !== null && t.changed?.some((c) => same(c.path)));
      const t = range === "turn" ? ended.find((x) => x.n === n) : ended[0];
      if (t) {
        const name = t.changed!.find((c) => same(c.path))!.path;
        const afterIsDisk = range === "session" || (n === latest && !this.meta.inTurn);
        return {
          abs, path: name, turn: n, before: await this.shadow.read(t.start, name),
          after: afterIsDisk ? disk : await this.shadow.read(t.end!, name), afterIsDisk,
        };
      }
    }
    const e = this.copies.get(abs);
    if (!e) return null;
    // 拷的这一路没有每轮结束后那份：「这一轮」只看最近做完的那一轮，结束后就是磁盘上现在的
    const v = range === "turn" ? (n === latest && !this.meta.inTurn ? this.copies.version(e, n!) : undefined) : e;
    if (!v || !this.copies.changedSince(abs, v)) return null;
    return { abs, path: this.relOf(abs), turn: n, before: this.copies.read(v.copy), after: disk, afterIsDisk: true };
  }

  /** 按处写回：先把现在的样子留一份（before-restore），再写。被占用时抛 EBUSY 一类的错。 */
  async writeBack(abs: string, body: string): Promise<void> {
    if (existsSync(abs)) {
      const keep = join(this.dir, "before-restore", new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(keep, { recursive: true });
      await copyFile(abs, join(keep, createHash("sha1").update(norm(abs)).digest("hex").slice(0, 12)));
    }
    await writeFile(abs, body);
    this.save();
    this.hooks.changed();
  }

  /** 快照管得住这个路径：整份留好了、这一刻没在留、在工作目录里、不在不留的地方。 */
  private snapshotCovers(p: string): boolean {
    const root = this.meta.root;
    if (!root || this.meta.state !== "ready" || this.busy > 0) return false;
    const rel = relative(root, resolve(p));
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    // 工作目录本身（命令在这里跑、认不出路径时按它算）：整份留了就算；同步盘里只留了文档，不算
    if (!rel) return !this.meta.docsOnly;
    const r = posix(rel);
    if (r.split("/").some((part) => SKIP_DIRS.includes(part))) return false;
    if (this.meta.docsOnly) return this.docs.has(norm(p));
    return !this.meta.excludes.some((x) => (WIN ? r.toLowerCase() === x.toLowerCase() || r.toLowerCase().startsWith(`${x.toLowerCase()}/`) : r === x || r.startsWith(`${x}/`)));
  }

  /** 改、删、覆盖这里有没有兜底（pathGuard 的 covered）：本机自己的目录、快照管得住的、拷过一份的。 */
  covers(p: string): boolean {
    return this.hooks.isOwn(p) || this.snapshotCovers(p) || this.copies.has(p);
  }

  /**
   * 放行前（批准通道里，本机自己放行和本人点允许都走这里）：改文件工具要改的、快照管不到的已有文件先拷一份；
   * 命令等这一轮开头那份留好，最多等 commandWaitMs。
   */
  async beforeWrite(tool: string, input: Record<string, unknown>, cwd: string): Promise<void> {
    if (FILE_TOOLS.has(tool)) {
      const p = input.file_path ?? input.notebook_path;
      if (typeof p !== "string" || !p) return;
      const abs = resolve(cwd, p);
      if (this.hooks.isOwn(abs) || this.snapshotCovers(abs)) return;
      await this.copies.save(abs, this.meta.turn ?? 0);
      this.save();
      return;
    }
    if (!SHELL_TOOLS.has(tool)) return;
    if (this.busy > 0) await Promise.race([this.queue, new Promise((r) => setTimeout(r, UNDO_LIMITS.commandWaitMs).unref())]);
    // 命令里认得出路径的已有文档，快照管不到的（同步盘里只在云端的、工作目录以外的、大文件）先拷一份：
    // 只在云端的会被拉下来，但命令本来就要拉它
    const cmd = typeof input.command === "string" ? input.command : "";
    for (const w of commandPaths(cmd, tool === "Bash").slice(0, 50)) {
      const abs = resolve(cwd, w);
      if (!DOC_EXT.has(extname(abs).toLowerCase()) || this.hooks.isOwn(abs) || this.snapshotCovers(abs)) continue;
      const st = existsSync(abs) ? statSync(abs) : null;
      if (!st?.isFile() || st.size > UNDO_LIMITS.bigFile) continue;
      await this.copies.save(abs, this.meta.turn ?? 0);
      this.save();
    }
  }

  /** 这个会话动过的、有留一份的文件（等正在留的那份留完再算）。 */
  async files(): Promise<UndoFile[]> {
    await this.queue;
    const out = new Map<string, UndoFile>();
    const root = this.meta.root;
    if (root) {
      // 按轮的先后：第一次出现时开工前有没有它定了是不是新建的；之后看现在还在不在
      for (const t of this.meta.turns) {
        for (const c of t.changed ?? []) {
          const abs = join(root, c.path);
          const k = norm(abs);
          const now = existsSync(abs);
          const first = out.get(k);
          if (!first) out.set(k, { path: c.path, absolutePath: abs, source: "snapshot", change: c.status === "A" ? "added" : now ? "modified" : "deleted", restorable: true, ...this.restoredAt(k) });
          else if (first.change !== "added") first.change = now ? "modified" : "deleted";
        }
      }
    }
    for (const e of this.copies.list()) {
      const k = norm(e.path);
      if (out.has(k) || (!this.copies.changed(e) && !this.meta.restored[k])) continue;
      const inRoot = root && isInside(root, e.path);
      const now = existsSync(e.path);
      out.set(k, {
        path: inRoot ? posix(relative(root, e.path)) : posix(e.path), absolutePath: e.path, source: "copy",
        change: !e.copy ? "added" : now ? "modified" : "deleted", restorable: true, ...this.restoredAt(k),
      });
    }
    return [...out.values()];
  }

  private restoredAt(k: string): { restoredAt?: string } {
    const at = this.meta.restored[k];
    return at ? { restoredAt: at } : {};
  }

  /** 第一次变了的那一轮开始前那份（快照这一路）。 */
  private firstStart(rel: string): string | null {
    for (const t of this.meta.turns) if (t.changed?.some((c) => c.path === rel)) return t.start;
    return null;
  }

  /** 恢复：paths 用 path 或 absolutePath，不给就是全部。恢复前先留一份现在的样子（快照这一路再留一份，拷的这一路拷到 before-restore）。 */
  async restore(paths?: string[]): Promise<TLocalSessionRestoreResponse> {
    const all = await this.files();
    const want = paths ? new Set(paths.map((p) => norm(this.meta.root && !isAbsolute(p) ? join(this.meta.root, p) : p))) : null;
    const targets = want ? all.filter((f) => want.has(norm(f.absolutePath))) : all;
    const restored: string[] = [];
    const failed: TLocalRestoreFailure[] = [];
    if (want) {
      const known = new Set(targets.map((f) => norm(f.absolutePath)));
      for (const p of paths!) {
        const k = norm(this.meta.root && !isAbsolute(p) ? join(this.meta.root, p) : p);
        if (!known.has(k)) failed.push({ path: p, reason: "no_copy", message: "这个会话没有给它留一份" });
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (this.shadow && this.meta.state === "ready" && targets.some((f) => f.source === "snapshot")) {
      const last = this.meta.turns.at(-1);
      await this.chain(async () => this.shadow!.snapshot(this.index, `refs/tianshu/${this.id}/restore-${stamp}`, last?.end ?? last?.start ?? null, this.meta.excludes, "恢复前", await this.include()));
    }
    const now = new Date().toISOString();
    for (const f of targets) {
      try {
        if (f.source === "copy") {
          await this.copies.restore(this.copies.get(f.absolutePath)!, stamp);
        } else {
          const start = this.firstStart(f.path);
          const body = start ? await this.shadow!.read(start, f.path) : null;
          if (!start) throw Object.assign(new Error("没有留一份"), { code: "NOCOPY" });
          if (body === null) await rm(f.absolutePath, { force: true });
          else { await mkdir(dirname(f.absolutePath), { recursive: true }); await writeFile(f.absolutePath, body); }
        }
        this.meta.restored[norm(f.absolutePath)] = now;
        restored.push(f.path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        failed.push(code === "NOCOPY" ? { path: f.path, reason: "no_copy", message: "这个会话没有给它留一份" }
          : IN_USE.has(code) ? { path: f.path, reason: "in_use", message: "文件正被别的程序打开（比如 Excel），关掉再点恢复" }
          : { path: f.path, reason: "error", message: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
      }
    }
    this.save();
    this.hooks.changed();
    return { restored, failed };
  }
}

/** 本机所有会话的留一份：数据目录 undo/ 下，repos/<文件夹哈希>.git 是影子仓库（同一个文件夹的会话共用），sessions/<会话>/ 是清单和拷的文件。 */
export class UndoStore {
  private readonly open = new Map<string, SessionUndo>();

  constructor(private readonly dir: string, private readonly hooks: {
    isOwn(p: string): boolean; changed(id: string): void; notice(id: string, level: "info" | "warn", text: string): void; free?(path: string): number;
    /** 一轮结束、这一轮动过文件时（第 72 条 files_changed）。 */
    turnFiles?(id: string, turn: number, files: TurnFile[]): void;
  }) {}

  private sessionDir(id: string) {
    return join(this.dir, "sessions", id.replace(/[^A-Za-z0-9_-]/g, "_"));
  }

  /** 会话的留一份；root 是要整份留的工作目录（本人的普通文件夹），本机自己的目录、卡的工作树给 null。已经有了就接着用。 */
  for(id: string, root: string | null): SessionUndo {
    const had = this.open.get(id);
    if (had) return had;
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true });
    const gitDir = root ? join(this.dir, "repos", `${createHash("sha256").update(norm(root)).digest("hex").slice(0, 16)}.git`) : null;
    const fresh: Meta = { root, gitDir, state: root ? "preparing" : "touched_only", excludes: [], turns: [], restored: {}, lastActivity: new Date().toISOString() };
    const meta = readJson<Meta>(join(dir, "meta.json"), fresh);
    // 本机在留第一份的途中退出了：重新留
    if (meta.state === "preparing") meta.turns = [];
    const u = new SessionUndo(id, dir, meta, {
      isOwn: this.hooks.isOwn, changed: () => this.hooks.changed(id), notice: (level, text) => this.hooks.notice(id, level, text), free: this.hooks.free ?? freeBytes,
      turnFiles: (turn, files) => this.hooks.turnFiles?.(id, turn, files),
    });
    this.open.set(id, u);
    return u;
  }

  /** 已经开过的（不新建）。 */
  peek(id: string): SessionUndo | undefined {
    return this.open.get(id) ?? (existsSync(join(this.sessionDir(id), "meta.json")) ? this.for(id, null) : undefined);
  }

  /**
   * 清理（本机程序启动时）：会话最后一次活动后 keepDays 天清掉；总量超过 totalBytes 或盘剩余的 freeShare（取小的）时从最旧的清起。
   * 在跑的（live）不清。没有会话挂着的影子仓库整个删掉。
   */
  async cleanup(live: Set<string>, now = Date.now()): Promise<string[]> {
    const sessions = join(this.dir, "sessions");
    if (!existsSync(sessions)) return [];
    const metas = readdirSync(sessions).map((id) => ({ id, meta: readJson<Meta | null>(join(sessions, id, "meta.json"), null) }))
      .filter((x): x is { id: string; meta: Meta } => Boolean(x.meta))
      .sort((a, b) => a.meta.lastActivity.localeCompare(b.meta.lastActivity));
    const dropped: string[] = [];
    const drop = async (id: string, meta: Meta) => {
      if (meta.gitDir && meta.root && existsSync(meta.gitDir)) await new Shadow(meta.gitDir, meta.root).drop(id).catch(() => undefined);
      rmSync(join(sessions, id), { recursive: true, force: true });
      if (meta.gitDir) rmSync(join(meta.gitDir, `index-${id}`), { force: true });
      this.open.delete(id);
      dropped.push(id);
    };
    for (const { id, meta } of metas) {
      if (!live.has(id) && now - Date.parse(meta.lastActivity) > UNDO_LIMITS.keepDays * 86_400_000) await drop(id, meta);
    }
    const cap = Math.min(UNDO_LIMITS.totalBytes, freeBytes(this.dir) * UNDO_LIMITS.freeShare + sizeOf(this.dir));
    for (const { id, meta } of metas) {
      if (sizeOf(this.dir) <= cap) break;
      if (live.has(id) || dropped.includes(id)) continue;
      await drop(id, meta);
      await this.pruneRepos();
    }
    await this.pruneRepos();
    return dropped;
  }

  private async pruneRepos() {
    const repos = join(this.dir, "repos");
    if (!existsSync(repos)) return;
    for (const name of readdirSync(repos)) {
      const gitDir = join(repos, name);
      if (!(await new Shadow(gitDir, this.dir).used().catch(() => true))) rmSync(gitDir, { recursive: true, force: true });
    }
  }
}

function freeBytes(dir: string): number {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function sizeOf(dir: string): number {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { try { n += statSync(join(e.parentPath, e.name)).size; } catch { /* 刚删 */ } }
  }
  return n;
}
