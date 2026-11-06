import { isAbsolute, resolve } from "node:path";

/**
 * 找出一次工具调用里不在允许的文件夹里的路径，给权限请求标红（ADR 0031）。
 * 文件类工具按字段取路径，准；Bash、PowerShell 只能从命令里尽力认出像路径的词，认不全也会认错，所以只标红、不自动拒绝。
 */
export interface PathScope {
  cwd: string;
  home: string;
  /** 这个路径在不在本会话允许的范围里（本人允许的文件夹，或本会话的工作目录）。 */
  isAllowed(path: string): boolean;
  platform?: NodeJS.Platform;
}

const MAX_PATHS = 20;
const FILE_FIELDS: Record<string, string[]> = {
  Read: ["file_path"], Write: ["file_path"], Edit: ["file_path"], MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"], Glob: ["path", "pattern"], Grep: ["path"],
};
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** 不是读写数据的特殊设备名。 */
const HARMLESS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "nul", "$null"]);
const HOME_VARS = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME)(?=[\\/]|$)/i;

/** 把一个词解析成绝对路径；不像路径（相对路径且不带 ..）返回 null：相对路径本来就在工作目录里。 */
function toAbsolute(word: string, s: PathScope): string | null {
  if (!word || word.includes("://") || HARMLESS.has(word.toLowerCase())) return null;
  const win = (s.platform ?? process.platform) === "win32";
  // 通配符之后的部分不算：只看前面的固定目录。
  const glob = word.search(/[*?[{]/);
  let p = glob >= 0 ? word.slice(0, glob) : word;
  if (!p) return null;
  if (HOME_VARS.test(p)) return resolve(s.home, "." + p.replace(HOME_VARS, ""));
  if (win && /^\/[a-zA-Z](\/|$)/.test(p)) p = `${p[1]}:\\${p.slice(3)}`; // Git Bash 的 /c/Users → C:\Users
  if (win && p.startsWith("/")) return p; // Git Bash 自己的 /tmp、/usr 等：不在任何允许的文件夹里
  if (isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return resolve(p);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return resolve(s.cwd, p);
  return null;
}

/** 很粗的命令切词：认引号和 ; | & < > ( ) 换行；每段命令的第一个词是程序本身，不算数据路径。 */
function shellCandidates(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let first = true;
  let has = false;
  const end = (boundary: boolean) => {
    if (has) {
      if (!first) words.push(cur);
      first = false;
    }
    cur = "";
    has = false;
    if (boundary) first = true;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && cmd[i + 1] === '"') { cur += '"'; i++; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) { end(c === "\n"); continue; }
    if (";|&()".includes(c)) { end(true); continue; }
    if (c === "<" || c === ">") {
      // 重定向的目标一定是数据路径：当成参数，不当成程序名。
      const wasFirst = first && !has;
      end(false);
      if (wasFirst) first = false;
      continue;
    }
    cur += c;
    has = true;
  }
  end(true);
  return words.map((w) => {
    // --out=/x、VAR=/x 取等号后面
    const eq = w.indexOf("=");
    return eq > 0 && (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ? w.slice(eq + 1) : w;
  });
}

export function outsidePaths(tool: string, input: Record<string, unknown>, scope: PathScope, hint?: unknown): string[] {
  const words: string[] = [];
  for (const f of FILE_FIELDS[tool] ?? []) if (typeof input[f] === "string") words.push(input[f] as string);
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") words.push(...shellCandidates(input.command));
  // Claude Code 自己认出的越界路径（Bash 请求里的 blocked_path）
  if (typeof hint === "string" && hint) words.push(hint);
  const out: string[] = [];
  for (const w of words) {
    const abs = toAbsolute(w, scope);
    if (abs === null || scope.isAllowed(abs) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}
