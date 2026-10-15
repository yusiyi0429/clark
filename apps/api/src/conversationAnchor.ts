import type { TReferenceSnapshot } from "@warmap/contracts";

export type AnchorItem = { handle: string; kind: string; title: string; state: string;
  meaning: "当前页面内容" | "本地草稿" | "历史快照"; summary: string };
export type AnchorView = { scene: string; period?: string; focus?: { handle: string; title: string; selection?: string };
  summary: string; items: AnchorItem[]; more: boolean };
export type ReferenceView = { handle: string; kind: "company" | "personal" | "explicit" | "attachment" | "history" | "external";
  title: string; text: string; state?: string };
export type ConversationAnchor = { view: AnchorView; read: (args: { handle?: string; cursor?: string }) => Promise<unknown> };

/** Byte-bound visible content; object identifiers, signed actions and storage metadata stay server-side. */
export function boundedText(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  for (const character of text) { if (Buffer.byteLength(result) + Buffer.byteLength(character) > bytes) break; result += character; }
  return result;
}
const hiddenFields = /^(id|.*Id|.*Ids|.*_id|.*_ids|version|objectRef|actions|scope|storageKey|sha256|sourceFingerprint|signature|token)$/;
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
export function fallbackAnchor(scope: string, snapshot: TReferenceSnapshot | null): ConversationAnchor {
  const items = snapshot ? [anchorItem(snapshot, "A1")] : [];
  return { view: { scene: scope === "global" ? "公司首页" : "对象详情", summary: "当前本地页面；不代表 World 最新公司事实", items, more: false },
    read: async () => ({ unavailable: true, message: "此调用未提供可展开的页面目录" }) };
}
