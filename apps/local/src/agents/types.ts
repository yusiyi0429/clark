import type { TLocalAgentKind, TLocalModelTier } from "@warmap/contracts";
import type { EventBody } from "../eventLog.js";
import type { ResolvedModel } from "../models.js";

/** 拉起一次执行方进程需要的全部输入。 */
export interface AgentLaunch {
  sessionId: string;
  cwd: string;
  /** true：用 --resume 续上这个会话；false：用 --session-id 新开。 */
  resume: boolean;
  model: ResolvedModel;
  /** 这件的档位：订阅模型按它选模型（配置里没写模型名时）和思考强度。 */
  tier: TLocalModelTier;
  includePersonalConfig: boolean;
  /** 本会话要带的 MCP 配置文件路径（本机程序写好的 JSON），以及要预先放行的工具名。 */
  mcpConfigPath: string | null;
  /** MCP 配置文件里 ${变量名} 引用的值（本会话密钥、云端令牌），只经子进程环境变量传。 */
  mcpEnv: Record<string, string>;
  allowedTools: string[];
  /** 不给的工具（岗位的工具名单里没有的）。 */
  disallowedTools: string[];
  /** 追加的系统提示词文件（工作规矩 + 岗位），在本机程序的数据目录里。 */
  systemPromptPath: string | null;
  /** 挑刺子 agent 的定义文件（--agents），只有带了 critics 的专题有。 */
  agentsPath: string | null;
  /** 只在本会话生效的插件目录（--plugin-dir），如飞书技能。 */
  pluginDirs: string[];
  /** 本会话允许的范围（本人允许的文件夹，加上还算数的工作目录），每次权限请求现查，据此标出越界路径。 */
  allowedRoots(): string[];
  /** 卡在自己的工作树里做时是工作树的根：这里面安全的步骤不问本人就放行（pathGuard 的 autoAllowed）。别的会话为 null。 */
  autoAllowRoot: string | null;
}

export interface PermissionAnswer {
  allow: boolean;
  message?: string;
  allowForSession?: boolean;
}

/** 一个正在跑的执行方进程。事件都已归一化成契约里的 LocalSessionEvent（未编号）。 */
export interface AgentRun {
  readonly pid: number | undefined;
  /** 往进行中的会话追加一条用户消息：进行中时在下一个工具步骤生效，空闲时开新一轮。 */
  send(text: string): void;
  /** 停下当前一轮，会话保留。 */
  interrupt(): Promise<void>;
  respondPermission(requestId: string, answer: PermissionAnswer): boolean;
  /** 回答一次提问（AskUserQuestion）：answers 是「问题原文 → 回答」，执行方当成本人的回答。已答过或已撤回返回 false。 */
  respondQuestion(requestId: string, answers: Record<string, string>): boolean;
  /** 执行方还在等这个权限请求或提问的答复（后台子 agent 的请求可能跨过主轮的结束）。 */
  isWaiting(requestId: string): boolean;
  /** 停一个后台任务（子 agent、后台命令），会话本身不停。执行方答应了返回 true；之后会来一条 background 事件（stopped）。 */
  stopTask(taskId: string): Promise<boolean>;
  /** 强停：只杀本进程树。 */
  kill(): Promise<void>;
  /** 说完了：关掉输入，让执行方自己退出（验收员交完结论用）；一会儿还不退就强停。 */
  close(): void;
  onEvent(fn: (e: EventBody) => void): void;
  onExit(fn: (code: number | null) => void): void;
  /** Claude Code 报的额度变化（rate_limit_event 的 rate_limit_info，原样）：只给本机记额度用，不进事件流。 */
  onRateLimit(fn: (info: Record<string, unknown>) => void): void;
  /** 上一轮每个模型用了多少、发了几次请求（result 里的）：给本机按价目表算网关的钱。还没有为 null。 */
  readonly lastTurn: TurnModels | null;
}

/** 一轮里一个模型用了多少（Claude Code 的 model_usage_since_last_result）。costBasis：list 是官方模型按标价算的，unknown 是网关模型。 */
export interface TurnModelUsage { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costBasis: string | null }
export interface TurnModels { models: TurnModelUsage[]; requests: number | null }

/**
 * 执行方适配器。Claude Code 已实现；Codex 12 月按同一接口接（见 codex.ts 里的协议对照）。
 * start 在进程起来、握手（initialize）通过后才返回；握手不过（没装、版本太旧）抛 AgentStartError。
 */
export interface AgentAdapter {
  readonly kind: TLocalAgentKind;
  start(launch: AgentLaunch): Promise<AgentRun>;
}

export class AgentStartError extends Error {
  constructor(readonly code: "agent_not_installed" | "agent_incompatible" | "not_implemented" | "agent_not_logged_in" | "validation", message: string) {
    super(message);
  }
}
