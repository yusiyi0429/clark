import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLaunch } from "./types.js";

/** 本人主目录（Windows 上按磁盘实际大小写，和 Claude Code 自己算出的路径一致）。 */
export function homeDir(): string {
  try { return realpathSync.native(homedir()); } catch { return homedir(); }
}

/**
 * 干净会话不读本人的全局记忆：工作目录在主目录下时，Claude Code 往上逐级找 CLAUDE.md 和 .claude/rules，
 * 会把 ~/.claude/rules/*.md、~/.claude/CLAUDE.md 当成「项目规则」读进来，--setting-sources 管不住，换 CLAUDE_CONFIG_DIR 也不行（11/06 实测）。
 * 用 claudeMdExcludes 排除主目录这一层；仓库自己的 CLAUDE.md 照常读。Claude Code 按正斜杠的绝对路径匹配。
 */
export function personalMemoryExcludes(...homes: string[]): string[] {
  // 主目录按磁盘实际大小写和按环境变量的写法各给一份：Claude Code 用哪种拼法算路径不确定，它按大小写敏感匹配。
  return [...new Set(homes.map((home) => home.replace(/\\/g, "/").replace(/\/$/, "")))]
    .flatMap((h) => [`${h}/.claude/**`, `${h}/CLAUDE.md`, `${h}/CLAUDE.local.md`]);
}

/**
 * 子进程环境变量走白名单：系统路径、用户目录、语言区域、代理和证书。
 * 不继承桌面应用注入的 ANTHROPIC_*、CLAUDE_*（否则会被冒充成别的登录、按 API 计费，或连到别人的网关）。
 */
const KEEP = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
  "PSMODULEPATH", "PUBLIC", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "__CF_USER_TEXT_ENCODING", "SSH_AUTH_SOCK",
]);
const KEEP_PREFIX = ["LC_", "XDG_"];

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (KEEP.has(up) || KEEP_PREFIX.some((p) => up.startsWith(p))) env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * 网关模型出错时快点失败（11/06 用假网关实测 Claude Code 2.1.318）：
 * - 默认重试 10 次、退避到 32 秒，网关回 500 或拒连要约 3 分钟才报错；重试 2 次后约 3 秒报错。
 * - 网关连上不回：API_TIMEOUT_MS 只管等响应头（45 秒的长回答照常流完），40 秒一次、共 3 次约 2 分钟失败；
 *   第一次重试时网页就收到 api_retry 提示（约 40 秒）。CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS 对网关不起作用。
 * - 回了头之后卡住：Claude Code 固定等 5 分钟，CLAUDE_STREAM_IDLE_TIMEOUT_MS 改不小，只能本人在网页上停下。
 * 订阅（直连 Anthropic）保留默认，扛得住官方偶发的 529 过载；重试过程同样即时提示到网页。
 */
const GATEWAY_FAIL_FAST = { CLAUDE_CODE_MAX_RETRIES: "2", API_TIMEOUT_MS: "40000" };

/**
 * 权限参数：一律「每次都问」起、请求都交给本机（本机按会话的权限模式放行或转给网页，见 pathGuard 的 modeAllows）；
 * 只有「先出计划」用 Claude Code 自己的 plan 模式。它的 auto、bypassPermissions 放行的步骤不经本机，天枢的硬规矩管不住，不用。
 */
export const permissionArgs = (plan: boolean) => [
  "--permission-mode", plan ? "plan" : "manual",
  "--permission-prompts", "host",
  // --help 里没有，但必须带：不带时写文件会被直接拒绝，宿主收不到请求（11/05 实测）。
  "--permission-prompt-tool", "stdio",
];

/**
 * 拉起参数。默认会话干净：只读项目和本地设置、只带本会话的 MCP；打开 includePersonalConfig 才带本人全局配置。
 * 网关模型：地址和模型名放 --settings 的 env（盖过本人全局配置，11/05 实测）；钥匙只放进程环境变量，不进命令行
 * （macOS 上同机其他用户用 ps 看得到 argv）。带个人配置时，本人全局 settings 里若也设了钥匙会盖过进程环境，
 * 那种组合由 personalSettingsSetKey 拦下，不开工。
 */
export function buildClaudeArgs(launch: AgentLaunch): { args: string[]; env: Record<string, string> } {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...permissionArgs(launch.permissionMode === "plan")];
  args.push(launch.resume ? "--resume" : "--session-id", launch.sessionId);
  if (!launch.includePersonalConfig) args.push("--setting-sources", "project,local", "--strict-mcp-config");
  if (launch.mcpConfigPath) args.push("--mcp-config", launch.mcpConfigPath);
  if (launch.allowedTools.length) args.push("--allowedTools", launch.allowedTools.join(","));
  // 模型不支持服务端搜索时，自带的 WebSearch 不报错还会编结果（11/06 实测 qwen3.8-flash），干脆不给这个工具。
  const disallowed = [...new Set([...launch.disallowedTools, ...(launch.model.webSearch ? [] : ["WebSearch"])])];
  if (disallowed.length) args.push("--disallowedTools", disallowed.join(","));
  // 岗位和工作规矩、挑刺子 agent、飞书技能：都是本机程序数据目录里的文件，只在本会话生效（ADR 0037）。
  if (launch.systemPromptPath) args.push("--append-system-prompt-file", launch.systemPromptPath);
  if (launch.agentsPath) args.push("--agents", launch.agentsPath);
  for (const dir of launch.pluginDirs) args.push("--plugin-dir", dir);

  // MCP 配置文件里用 ${变量名} 引用的密钥和令牌，经子进程环境变量交给 Claude Code。
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1", ...launch.mcpEnv };
  // WebFetch 抓取前默认连 api.anthropic.com 做域名检查，国内网络连不上就整个失败（11/06 实测）。每个会话都关掉。
  const settings: { skipWebFetchPreflight: true; claudeMdExcludes?: string[]; env?: Record<string, string>; ultracode?: true } = { skipWebFetchPreflight: true };
  if (!launch.includePersonalConfig) settings.claudeMdExcludes = personalMemoryExcludes(homeDir(), homedir());
  const m = launch.model;
  if (m.source === "gateway") {
    if (!m.baseUrl || !m.model) throw new Error("网关模型缺地址或模型名");
    settings.env = {
      ANTHROPIC_BASE_URL: m.baseUrl,
      ANTHROPIC_MODEL: m.model,
      // WebFetch 摘要和后台小任务用的模型（ANTHROPIC_SMALL_FAST_MODEL 已废弃）；没配小模型就用主模型。
      ANTHROPIC_DEFAULT_HAIKU_MODEL: m.smallModel ?? m.model,
    };
    if (m.apiKey) env.ANTHROPIC_AUTH_TOKEN = m.apiKey;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    Object.assign(env, GATEWAY_FAIL_FAST);
  } else {
    // 订阅：配置里没写模型名（本人的 Claude 订阅）就按定好的跑法选（档位、预算模式），不然每一档都跑账号默认的 Opus；思考强度也传（新首页设计 11.3）
    args.push("--model", m.model ?? launch.run.model, "--effort", launch.run.effort);
    // 「无上限」开多 agent：会话级的 ultracode 设置（11/07 实测订阅的 Opus 可用，跑着时用 apply_flag_settings 关、开）
    if (launch.run.multiAgent) settings.ultracode = true;
  }
  args.push("--settings", JSON.stringify(settings));
  return { args, env };
}

/** 给人看的一行工具标题。 */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const short = (p: string) => p.split(/[\\/]/).slice(-3).join("/");
  switch (name) {
    case "Write": return `写文件 ${short(s("file_path"))}`;
    case "Edit": case "MultiEdit": return `改文件 ${short(s("file_path"))}`;
    case "Read": return `读文件 ${short(s("file_path"))}`;
    case "Bash": case "PowerShell": return `运行 ${s("command").slice(0, 120)}`;
    case "Glob": return `找文件 ${s("pattern")}`;
    case "Grep": return `搜索 ${s("pattern")}`;
    case "WebSearch": return `联网搜索 ${s("query")}`;
    case "WebFetch": return `读网页 ${s("url")}`;
    case "TodoWrite": return "更新计划";
    case "Task": case "Agent": return `派子任务 ${s("description")}`;
    default: return name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : name;
  }
}

/** 「a.b.c」版本比较。 */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map((x) => parseInt(x, 10) || 0);
  const b = min.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** 本人全局 Claude Code 设置里有没有自己设模型钥匙（CC Switch 之类的工具会写进去）。有的话，它会盖过本会话用环境变量传的网关钥匙。 */
export function personalSettingsSetKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { env?: Record<string, unknown> };
    return Boolean(s.env && ("ANTHROPIC_AUTH_TOKEN" in s.env || "ANTHROPIC_API_KEY" in s.env));
  } catch {
    return false;
  }
}
