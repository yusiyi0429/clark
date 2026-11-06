/**
 * 对一个 worker 的处理（左栏「worker 等你」、派活单里的行、对话里的小卡、右栏详情共用）：
 * 批准、拒绝、回复只能在跑它的这台电脑上（本机会话在这里，而且不是手机）；仍然通过、推翻在云端，手机上也能做（第 20.4 节）。
 */
import type { LocalRunner } from "@/lib/local/runner";
import { overrule } from "@/lib/board/cloud";
import type { Worker } from "./workers";

/** 这台电脑能不能替它批准、回复。 */
export const canCommandHere = (worker: Worker, ready: boolean, handheld: boolean) => ready && !handheld && !!worker.session;

/** 批准或拒绝挂着的那条权限请求（第一条）。 */
export async function decide(runner: LocalRunner, worker: Worker, decision: "allow" | "deny"): Promise<void> {
  if (!worker.session) throw new Error("到电脑上处理");
  const { pendingPermissions } = await runner.getSession(worker.session.id);
  const request = pendingPermissions[0];
  if (!request) throw new Error("已经处理过了");
  await runner.decidePermission(worker.session.id, request.requestId, { decision });
}

export async function reply(runner: LocalRunner, worker: Worker, text: string): Promise<void> {
  if (!worker.session) throw new Error("到电脑上处理");
  await runner.sendMessage(worker.session.id, text);
}

/** 验收没过仍然通过，或者通过了推翻：都要写原因。 */
export async function overruleWorker(worker: Worker, reason: string): Promise<void> {
  const handback = worker.item?.card?.handback;
  if (!handback || !worker.cardId) throw new Error("还没有验收结果");
  await overrule(worker.cardId, handback.id, reason);
}
