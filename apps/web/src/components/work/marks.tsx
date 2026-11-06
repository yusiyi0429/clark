/**
 * 两个小记号（V2 设计第 20.2 节）：链路记号（空心圈 已排队、转动的半圈 进行中、实心勾 已完成、虚线圈 待开工），
 * 岗位头像（名字的第一个字，方的；干活 / 验收 / 挑刺三种底色，人自己是圆的）。对话里的验收结果、岗位建议用它们。
 */
import type { RoleKind } from "@/lib/team/roles";
import { CHAIN_LABEL, type ChainState } from "@/lib/work/workers";
import w from "@/styles/v2-work.module.css";

export function Chain({ state, size }: { state: ChainState | "draft"; size?: "xs" }) {
  return <span className={w.sg} data-state={state} data-size={size} role="img" aria-label={state === "draft" ? "待开工" : CHAIN_LABEL[state]} />;
}

export function RoleAvatar({ name, kind = "worker", size }: { name: string; kind?: RoleKind | "self"; size?: "s" }) {
  return <span className={w.ra} data-kind={kind} data-size={size} aria-hidden>{Array.from(name)[0] ?? "?"}</span>;
}
