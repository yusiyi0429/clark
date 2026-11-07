/**
 * 项目转交（新首页设计 16.7）的数据：B 的契约 projectTransfers.ts（接口 /api/me/projects/:projectId/transfers、/api/me/project-transfers/:id…）。
 * - 转出：选人 →「准备交接」（有在跑的会话先问等做完还是停掉；绑了文件夹的等本机检查，也能不检查直接转）→ 交接说明卡（云端写的，逐段能改）→「交给 {名字}」→ 等接手，可以撤回。
 * - 接手：等你里一条，点开只读预览（交接说明在最上面），「接手」「不接」。接手以后对话从分隔线「{日期} {原负责人} → {接手人}」开始（默认不带对话记录）。
 * 交接说明只写要哪些钥匙、找谁要，不写值；发出时云端按常见密钥样式查一遍，命中回 422，网页标出那几行。
 */
import type { THandoverSection, TPersonRef, TProjectTransfer } from "@warmap/contracts";

export type Person = TPersonRef;
export type HandoverSection = THandoverSection;
export type Transfer = TProjectTransfer;

/** 转交在项目行第二行写什么（优先于 16.2 的那几档）：发出了「等 {名字} 接手」，接走了「已交给 {名字}」。 */
export function transferLine(transfer: Pick<Transfer, "status" | "to"> | null): string | null {
  if (transfer?.status === "sent") return `等 ${transfer.to.name} 接手`;
  if (transfer?.status === "accepted") return `已交给 ${transfer.to.name}`;
  return null;
}

/** 对话里换人的分隔线（项目动态 handover）：「11/7 孙铭泽 → 陈晨星」。 */
export const handoverRule = (item: { at: string; from: Person; to: Person }) => {
  const at = new Date(item.at);
  return `${at.getMonth() + 1}/${at.getDate()} ${item.from.name} → ${item.to.name}`;
};
