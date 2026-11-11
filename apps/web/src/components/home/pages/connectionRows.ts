/**
 * 连接页每一行画什么（设计 9.5、5.4.6）：名字 + 小字 + 状态词（已连接 / 未连接 / 已过期 / 用完）+ 一个动作。纯函数，页面照着画、测试照着看。
 * 动作只给种类，页面配上字和做法：pair 配对、retry 重试、resume 继续、link 连接（关联云端、登录执行方）、unpair 断开、reauth 重新授权。
 */
import type { TLocalAgentStatus, TLocalModelProfile, TLocalStatusResponse, TLocalTool } from "@warmap/contracts";
import type { Pairing } from "@/lib/local/LocalRunnerProvider";
import type { LocalPhase } from "@/lib/local/connection";
import type { ConnState } from "./parts";

export type RowAction = "pair" | "retry" | "resume" | "link" | "unpair" | "reauth" | "login";
export type RowModel = { key: string; name: string; sub: string | null; state: ConnState | null; action: RowAction | null; command?: string };

/** 本机 status.tools 里的命令行工具（Claude Code、Codex 另有执行方那一行）。 */
type Tool = TLocalStatusResponse["tools"][number] & { kind: "gh" | "lark-cli" };
export const isCliTool = (tool: TLocalStatusResponse["tools"][number]): tool is Tool => tool.kind === "gh" || tool.kind === "lark-cli";

/** 本机程序这一行：七种状态（检查中、等浏览器允许、被拦截、离线、未配对、暂停中、就绪）落到四个状态词加小字和一个动作。离线时下面放安装命令；install 为 null（Mac，这一版没有 Mac 版）写「暂不支持 Mac」，不给命令和重试。 */
export function programRow(input: { phase: LocalPhase; status: TLocalStatusResponse | null; version: string | null; pairing: Pairing | null; error: string | null; linking: boolean; install: string | null }): RowModel {
  const { phase, status, pairing } = input;
  const base = { key: "program", name: "本机程序" };
  switch (phase) {
    case "checking": return { ...base, sub: "检查中", state: null, action: null };
    case "prompt": return { ...base, sub: "等浏览器允许", state: "disconnected", action: "retry" };
    case "blocked": return { ...base, sub: "被拦截 · 站点设置 › 本地网络访问 › 允许", state: "disconnected", action: "retry" };
    case "offline": return input.install ? { ...base, sub: "离线", state: "disconnected", action: "retry", command: input.install } : { ...base, sub: "暂不支持 Mac", state: "disconnected", action: null };
    case "unpaired": {
      if (pairing?.state === "waiting") return { ...base, sub: `确认码 ${pairing.code}`, state: "disconnected", action: null };
      const why = pairing?.state === "denied" ? "本机拒绝了" : pairing ? "过期了" : input.error ?? "未配对";
      return { ...base, sub: why, state: "disconnected", action: "pair" };
    }
    case "ready": {
      const version = status?.version ?? input.version;
      if (status?.settings.paused) return { ...base, sub: ["暂停中", version ? `v${version}` : null].filter(Boolean).join(" · "), state: "connected", action: "resume" };
      // 老的关联没记下是谁（needsRelink）也算没关联上，给「连接」重新关联一次。
      const cloud = !status || (status.cloud.linked && status.cloud.personId) ? null : input.linking ? "正在关联云端" : "云端未关联";
      return { ...base, sub: [version ? `v${version}` : null, cloud].filter(Boolean).join(" · ") || null, state: "connected", action: cloud && !input.linking ? "link" : "unpair" };
    }
  }
}

const AGENT_NAME: Record<TLocalAgentStatus["kind"], string> = { "claude-code": "Claude Code", codex: "Codex" };

/** Claude Code、Codex：没装、没登录是未连接（没登录给「连接」去登录），登录过期是已过期（重新授权），额度用完是用完。 */
export function agentRow(agent: TLocalAgentStatus, now: number, exhausted = false): RowModel {
  const name = AGENT_NAME[agent.kind];
  const key = `agent:${agent.kind}`;
  if (!agent.installed) return { key, name, sub: "没装", state: "disconnected", action: null };
  const version = agent.version ? agent.version : null;
  const old = !agent.compatible && agent.minimumVersion ? `要 ${agent.minimumVersion} 以上` : null;
  const sub = [version, agent.subscriptionType, old].filter(Boolean).join(" · ") || null;
  if (agent.setup.phase === "waiting_browser") return { key, name, sub: "等浏览器登录", state: "disconnected", action: null };
  if (!agent.loggedIn) return { key, name, sub, state: "disconnected", action: "login" };
  if (agent.loginExpiresAt && Date.parse(agent.loginExpiresAt) <= now) return { key, name, sub, state: "expired", action: "reauth" };
  return { key, name, sub, state: exhausted ? "exhausted" : "connected", action: null };
}

/** TokenHub：本机有网关的模型档就算连上，小字写模型名。钥匙只在本机，网页不加（共用账户的花费不写，13.1 第 6 条）。 */
export function tokenHubRow(models: TLocalModelProfile[]): RowModel {
  const gateway = models.filter((model) => model.source !== "subscription");
  return { key: "tokenhub", name: "TokenHub", sub: gateway.length ? gateway.map((model) => model.label).join(" · ") : null, state: gateway.length ? "connected" : "disconnected", action: null };
}

const TOOL: Record<Tool["kind"], { name: string; login: string }> = {
  gh: { name: "GitHub", login: "gh auth login" },
  "lark-cli": { name: "飞书命令行", login: "lark-cli auth login" },
};

/** gh、lark-cli：登了写登的是谁；没登录、过期时小字是登录命令（在终端里跑，网页不代登）；还没查完不写状态词。 */
export function toolRow(tool: Tool): RowModel {
  const { name, login } = TOOL[tool.kind];
  const key = `tool:${tool.kind}`;
  switch (tool.state) {
    case "ready": return { key, name, sub: [tool.kind, tool.account].filter(Boolean).join(" · "), state: "connected", action: null };
    case "not_installed": return { key, name, sub: "没装", state: "disconnected", action: null };
    case "not_logged_in": return { key, name, sub: login, state: "disconnected", action: null, command: login };
    case "expired": return { key, name, sub: login, state: "expired", action: null, command: login };
    case "unknown": return { key, name, sub: "检查中", state: null, action: null };
  }
}

/**
 * 飞书（云端授权）：连上是已连接、给「断开」；授权过期或缺权限是已过期、给「重新授权」；没连是未连接、给「连接」。
 * 这套天枢没配公司飞书应用时照样画，写「未开通」、不给动作（11/09：找不到连飞书的地方）。还没读到（null）不画。
 */
export function feishuRow(feishu: { enabled: boolean; state: "not_connected" | "connected" | "expired" } | null): RowModel | null {
  if (!feishu) return null;
  const base = { key: "feishu", name: "飞书", sub: null };
  if (!feishu.enabled) return { ...base, state: "not_enabled", action: null };
  if (feishu.state === "connected") return { ...base, state: "connected", action: "unpair" };
  if (feishu.state === "expired") return { ...base, state: "expired", action: "reauth" };
  return { ...base, state: "disconnected", action: "link" };
}

export type TokenLike = { name: string; expiresAt: string | null; lastUsedAt: string | null };

/** 让外部 AI 读天枢（个人 MCP 令牌：本人的 Codex、Claude Code 连进天枢）：用过、没过期的算连上，小字写是哪几个；只有过期的是已过期。 */
export function mcpRow(tokens: TokenLike[] | null, now: number): RowModel {
  const active = (tokens ?? []).filter((token) => !token.expiresAt || Date.parse(token.expiresAt) > now);
  const used = active.filter((token) => token.lastUsedAt);
  const state: ConnState = used.length ? "connected" : tokens?.length && !active.length ? "expired" : "disconnected";
  return { key: "mcp", name: "让外部 AI 读天枢", sub: used.length ? used.map((token) => token.name).join(" · ") : null, state, action: "link" };
}

const LOCAL_TOOL_STATE: Record<TLocalTool["state"], ConnState> = { ready: "connected", unauthorized: "unauthorized", unreachable: "unreachable", unknown: "unknown" };

/** 本人加的工具（给子会话挂的 MCP 服务器）：状态词照本机查的结果；小字是连上时有几个工具、没连上的原因，还没查时是地址。 */
export function localToolRow(tool: TLocalTool): RowModel {
  const sub = tool.state === "ready" ? (tool.toolCount === null ? null : `${tool.toolCount} 个工具`) : tool.error ?? tool.url;
  return { key: `local-tool:${tool.id}`, name: tool.name, sub, state: LOCAL_TOOL_STATE[tool.state], action: null };
}

/** 金蝶：哪款产品、地址和钥匙还没定，没加过时先占一行「未连接」，不给动作。 */
export const KINGDEE_PLACEHOLDER: RowModel = { key: "local-tool:kingdee", name: "金蝶", sub: null, state: "disconnected", action: null };
