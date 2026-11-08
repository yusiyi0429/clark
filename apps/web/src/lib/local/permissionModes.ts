/**
 * 子会话的权限模式（设计 17.2 第 11 条，契约 LocalPermissionMode）：中文档名和一行短副标题，每种执行方能选哪几档。
 * 网页不打包契约包：这里照抄一份 LOCAL_AGENT_PERMISSION_MODES，类型标成契约里那份，契约改了类型检查就过不去。
 */
import type { TLocalPermissionMode } from "@warmap/contracts";

type Contracts = typeof import("@warmap/contracts");

export const AGENT_PERMISSION_MODES: Contracts["LOCAL_AGENT_PERMISSION_MODES"] = {
  "claude-code": ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
  codex: ["auto", "default", "acceptEdits", "bypassPermissions"],
};

export const PERMISSION_MODE_TEXT: Record<TLocalPermissionMode, { name: string; hint: string }> = {
  auto: { name: "自动", hint: "由天枢判断哪些要问你" },
  default: { name: "每次都问", hint: "改动前都问" },
  acceptEdits: { name: "自动接受改文件", hint: "改文件不问" },
  plan: { name: "先出计划", hint: "先出计划再动手" },
  bypassPermissions: { name: "全部放行", hint: "除对外动作外都放行" },
};

/** 推荐的那一档（新子会话默认）。 */
export const RECOMMENDED_MODE: TLocalPermissionMode = "auto";
