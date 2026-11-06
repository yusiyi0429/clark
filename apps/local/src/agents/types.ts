import type { TLocalAgentKind } from "@warmap/contracts";
import type { EventBody } from "../eventLog.js";
import type { ResolvedModel } from "../models.js";

/** 拉起一次执行方进程需要的全部输入。 */
export interface AgentLaunch {
  sessionId: string;
  cwd: string;
  /** true：用 --resume 续上这个会话；false：用 --session-id 新开。 */
  resume: boolean;
  model: ResolvedModel;
  includePersonalConfig: boolean;
  /** 本会话要带的 MCP 配置文件路径（本机程序写好的 JSON），以及要预先放行的工具名。 */
  mcpConfigPath: string | null;
  /** MCP 配置文件里 ${变量名} 引用的值（本会话密钥、云端令牌），只经子进程环境变量传。 */
  mcpEnv: Record<string, string>;
  allowedTools: string[];
  /** 本会话允许的范围（本人允许的文件夹，加上还算数的工作目录），每次权限请求现查，据此标出越界路径。 */
  allowedRoots(): string[];
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
  /** 强停：只杀本进程树。 */
  kill(): Promise<void>;
  onEvent(fn: (e: EventBody) => void): void;
  onExit(fn: (code: number | null) => void): void;
}

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
