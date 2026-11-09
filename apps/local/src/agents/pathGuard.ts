import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { insideAny } from "../folders.js";
import { TOOL_SERVER_PREFIX } from "../customTools.js";

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
  /** 本人在连接页加的工具（mcp__tool-…）里哪些是读的（预设的读工具名单）；不给就是都不算读。 */
  toolReads?(tool: string): boolean;
}
/** 本人加的工具：读的照权限模式放行，写的、认不出的哪一档都问。 */
const isCustomTool = (tool: string) => tool.startsWith(`mcp__${TOOL_SERVER_PREFIX}`);
type Inside = (path: string) => boolean;

const WIN = process.platform === "win32";
const MAX_PATHS = 20;
const FILE_FIELDS: Record<string, string[]> = {
  Read: ["file_path"], Write: ["file_path"], Edit: ["file_path"], MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"], Glob: ["path", "pattern"], Grep: ["path", "glob"], LS: ["path"],
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

/** PowerShell 里后面跟的是匹配模式、不是路径的：比较运算符（-notmatch '\\.git\\'）和 -Pattern 参数。 */
const PATTERN_OPERATOR = /^-[ci]?(not)?(match|like)$|^-[ci]?(replace|split)$|^-Pattern$/i;

/**
 * 很粗的命令切词：认引号、转义（Bash 用 \，PowerShell 用 `）、; | & < > ( ) 换行；每段命令的第一个词是程序本身，不算数据路径。
 * 重定向的目标一定是数据路径。
 */
function shellCandidates(cmd: string, bash: boolean, patterns?: Set<string>): string[] {
  const esc = bash ? "\\" : "`";
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let first = true;
  let has = false;
  let prev = "";
  const end = (boundary: boolean) => {
    if (has) {
      if (!first && !bash && PATTERN_OPERATOR.test(prev)) patterns?.add(cur);
      else if (!first) words.push(cur);
      first = false;
      prev = cur;
    }
    cur = "";
    has = false;
    if (boundary) { first = true; prev = ""; }
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
  const patterns = new Set<string>();
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") words.push(...shellCandidates(input.command, tool === "Bash", patterns).filter((w) => !plainWordInCwd(w, scope)));
  // Claude Code 自己认出的越界路径（Bash 请求里的 blocked_path）；它把 -notmatch 后面的正则当成路径时不算
  if (typeof hint === "string" && hint && !patterns.has(hint)) words.push(hint);
  const out: string[] = [];
  for (const w of words) {
    if (out.includes(w) || !isOutside(w, scope, inside)) continue;
    out.push(w);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/** 卡在自己的工作树里做时不用问就放行的读写工具（路径都在工作树里才放行）。 */
const WORKTREE_FILE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** 装东西、联网、推拉代码、改系统设置的命令：照样问本人。按词认，认不全（脚本里自己联网就认不出）。 */
const RISKY_COMMAND = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun|pip3?|pipx|uv|poetry|cargo|go|gem|composer|brew|choco|winget|scoop|apt|apt-get|dnf|yum)\s+(i|install|add|ci|get|update|upgrade|dlx)\b`,
  String.raw`\b(curl|wget|ssh|scp|sftp|rsync|ftp|telnet|nc|gh|docker|sudo|runas|reg|setx|schtasks)\b`,
  String.raw`\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Install-Module|Install-Package|Set-ItemProperty|New-ItemProperty)\b`,
  String.raw`\bgit\b[^;&|\n]*\b(push|fetch|pull|clone|ls-remote|remote|submodule)\b`,
].join("|"), "i");
/**
 * npx、npm exec、bunx 跑的程序不在 node_modules/.bin 里时会自己去下载（非交互时不问）：只有工作树里已经装好的才放行
 * （npx vitest run 行，npx create-x、带版本的 x@1、带范围的 @s/x、-p 指定包的照样问）。
 */
const RUN_BIN = /\b(?:npx|pnpx|bunx|npm\s+(?:exec|x)|bun\s+x)((?:\s+--?[\w-]+(?:=\S*)?)*)\s+([^\s;&|<>]+)/gi;
function binsInstalled(cmd: string, dirs: string[]): boolean {
  for (const m of cmd.matchAll(RUN_BIN)) {
    const name = m[2]!;
    if (/(^|\s)(-p|--package)\b/.test(m[1] ?? "") || !/^[\w.-]+$/.test(name)) return false;
    if (!dirs.some((d) => [name, `${name}.cmd`, `${name}.ps1`].some((f) => existsSync(join(d, "node_modules", ".bin", f))))) return false;
  }
  return true;
}

/**
 * 飞书命令行（lark-cli）只放行读的（11/07 照 1.0.93 的命令名）：快捷命令（+xxx）名字最后一段是读的动词、或以 get-、search- 开头，
 * 而且名字里没有写的词；按资源调方法的 list、get、search、query、mget；auth status、list、check、scopes；schema、help、version；
 * 带 --help、--dry-run 的。别的照样问本人：发消息、发邮件、改文档、建日程、改表格等写操作，登录登出，直接调接口（api），看不出是读的（宁可多问）。
 */
const LARK_READ_TAIL = new Set(["list", "search", "get", "mget", "query", "fetch", "read", "status", "agenda", "detail", "info", "preview", "inspect", "freebusy", "find", "download"]);
const LARK_WRITE_PART = new Set(["send", "create", "update", "edit", "delete", "remove", "add", "set", "put", "revert", "move", "copy", "upload", "reply", "forward", "trash", "modify", "share", "submit", "push", "sync", "import", "rename", "clear", "insert", "enable", "disable", "bind", "unbind", "complete", "reopen", "assign", "transfer", "invite", "join", "leave", "end", "rsvp"]);
function larkRead(words: string[]): boolean {
  // 看帮助、只演练：只认放在最后、前面不是参数名的（--text --dry-run 时 --dry-run 是要发的字）
  if (/^(--help|-h|--dry-run|--version)$/.test(words.at(-1) ?? "") && !(words.at(-2) ?? "").startsWith("-")) return true;
  const head: string[] = [];
  for (const w of words) { if (w.startsWith("-")) break; head.push(w); }
  const [a, b] = head.map((w) => w.toLowerCase());
  if (!a) return false;
  if (a === "help" || a === "version" || a === "schema") return true;
  if (a === "auth") return ["status", "list", "check", "scopes"].includes(b ?? "");
  const shortcut = head.find((w) => w.startsWith("+"));
  if (shortcut) {
    const parts = shortcut.slice(1).toLowerCase().split("-");
    if (parts.some((p) => LARK_WRITE_PART.has(p))) return false;
    return LARK_READ_TAIL.has(parts.at(-1)!) || parts[0] === "get" || parts[0] === "search";
  }
  return head.length === 3 && ["list", "get", "search", "query", "mget"].includes(head[2]!.toLowerCase());
}
/**
 * 命令里有一次 lark-cli 不是读的。套在 $( )、反引号、<( ) 里的认不清，一律当成不是读的；反引号也挡住 PowerShell 里 lark`-cli 这种拆开的写法。
 */
function larkWrites(cmd: string): boolean {
  if (/lark/i.test(cmd) && /\$\(|`|<\(/.test(cmd)) return true;
  for (const m of cmd.matchAll(/\blark-cli\b([^;&|\n]*)/gi)) {
    if (!larkRead(m[1]!.trim().split(/\s+/).filter(Boolean))) return true;
  }
  return false;
}

/** 工作树里的 .git（指回主仓库）和 .claude（Claude Code 的项目设置，写了会放开以后的会话）：照样问。 */
const PROTECTED = /(^|[\\/\s"'])\.(git|claude)([\\/\s"']|$)/;
/** 只是用来排除、筛选的 .git、.claude（-Exclude .git、-notmatch '\\.git\\'、--exclude-dir=.git、-g '!.git'）。 */
const FILTER_ARG = /(^|\s)(-Exclude|-[ci]?(?:not)?(?:match|like)|--exclude(?:-dir)?|--glob|-g)(?:\s+|=)("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
/** 写、删、挪文件的命令和重定向（2>&1 这种合并输出的不算）。 */
const WRITES = /(^|[\s;|&(])(Remove-Item|ri|rm|rmdir|rd|del|erase|Move-Item|mi|mv|move|Copy-Item|cpi|cp|copy|Rename-Item|rni|ren|Set-Content|sc|Add-Content|ac|Out-File|New-Item|ni|tee|Tee-Object)(?=\s|$)|(?<![\d*&])>(?!&)/i;
/** 命令碰不碰 .git、.claude：只用来排除、筛选的不算（命令里还有写、删、挪、重定向时照样算，免得先筛出来再删）。 */
function touchesProtected(cmd: string): boolean {
  return PROTECTED.test(WRITES.test(cmd) ? cmd : cmd.replace(FILTER_ARG, "$1"));
}

/**
 * 卡在自己的工作树里做时，这一步能不能不问本人就放行（ADR 0038）。规则只在这里：
 * - 读写文件：路径都在工作树里；
 * - Bash、PowerShell：认出的路径都在工作树里，而且不装东西、不联网、不推拉代码、不改系统设置、飞书命令行只读（跑仓库自己的脚本 npm test、npm run x、
 *   pnpm test、node --test 行；npx 之类只跑工作树里装好的）；
 * - 天枢 MCP 里读的工具（get_、list_ 开头），本人加的工具里预设名单认作读的。
 * 碰 .git、.claude 的照样问（只用来排除、筛选的不算）；别的工具（联网搜索、子 agent 等）照样问。scope 的允许范围只放工作树。
 */
export function autoAllowed(tool: string, input: Record<string, unknown>, scope: PathScope, hint?: unknown): boolean {
  if (tool.startsWith("mcp__tianshu__")) return /^mcp__tianshu__(get|list)_/.test(tool);
  if (isCustomTool(tool)) return Boolean(scope.toolReads?.(tool));
  const inside = insideAny(scope.allowedRoots());
  if (SHELL_TOOLS.has(tool)) {
    const cmd = input.command;
    return typeof cmd === "string" && !RISKY_COMMAND.test(cmd) && !larkWrites(cmd) && binsInstalled(cmd, [scope.cwd, ...scope.allowedRoots()])
      && !touchesProtected(cmd) && !collect(tool, input, scope, inside, hint).length;
  }
  if (!WORKTREE_FILE_TOOLS.has(tool)) return false;
  const paths = (FILE_FIELDS[tool] ?? []).map((f) => input[f]).filter((v): v is string => typeof v === "string");
  return !paths.some((p) => PROTECTED.test(p)) && !collect(tool, input, scope, inside, hint).length;
}

/** 改文件的工具：「自动接受改文件」自己放行的。 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * 天枢的硬规矩（设计 9.5，契约 LocalPermissionMode）：哪一档都照问本人。scope 的允许范围是本人允许的全部文件夹。
 * 推拉代码、gh、装东西、联网下载、改系统设置（RISKY_COMMAND），飞书命令行写的，跑没装好的 npx 包，碰 .git、.claude 的，碰允许的文件夹以外的，天枢 MCP 写的工具，
 * 本人加的工具里不是读的。
 */
function mustAsk(tool: string, input: Record<string, unknown>, scope: PathScope, hint?: unknown): boolean {
  if (tool.startsWith("mcp__tianshu__")) return !/^mcp__tianshu__(get|list)_/.test(tool);
  if (isCustomTool(tool)) return !scope.toolReads?.(tool);
  if (SHELL_TOOLS.has(tool)) {
    const cmd = input.command;
    if (typeof cmd !== "string") return true;
    if (RISKY_COMMAND.test(cmd) || larkWrites(cmd) || !binsInstalled(cmd, [scope.cwd, ...scope.allowedRoots()]) || touchesProtected(cmd)) return true;
  } else if ((FILE_FIELDS[tool] ?? []).some((f) => typeof input[f] === "string" && PROTECTED.test(input[f] as string))) {
    return true;
  }
  return collect(tool, input, scope, insideAny(scope.allowedRoots()), hint).length > 0;
}

/** gh 只读的：看、列、查状态、搜（gh api 只发 GET、不带字段）。别的（pr create、pr merge、release create、issue comment、api 发 POST…）都算写。 */
const GH_READ_VERB = new Set(["view", "list", "ls", "status", "diff", "checks", "search", "watch", "download", "browse"]);
function ghWrites(cmd: string): boolean {
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])gh\s+([^;&|\n]*)/g)) {
    const words = m[1]!.trim().split(/\s+/).filter(Boolean);
    const head = words.filter((w) => !w.startsWith("-"));
    const [a, b] = head.map((w) => w.toLowerCase());
    if (!a || a === "help" || a === "version" || a === "status" || a === "search" || a === "browse") continue;
    if (a === "auth" && (b === "status" || b === "token")) continue;
    if (a === "api") {
      const method = /(?:^|\s)(?:-X|--method)[=\s]+(\w+)/i.exec(m[1]!)?.[1]?.toUpperCase();
      if ((!method || method === "GET") && !/(?:^|\s)(-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/.test(m[1]!)) continue;
      return true;
    }
    if (b && GH_READ_VERB.has(b)) continue;
    return true;
  }
  return false;
}

/** 飞书命令行里给别人发消息的：快捷命令名里有发、回复、转发、加急；按资源调 im、mail 的写方法；直接调消息、邮件的接口。认不清（套在 $( ) 里）的算。 */
const LARK_MESSAGE_PART = new Set(["send", "reply", "forward", "urgent"]);
function larkMessages(cmd: string): boolean {
  if (/lark/i.test(cmd) && /\$\(|`|<\(/.test(cmd)) return true;
  for (const m of cmd.matchAll(/\blark-cli\b([^;&|\n]*)/gi)) {
    const words = m[1]!.trim().split(/\s+/).filter(Boolean);
    const head: string[] = [];
    for (const w of words) { if (w.startsWith("-")) break; head.push(w.toLowerCase()); }
    const shortcut = head.find((w) => w.startsWith("+"));
    if (shortcut && shortcut.slice(1).split("-").some((p) => LARK_MESSAGE_PART.has(p))) return true;
    if ((head[0] === "im" || head[0] === "mail") && !shortcut && head.length >= 3 && !larkRead(words)) return true;
    if (head[0] === "api" && /\/(im|mail)\//i.test(m[1]!) && !/^get$/i.test(head[1] ?? "")) return true;
  }
  return false;
}

/**
 * 「全部放行」也照问的三类（设计 17.2 第 33 条）：推代码或开 PR（git push、gh 写的）、给别人发消息（飞书发消息、回复、转发、发邮件）、
 * 在天枢里替本人写入（天枢 MCP 写的工具）。别的（联网、装东西、碰 .git、允许范围以外的路径、本人加的工具写的等）都放行。
 */
function bypassAsks(tool: string, input: Record<string, unknown>): boolean {
  if (tool.startsWith("mcp__tianshu__")) return !/^mcp__tianshu__(get|list)_/.test(tool);
  if (!SHELL_TOOLS.has(tool)) return false;
  const cmd = input.command;
  if (typeof cmd !== "string") return true;
  if (/(git|gh)/i.test(cmd) && /\$\(|`|<\(/.test(cmd)) return true; // 套在 $( )、反引号里认不清
  return /\bgit\b[^;&|\n]*\bpush\b/i.test(cmd) || ghWrites(cmd) || larkMessages(cmd);
}

/**
 * 这一档下这一步能不能不问本人就放行（契约 LocalPermissionMode）。「全部放行」只问 bypassAsks 那三类；别的档还有硬规矩（mustAsk）。worktree：卡在自己的工作树里做时是工作树的根，
 * 「自动」「自动接受改文件」只在工作树里自己放行；别的会话为 null，在允许的文件夹里放行，「自动」不在工作树时删、挪文件的命令照样问（没有 git 兜底）。
 */
export function modeAllows(
  mode: "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions", tool: string, input: Record<string, unknown>, scope: PathScope, hint: unknown, worktree: string | null,
): boolean {
  if (mode === "bypassPermissions") return !bypassAsks(tool, input);
  if (mode === "default" || mode === "plan" || mustAsk(tool, input, scope, hint)) return false;
  const area: PathScope = worktree ? { ...scope, allowedRoots: () => [worktree] } : scope;
  if (mode === "acceptEdits") return EDIT_TOOLS.has(tool) && !collect(tool, input, area, insideAny(area.allowedRoots()), hint).length;
  if (!autoAllowed(tool, input, area, hint)) return false;
  return Boolean(worktree) || !(SHELL_TOOLS.has(tool) && WRITES.test(String(input.command ?? "")));
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
