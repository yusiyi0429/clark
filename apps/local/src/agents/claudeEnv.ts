import type { AgentLaunch } from "./types.js";

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

export const PERMISSION_ARGS = [
  "--permission-mode", "manual",
  "--permission-prompts", "host",
  // --help 里没有，但必须带：不带时写文件会被直接拒绝，宿主收不到请求（11/05 实测）。
  "--permission-prompt-tool", "stdio",
];

/**
 * 拉起参数。默认会话干净：只读项目和本地设置、只带本会话的 MCP；打开 includePersonalConfig 才带本人全局配置。
 * 网关模型：地址和模型名放 --settings 的 env（盖过本人全局配置，11/05 实测）；钥匙放进程环境变量，不进命令行
 * （macOS 上同机其他用户用 ps 看得到 argv）。带个人配置时，本人全局 settings 里的 ANTHROPIC_AUTH_TOKEN 会盖过进程环境，
 * 只有这种情况把钥匙也放进 --settings。
 */
export function buildClaudeArgs(launch: AgentLaunch): { args: string[]; env: Record<string, string> } {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...PERMISSION_ARGS];
  args.push(launch.resume ? "--resume" : "--session-id", launch.sessionId);
  if (!launch.includePersonalConfig) args.push("--setting-sources", "project,local", "--strict-mcp-config");
  if (launch.mcpConfigPath) args.push("--mcp-config", launch.mcpConfigPath);
  if (launch.allowedTools.length) args.push("--allowedTools", launch.allowedTools.join(","));
  // 模型不支持服务端搜索时，自带的 WebSearch 不报错还会编结果（11/06 实测 qwen3.8-flash），干脆不给这个工具。
  if (!launch.model.webSearch) args.push("--disallowedTools", "WebSearch");

  // MCP 配置文件里用 ${变量名} 引用的密钥和令牌，经子进程环境变量交给 Claude Code。
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1", ...launch.mcpEnv };
  // WebFetch 抓取前默认连 api.anthropic.com 做域名检查，国内网络连不上就整个失败（11/06 实测）。每个会话都关掉。
  const settings: { skipWebFetchPreflight: true; env?: Record<string, string> } = { skipWebFetchPreflight: true };
  const m = launch.model;
  if (m.source === "gateway") {
    if (!m.baseUrl || !m.model) throw new Error("网关模型缺地址或模型名");
    settings.env = {
      ANTHROPIC_BASE_URL: m.baseUrl,
      ANTHROPIC_MODEL: m.model,
      // WebFetch 摘要和后台小任务用的模型（ANTHROPIC_SMALL_FAST_MODEL 已废弃）；没配小模型就用主模型。
      ANTHROPIC_DEFAULT_HAIKU_MODEL: m.smallModel ?? m.model,
    };
    if (m.apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = m.apiKey;
      if (launch.includePersonalConfig) settings.env.ANTHROPIC_AUTH_TOKEN = m.apiKey;
    }
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  } else if (m.model) {
    args.push("--model", m.model);
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
