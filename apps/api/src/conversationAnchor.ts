import type { TReferenceSnapshot } from "@warmap/contracts";

/**
 * 场景锚点（PR #12 Anchor 层，移植到 main）：本人此刻在哪个页面、聚焦哪张卡。模型每轮在上下文包里看到 AnchorView，
 * 用 read_anchor 按短句柄（A1、A2…）展开；对象 id、签名动作与存储元数据留在服务端，不给模型。
 */
export type AnchorItem = { handle: string; kind: string; title: string; state: string;
  meaning: "当前页面内容" | "本地草稿" | "历史快照"; summary: string };
export type AnchorView = {
  scene: string;
  /** 默认读取的月份（与三层取用的默认焦点同一来源，companyMap.defaultFocus）。 */
  period?: string;
  /** 三层取用不填范围时按它读（「我 · 10 月」「全员 · 10 月」）；本人改过的范围（scopeOverride）这一轮优先。 */
  range?: string;
  /**
   * 聚焦的卡。stale：本人页面上看到的是旧版本，锚点里给的是当前版本；
   * changed：「继续」上一轮时这张卡已经更新，给的是当前版本。
   */
  focus?: { handle: string; title: string; stale?: true; changed?: true };
  summary: string;
  items: AnchorItem[];
  more: boolean;
};
export type AnchorRef = { cardId: string; version: number };
export type ConversationAnchor = {
  view: AnchorView;
  /** 聚焦的那张卡（页面对象或本人选中的卡）；三层取用的默认焦点、个人记忆的当前对象都从它来。 */
  focus: TReferenceSnapshot | null;
  /** 存进历史的轻量引用：场景、聚焦卡与目录各项的 id@版本，不含正文（锚点正文只在发给模型时临时注入）。 */
  ref: { scene: string; focus: string | null; items: string[] };
  read: (args: { handle?: string; cursor?: string }) => Promise<unknown>;
  /** read_anchor 展开的句柄对应哪张卡：历史里存它，不存正文。 */
  refOf: (handle: string) => AnchorRef | undefined;
  /** 「继续」按引用重新读正文：读不到给 unavailable，版本变了给当前版本并标 changed。 */
  readRef: (ref: AnchorRef) => Promise<unknown>;
};

/** Byte-bound visible content; object identifiers, signed actions and storage metadata stay server-side. */
export function boundedText(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  for (const character of text) { if (Buffer.byteLength(result) + Buffer.byteLength(character) > bytes) break; result += character; }
  return result;
}
const hiddenFields = /^(id|.*Id|.*Ids|.*_id|.*_ids|version|objectRef|actions|scope|storageKey|sha256|sourceFingerprint|signature|token|serverNow)$/;
export function readableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !hiddenFields.test(key)).map(([key, entry]) => [key, readableValue(entry)]));
}
export function anchorItem(snapshot: TReferenceSnapshot, handle: string): AnchorItem {
  const payload = snapshot.payload as Record<string, unknown> | null;
  const state = String(payload?.status ?? (payload?.task as { status?: string } | undefined)?.status ?? "页面状态");
  return { handle, kind: snapshot.kind, title: boundedText(snapshot.title ?? "当前对象", 200), state: boundedText(state, 80),
    meaning: /draft|negotiating/.test(state) ? "本地草稿" : "当前页面内容",
    summary: boundedText(JSON.stringify(readableValue(snapshot.payload)) ?? "", 280) + (Object.hasOwn(snapshot, "viewingMaterial") ? ` 当前阅读材料：${boundedText(JSON.stringify(readableValue((snapshot as unknown as { viewingMaterial: unknown }).viewingMaterial)), 400)}` : "") };
}
