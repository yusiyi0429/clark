/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/snapshot.py
 *
 * 冻结 M7 装配后的完整上下文；后续 agent 步骤**只读快照**，不再访问图谱。
 *
 * 为什么要冻：一次运行里可能有四五次模型调用，如果每一步各取一次上下文，图谱
 * 在中间被更新过，四节报告就是按四份不同的公司状态写出来的 —— 而屏幕上完全
 * 看不出来。id 用内容哈希而不是随机串：同一份上下文只存一份，而且「这两次运行
 * 看的是不是同一份公司状态」变成一次字符串比较。
 */
import { createHash } from "node:crypto";

import { contextSnapshotGet, contextSnapshotPut } from "@/lib/data/store";

import type { ContextBundle } from "./recipes";

/**
 * 稳定序列化：对象键排序，**数组次序保留**。
 *
 * `JSON.stringify` 按插入序写键，于是同一份上下文换个装配顺序就会算出另一个
 * 哈希，「同一份上下文」这个判断当场失效。数组不能排——`memberIds` 的次序无关
 * 紧要，但 `calls` 的次序就是调用顺序，排掉等于把复现坐标搞坏。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function freezeContext(bundle: ContextBundle): string {
  const body = stableStringify(bundle);
  const snapshotId = `ctx-${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)}`;
  contextSnapshotPut(snapshotId, JSON.parse(body) as ContextBundle);
  return snapshotId;
}

export function loadContext(snapshotId: string): ContextBundle {
  const value = contextSnapshotGet(snapshotId);
  // 报出 id：快照丢了和快照内容不对是两件事，不带 id 的话第一件会被当成第二件查。
  if (value === null) throw new Error(`快照不存在: ${snapshotId}`);
  return value as ContextBundle;
}

export function contextExists(snapshotId: string): boolean {
  return contextSnapshotGet(snapshotId) !== null;
}
