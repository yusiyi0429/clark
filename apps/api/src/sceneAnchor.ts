import type { TAnchorSelection, TReferenceSnapshot } from "@warmap/contracts";
import { randomUUID } from "node:crypto";
import { anchorItem, boundedText, readableValue, type ConversationAnchor } from "./conversationAnchor.js";

/** Only accepts already-authorized projections; each expansion rechecks the current page projection. */
export async function buildSceneAnchor(options: {
  scene: string; period?: string; selection?: TAnchorSelection;
  list: () => Promise<TReferenceSnapshot[]>;
}): Promise<ConversationAnchor> {
  const snapshots = await options.list();
  const selected = options.selection ? snapshots.find(card => card.cardId === options.selection!.cardId) : options.scene === "对象详情" ? snapshots[0] : undefined;
  if (options.selection && !selected) throw Object.assign(new Error("选中项不在当前页面或不可见"), { status: 404, code: "ANCHOR_NOT_FOUND" });
  if (selected && options.selection && selected.version !== options.selection.version) throw Object.assign(new Error("选中卡片已更新，请刷新后再发"), { status: 409, code: "ANCHOR_VERSION_CONFLICT" });
  const ordered = selected ? [selected, ...snapshots.filter(card => card.cardId !== selected.cardId)] : snapshots;
  const runToken = randomUUID();
  const catalog = ordered.map((snapshot, index) => ({ snapshot, item: anchorItem(snapshot, `A${index + 1}`) }));
  const page = (offset: number) => {
    const items = [];
    let bytes = 0;
    for (const { item } of catalog.slice(offset, offset + 12)) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 5800) break;
      items.push(item); bytes += size;
    }
    const next = offset + items.length;
    return { items, more: next < catalog.length, ...(next < catalog.length ? { cursor: `${runToken}:index:${next}` } : {}) };
  };
  return {
    view: { scene: options.scene, ...(options.period ? { period: options.period } : {}),
      ...(selected ? { focus: { handle: "A1", title: boundedText(selected.title, 200), ...(options.selection?.selectedText ? { selection: boundedText(options.selection.selectedText, 800) } : {}) } } : {}),
      summary: `当前可见 ${snapshots.length} 项；本地页面内容不代表 World 最新公司事实`, items: page(0).items, more: page(0).more },
    read: async ({ handle, cursor }) => {
      let offset = 0;
      let activeHandle = handle;
      let textOffset = 0;
      if (cursor) {
        const parts = cursor.split(":");
        if (parts.length !== 3 || parts[0] !== runToken || !/^\d+$/.test(parts[2])) return { unavailable: true, message: "目录游标已失效" };
        if (parts[1] === "index" && !handle) offset = Number(parts[2]);
        else if (/^A\d+$/.test(parts[1]) && (!handle || handle === parts[1])) { activeHandle = parts[1]; textOffset = Number(parts[2]); }
        else return { unavailable: true, message: "目录游标已失效" };
      }
      const current = await options.list();
      const available = new Map(current.map(card => [card.cardId, card]));
      if (activeHandle) {
        const entry = catalog.find(({ item }) => item.handle === activeHandle);
        const latest = entry && available.get(entry.snapshot.cardId);
        if (!entry || !latest) return { unavailable: true, message: "页面项不存在或不可见" };
        if (latest.version !== entry.snapshot.version || JSON.stringify(latest.payload) !== JSON.stringify(entry.snapshot.payload)
          || JSON.stringify((latest as unknown as { viewingMaterial?: unknown }).viewingMaterial) !== JSON.stringify((entry.snapshot as unknown as { viewingMaterial?: unknown }).viewingMaterial)) return { conflict: true, message: "页面内容已更新，请刷新后继续" };
        const fullText = JSON.stringify(readableValue(latest.payload));
        const text = boundedText(fullText.slice(textOffset), 5800);
        const next = textOffset + text.length;
        return { ...entry.item, text, more: next < fullText.length,
          ...(next < fullText.length ? { cursor: `${runToken}:${activeHandle}:${next}` } : {}),
          ...(Object.hasOwn(latest, "viewingMaterial") ? { viewingMaterial: boundedText(JSON.stringify(readableValue((latest as unknown as { viewingMaterial: unknown }).viewingMaterial)), 600) } : {}) };
      }
      // Do not disclose revoked titles or counts from the frozen directory.
      if (catalog.some(({ snapshot }) => !available.has(snapshot.cardId))) return { unavailable: true, message: "页面访问范围已变化，请刷新" };
      return page(offset);
    },
  };
}
