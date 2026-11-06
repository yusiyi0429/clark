import { AgentStartError, type AgentAdapter, type AgentLaunch, type AgentRun } from "./types.js";

/**
 * Codex 适配器：12 月实现，这次只留接口。协议调研见 RFC 附录 E（codex app-server 的 JSON-RPC）。
 * 实现时按 AgentRun 的五件事对应：事件流、send（插话）、interrupt、respondPermission、kill。
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  async start(_launch: AgentLaunch): Promise<AgentRun> {
    throw new AgentStartError("not_implemented", "Codex 12 月接入，现在只能用 Claude Code");
  }
}
