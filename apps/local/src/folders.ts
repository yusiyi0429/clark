import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { LOCAL_SCRATCH_FOLDER, type TLocalFolder, type TLocalProjectFolder } from "@warmap/contracts";

/**
 * 一个项目在这台电脑上绑的文件夹（projects.json）。folderIds 有顺序，第一个是工作目录（设计 17.2 第 46 条）；
 * 11/10 以前只记一个 folderId，照读。folderId 接着写（等于第一个）：换回老的本机程序时它还认得工作目录。
 */
interface ProjectBinding { folderId: string | null; folderIds?: string[]; name: string | null; updatedAt: string }
const boundIds = (b: ProjectBinding | undefined): string[] => b?.folderIds ?? (b?.folderId ? [b.folderId] : []);
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import { homeDir } from "./agents/claudeEnv.js";

/** 真实路径：还不存在的路径（要新建的文件）按最深一层已存在的上级解析链接，再接上后面的部分，免得借目录链接写到外面。 */
const norm = (p: string) => {
  let dir = resolve(p);
  const rest: string[] = [];
  let r: string;
  for (;;) {
    try { r = join(realpathSync.native(dir), ...rest); break; } catch { /* 还不存在，往上找 */ }
    const parent = dirname(dir);
    if (parent === dir) { r = resolve(p); break; }
    rest.unshift(basename(dir));
    dir = parent;
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
};

const under = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** p 是否在 root 里面（含 root 本身）；先解析符号链接、目录链接，防止借链接跳出去。 */
export function isInside(root: string, p: string): boolean {
  return under(norm(root), norm(p));
}

/** 同一批路径对同一组根目录判断时用：根目录只解析一次。 */
export function insideAny(roots: string[]): (p: string) => boolean {
  const rs = roots.map(norm);
  return (p) => { const n = norm(p); return rs.some((r) => under(r, n)); };
}

/** Windows 的保留名（带扩展名的也算，如 CON.txt）。 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/** 新建文件夹的名字（一层）有什么不对；没问题为 null。message 可直接给人看。 */
export function folderNameProblem(name: string): string | null {
  if (!name.trim()) return "名字不能是空的";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return "名字里不能有 / \\ : * ? \" < > | 这些字符";
  if (name === "." || name === "..") return "名字不能是 . 或 ..";
  if (/[. ]$/.test(name)) return "名字不能以点或空格结尾";
  if (RESERVED.test(name)) return `「${name}」是 Windows 保留的名字，换一个`;
  return null;
}

/** 本人允许本机程序读写的文件夹：经本机系统选择框添加，或经「新建文件夹」新建的空文件夹。调研专题另有本机程序自己的专用目录。 */
export class Folders {
  private readonly file: string;
  private readonly projectsFile: string;
  constructor(private readonly dataDir: string, private readonly home: string = homeDir()) {
    this.file = join(dataDir, "folders.json");
    this.projectsFile = join(dataDir, "projects.json");
  }

  /** 不合规矩的旧条目（这条规矩之前加的）不算数。 */
  list(): TLocalFolder[] {
    return readJson<TLocalFolder[]>(this.file, []).filter((f) => !this.rejectReason(f.path));
  }

  /**
   * 太宽或放着钥匙的文件夹不让选：整个磁盘、主目录及其上级（选了等于什么都允许，越界检查失效）；
   * Claude 配置目录、本机程序数据目录，以及它们的上级（里面有登录凭据和钥匙）。
   */
  rejectReason(path: string): string | null {
    if (parse(resolve(path)).root === resolve(path)) return "不能选整个磁盘，请选具体的项目文件夹";
    if (isInside(path, this.home)) return "不能选主目录或它的上级文件夹，请选具体的项目文件夹";
    for (const dir of [join(this.home, ".claude"), this.dataDir]) {
      if (isInside(dir, path) || isInside(path, dir)) return "这个文件夹里有 Claude 或天枢本机程序的登录信息和钥匙，不能选";
    }
    return null;
  }

  /** 路径在不在本人允许的某个文件夹里。 */
  contains(p: string): boolean {
    return this.list().some((f) => isInside(f.path, p));
  }

  add(path: string): TLocalFolder {
    const existing = this.list().find((f) => norm(f.path) === norm(path));
    if (existing) return existing;
    const folder: TLocalFolder = { id: randomBytes(6).toString("hex"), path: resolve(path), label: basename(resolve(path)) || path, addedAt: nowIso() };
    writeJsonAtomic(this.file, [...this.list(), folder]);
    return folder;
  }

  /**
   * 新建一个空文件夹并加进允许的列表（「新建文件夹…」）：parent 不给时是桌面（没有桌面时是主目录）；只能建在主目录下或已允许的文件夹下。
   * 不合规矩抛 FolderError（validation 或 conflict，message 可直接给人看）。
   */
  create(name: string, parent?: string): TLocalFolder {
    const why = folderNameProblem(name);
    if (why) throw new FolderError("validation", why);
    const desktop = join(this.home, "Desktop");
    const base = resolve(parent ?? (existsSync(desktop) ? desktop : this.home));
    if (parent !== undefined && !isAbsolute(parent)) throw new FolderError("validation", "父目录要写完整路径");
    if (!existsSync(base) || !statSync(base).isDirectory()) throw new FolderError("validation", "父目录不存在");
    if (!isInside(this.home, base) && !this.contains(base)) throw new FolderError("validation", "只能建在你的主目录下，或已经允许的文件夹下");
    const target = join(base, name);
    const reject = this.rejectReason(target);
    if (reject) throw new FolderError("validation", reject);
    if (readdirSync(base).some((n) => n.toLowerCase() === name.toLowerCase())) throw new FolderError("conflict", `「${name}」已经有了，换个名字`);
    mkdirSync(target);
    return this.add(target);
  }

  /** 「随手」项目的文件夹：主目录/天枢/随手，没有就建（已经有了不动里面的东西），加进允许的列表。不合规矩、链接到主目录外抛 FolderError（validation），被文件占着抛 conflict。 */
  ensureScratch(): TLocalFolder {
    const target = join(this.home, ...LOCAL_SCRATCH_FOLDER);
    const reject = this.rejectReason(target);
    if (reject) throw new FolderError("validation", reject);
    if (!isInside(this.home, target)) throw new FolderError("validation", "只能建在你的主目录下"); // 「天枢」是指向外面的目录链接时
    const occupied = () => new FolderError("conflict", "「天枢/随手」被一个文件占着");
    try { mkdirSync(target, { recursive: true }); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "EEXIST" || code === "ENOTDIR" ? occupied() : e; // 随手、或上一层的天枢是个文件
    }
    if (!statSync(target).isDirectory()) throw occupied();
    return this.add(target);
  }

  remove(id: string): boolean {
    const list = this.list();
    if (!list.some((f) => f.id === id)) return false;
    writeJsonAtomic(this.file, list.filter((f) => f.id !== id)); // 绑着它的项目读出来就没有它了（只认还在允许列表里的文件夹）
    return true;
  }

  // ───────── 项目在这台电脑上的文件夹（新首页设计 16.6） ─────────

  private bindings(): Record<string, ProjectBinding> {
    return readJson<Record<string, ProjectBinding>>(this.projectsFile, {});
  }

  /** 绑着、而且还在允许的列表里的（删掉的文件夹不算，后面的往前顶）。 */
  private bound(b: ProjectBinding | undefined, list = this.list()): TLocalFolder[] {
    return boundIds(b).flatMap((id) => list.find((f) => f.id === id) ?? []);
  }

  private projectView(projectId: string, b: ProjectBinding): TLocalProjectFolder {
    const folders = this.bound(b).map((f) => ({ id: f.id, path: f.path, label: f.label }));
    return { projectId, name: b.name, folder: folders[0] ?? null, folders, updatedAt: b.updatedAt };
  }

  projects(): TLocalProjectFolder[] {
    return Object.entries(this.bindings()).map(([id, b]) => this.projectView(id, b));
  }

  /** 整份换掉项目绑的文件夹（有顺序，第一个是工作目录；空的是全部解绑）。有一个不在允许的列表里回 null，一个都不改。 */
  setProjectFolders(projectId: string, folderIds: string[], name?: string): TLocalProjectFolder | null {
    const list = this.list();
    if (folderIds.some((id) => !list.some((f) => f.id === id))) return null;
    const bindings = this.bindings();
    bindings[projectId] = { folderId: folderIds[0] ?? null, folderIds, name: name ?? bindings[projectId]?.name ?? null, updatedAt: nowIso() };
    writeJsonAtomic(this.projectsFile, bindings);
    return this.projectView(projectId, bindings[projectId]!);
  }

  /** 只定工作目录（老网页的写法，选文件夹、新建文件夹、拉仓库带项目时也是）：换掉第一个，其余的不动；null 是全部解绑。不在允许的列表里回 null。 */
  bindProject(projectId: string, folderId: string | null, name?: string): TLocalProjectFolder | null {
    if (!folderId) return this.setProjectFolders(projectId, [], name);
    const rest = this.bound(this.bindings()[projectId]).slice(1).map((f) => f.id).filter((id) => id !== folderId);
    return this.setProjectFolders(projectId, [folderId, ...rest], name);
  }

  /** 项目在这台电脑上绑的文件夹的路径，按顺序（第一个是工作目录）；已不在允许的列表里的不算。 */
  projectFolders(projectId: string): string[] {
    return this.bound(this.bindings()[projectId]).map((f) => f.path);
  }

  /** 项目的工作目录（没绑为 null）。 */
  projectFolder(projectId: string): string | null {
    return this.projectFolders(projectId)[0] ?? null;
  }

  /** 连接页的文件夹列表：每个文件夹挂着哪几个项目。 */
  listWithProjects(): TLocalFolder[] {
    const bindings = Object.entries(this.bindings());
    return this.list().map((f) => ({ ...f, projects: bindings.filter(([, b]) => boundIds(b).includes(f.id)).map(([projectId, b]) => ({ projectId, name: b.name })) }));
  }

  /** 专题、规划员没给目录时用的专用目录；没绑文件夹的项目，卡在 projects/<项目 id> 里做（都在本机程序的数据目录里）。 */
  ownDir(group: "topics" | "plans" | "projects", id: string): string {
    const dir = join(this.dataDir, group, id.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 卡的工作树放在这里（ADR 0038）：worktrees/<cardId>。 */
  worktreeDir(cardId: string): string {
    return join(this.dataDir, "worktrees", cardId.replace(/[^A-Za-z0-9_-]/g, "_"));
  }

  isAllowed(cwd: string): boolean {
    return this.contains(cwd) || this.isOwn(cwd);
  }

  /** 本机自己给会话建的目录（专题、规划员、没绑文件夹的项目、卡的工作树）：里面只有执行方写的东西，工作树还有 git。 */
  isOwn(p: string): boolean {
    return ["topics", "plans", "projects", "worktrees"].some((g) => isInside(join(this.dataDir, g), p));
  }
}

export class FolderError extends Error {
  constructor(readonly code: "validation" | "conflict", message: string) { super(message); }
}
