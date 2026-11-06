/**
 * 登记拆卡（V2 设计第 21.2、21.3 节）：本人要拆一个 Task，真正去拆的是本人电脑上的规划员。
 * 伙伴在对话里登记；本机没连上（手机上、本机没开）时 Task 页的「拆一下」也登记。登记了还没开的是「拆卡 · 等开工」。
 * E 的接口合进来之前先记在这个页面里（刷新就没了）；合进来后这三个函数换成云端的读写。
 */
export type SplitRequest = { id: string; taskId: string; createdAt: string };

/** 伙伴这一轮调了「登记拆卡」（useConversation 发出，名字两边一致）。 */
export const SPLIT_EVENT = "card-split-registered";

let pending: SplitRequest[] = [];

export async function readSplits(): Promise<SplitRequest[]> {
  return [...pending];
}

export async function registerSplit(taskId: string): Promise<void> {
  if (!pending.some((request) => request.taskId === taskId)) pending.push({ id: crypto.randomUUID(), taskId, createdAt: new Date().toISOString() });
}

/** 规划员开起来了：这条登记不再等开工。 */
export async function takeSplit(id: string): Promise<void> {
  pending = pending.filter((request) => request.id !== id);
}
