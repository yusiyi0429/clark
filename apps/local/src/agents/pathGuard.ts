import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { insideAny } from "../folders.js";

/**
 * 找出一次工具调用里不在允许的文件夹里的路径，给权限请求标红（ADR 0031）。
 * 文件类工具按字段取路径，准；Bash、PowerShell 只能从命令里尽力认出像路径的词，认不全也会认错，所以只标红、不自动拒绝。
 * 真正挡住大范围放行的是 suggestionsReachOutside：「这张卡都允许」要放开的范围有一处越界就不给。
 */
export interface PathScope {
  cwd: string;
  home: string;
  /** 本会话允许的范围：本人允许的文件夹，加上本会话的工作目录（工作目录所在的文件夹被移除后就不算）。 */
  allowedRoots(): string[];
}
type Inside = (path: string) => boolean;

const WIN = process.platform === "win32";
const MAX_PATHS = 20;
const FILE_FIELDS: Record<string, string[]> = {
  Read: ["file_path"], Write: ["file_path"], Edit: ["file_path"], MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"], Glob: ["path", "pattern"], Grep: ["path", "glob"],
};
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** 不是读写数据的特殊设备名。 */
const HARMLESS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "nul", "$null"]);
const HOME_VARS = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$\{env:USERPROFILE\}|\$env:HOME)(?=[\\/]|$)/i;
const CWD_VARS = /^(\$PWD|\$\{PWD\}|\$pwd)(?=[\\/]|$)/;
/** 别的环境变量开头的路径（$TMPDIR/x、$env:APPDATA\x、%APPDATA%\x）：认不出指向哪，按越界算。 */
const OTHER_VARS = /^(\$\{?[A-Za-z_][\w:]*\}?|%[A-Za-z_]\w*%)(?=[\\/])/;

/** 一个词指向的地方在不在允许范围外。相对路径按工作目录算（工作目录里的目录链接也会被解开）。 */
function isOutside(word: string, s: PathScope, inside: Inside): boolean {
  // Windows 上单个反斜杠开头的词几乎都是正则（如 \bfoo、\d+），不是路径；两个反斜杠开头的网络路径照常算。
  if (!word || word.includes("://") || HARMLESS.has(word.toLowerCase()) || (WIN && /^\\(?!\\)/.test(word))) return false;
  // 通配符之后的部分不算：只看前面的固定目录。
  const glob = word.search(/[*?[]/);
  let p = glob >= 0 ? word.slice(0, glob) : word;
  if (!p) return false;
  if (HOME_VARS.test(p)) p = s.home + p.replace(HOME_VARS, "");
  else if (CWD_VARS.test(p)) p = s.cwd + p.replace(CWD_VARS, "");
  else if (OTHER_VARS.test(p)) return true;
  if (WIN && /^\/[a-zA-Z](\/|$)/.test(p)) p = `${p[1]}:\\${p.slice(3)}`; // Git Bash 的 /c/Users → C:\Users
  else if (WIN && p.startsWith("/")) return true; // Git Bash 自己的 /tmp、/usr 等：不在任何允许的文件夹里
  return !inside(resolve(s.cwd, p));
}

/** 命令里不带分隔符的普通词（-rf、hello、test）就在工作目录里，不用查；除非它是工作目录里指向外面的链接。 */
function plainWordInCwd(w: string, s: PathScope): boolean {
  if (/[\\/~$%@:]/.test(w) || w.startsWith(".")) return false;
  try { return !lstatSync(resolve(s.cwd, w)).isSymbolicLink(); } catch { return true; }
}

/** 参数里真正的路径：@file、--out=/x、-Path:C:\x、-o/x、VAR=/x；{a,b} 拆开。 */
function argPaths(w: string): string[] {
  if (w.startsWith("@")) w = w.slice(1);
  const opt = /^-{1,2}[A-Za-z][\w-]*[=:](.+)$/.exec(w) ?? /^-[A-Za-z]([\\/~].*)$/.exec(w) ?? /^[A-Za-z_]\w*=(.+)$/.exec(w);
  if (opt) w = opt[1]!;
  // 只拆 Bash 的大括号展开 {a,b}；${VAR}、${env:X} 不拆。
  return /(^|[^$])\{[^{}]*,[^{}]*\}/.test(w) ? w.split(/[{},]/).filter(Boolean) : [w];
}

/**
 * 很粗的命令切词：认引号、转义（Bash 用 \，PowerShell 用 `）、; | & < > ( ) 换行；每段命令的第一个词是程序本身，不算数据路径。
 * 重定向的目标一定是数据路径。
 */
function shellCandidates(cmd: string, bash: boolean): string[] {
  const esc = bash ? "\\" : "`";
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
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (c === esc && i + 1 < cmd.length && (quote === null || (bash ? '"\\$`'.includes(cmd[i + 1]!) : true))) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      if (bash && c === "'" && cur.endsWith("$")) cur = cur.slice(0, -1); // $'…'
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) { end(c === "\n"); continue; }
    if (";|&()".includes(c)) { end(true); continue; }
    if (c === "<" || c === ">") {
      const wasFirst = first && !has;
      end(false);
      if (wasFirst) first = false;
      continue;
    }
    cur += c;
    has = true;
  }
  end(true);
  return words.flatMap(argPaths);
}

/** 这一步要碰的、允许范围外的路径（原样，给人看）。 */
export function outsidePaths(tool: string, input: Record<string, unknown>, scope: PathScope, hint?: unknown): string[] {
  return collect(tool, input, scope, insideAny(scope.allowedRoots()), hint);
}

function collect(tool: string, input: Record<string, unknown>, scope: PathScope, inside: Inside, hint?: unknown): string[] {
  const words: string[] = [];
  for (const f of FILE_FIELDS[tool] ?? []) if (typeof input[f] === "string") words.push(input[f] as string);
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") words.push(...shellCandidates(input.command, tool === "Bash").filter((w) => !plainWordInCwd(w, scope)));
  // Claude Code 自己认出的越界路径（Bash 请求里的 blocked_path）
  if (typeof hint === "string" && hint) words.push(hint);
  const out: string[] = [];
  for (const w of words) {
    if (out.includes(w) || !isOutside(w, scope, inside)) continue;
    out.push(w);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/** Claude Code 放行规则里的路径：//c/x 是绝对路径（Windows 是 C:\x），~/ 是主目录，/x 是项目根下，其余相对工作目录。 */
function rulePath(rule: string, s: PathScope): string {
  if (rule.startsWith("//")) { const p = rule.slice(1); return WIN && /^\/[a-zA-Z](\/|$)/.test(p) ? `${p[1]}:\\${p.slice(3)}` : p; }
  if (rule.startsWith("~/")) return s.home + rule.slice(1);
  if (rule.startsWith("/")) return s.cwd + rule;
  return rule;
}

/**
 * 「这张卡都允许」要放开的范围有没有越界：加进工作目录的目录、文件类规则里的路径、命令规则里认出的路径。
 * 不靠切词准不准：请求本身没越界，建议却放开了上级目录，也算越界。
 */
export function suggestionsReachOutside(suggestions: unknown, scope: PathScope): boolean {
  if (!Array.isArray(suggestions)) return false;
  const inside = insideAny(scope.allowedRoots());
  for (const sug of suggestions as Record<string, unknown>[]) {
    if (sug?.type === "addDirectories" && Array.isArray(sug.directories)) {
      if (sug.directories.some((d) => typeof d !== "string" || isOutside(d, scope, inside))) return true;
    }
    if ((sug?.type === "addRules" || sug?.type === "replaceRules") && Array.isArray(sug.rules)) {
      for (const r of sug.rules as Record<string, unknown>[]) {
        const content = typeof r?.ruleContent === "string" ? r.ruleContent : "";
        if (!content) continue;
        const tool = String(r.toolName ?? "");
        if (SHELL_TOOLS.has(tool) ? collect(tool, { command: content }, scope, inside).length : isOutside(rulePath(content, scope), scope, inside)) return true;
      }
    }
  }
  return false;
}
