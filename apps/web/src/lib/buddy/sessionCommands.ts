"use client";

/**
 * 「请这台电脑对子会话做一件事」（18.10：项目主管线按字母给子会话转话、重开、回答问题、批准；云端不指挥本机）：
 * 连着本机程序的网页每隔一阵认领这台电脑上的（POST /api/me/session-commands/claim），照 command 调本机程序，再报结果。规矩同停掉（sessionStops.ts）。
 * 本机上没有这个会话报 not_running；要回答、要批准的那一次已经处理过（本机回 409）报 expired；本机拒了报 failed 带原因；
 * 本机连不上不报（null），5 分钟后云端让下一次重新认领。
 */
import { useEffect, useRef } from "react";
import type { TSessionCommandDoneRequest, TSessionCommandView } from "@warmap/contracts";
import type { LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { LocalRunnerError, type LocalRunner, type TLocalSessionSummary } from "@/lib/local/runner";
import { claimSessionCommands, reportSessionCommand } from "./actions";
import { STOP_POLL_MS } from "./sessionStops";

type Outcome = Pick<TSessionCommandDoneRequest, "result" | "message">;

/** 照一条命令调本机：转话（停着的本机会续上，「重开」也是这条）、回答、批准或拒绝。 */
export async function runSessionCommand(runner: LocalRunner, sessions: TLocalSessionSummary[], entry: TSessionCommandView): Promise<Outcome | null> {
  if (!sessions.some((session) => session.id === entry.sessionId)) return { result: "not_running" };
  const { command } = entry;
  try {
    if (command.type === "message") await runner.sendMessage(entry.sessionId, command.text);
    else if (command.type === "answer") await runner.answerQuestion(entry.sessionId, command.requestId, command.answer);
    else await runner.decidePermission(entry.sessionId, command.requestId, command.decision);
    return { result: "done" };
  } catch (error) {
    if (error instanceof LocalRunnerError && error.code === "network") return null;
    if (error instanceof LocalRunnerError && error.status === 409 && command.type !== "message") return { result: "expired" };
    return { result: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}

/** 认领这台电脑上的命令、照着调本机、报结果。登记了「再改一轮」「我来补」的那台电脑上也马上调一次（不等下一轮）。 */
export async function runClaimedCommands(deviceId: string, local: Pick<LocalRunnerState, "runner" | "sessions" | "refresh">): Promise<void> {
  const commands = await claimSessionCommands(deviceId);
  for (const entry of commands) {
    const outcome = await runSessionCommand(local.runner, local.sessions, entry);
    if (outcome) await reportSessionCommand(entry.id, { deviceId, ...outcome }).catch(() => undefined);
  }
  if (commands.length) await local.refresh();
}

export function useSessionCommands(local: LocalRunnerState, enabled: boolean) {
  const deviceId = enabled ? local.status?.deviceId ?? null : null;
  const ref = useRef(local);
  ref.current = local;
  useEffect(() => {
    if (!deviceId) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try { await runClaimedCommands(deviceId, ref.current); }
      catch { /* 认领不到（接口没上、断网）下一次再来 */ } finally { busy = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), STOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [deviceId]);
}
