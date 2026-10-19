import type { TAnchorSelection, TReferenceSnapshot } from "@warmap/contracts";
import { randomUUID } from "node:crypto";
import { anchorItem, boundedText, readableValue, type ConversationAnchor } from "./conversationAnchor.js";

/**
 * 只接受已授权的页面投影（list 由路由按本人权限给出）；每次展开都重新 list，按当前权限与当前版本复查。
 * objectPage：对象页没有选中项时聚焦页面对象本身；首页没有选中项时不聚焦。
 * 选中项不在当前页面投影里（不存在或看不到）→ 404 ANCHOR_NOT_FOUND；页面上的版本比当前旧 → 照常聚焦当前版本并标 stale。
 * resumed（「继续」按上一轮记下的引用重建）：聚焦卡读不到就不聚焦，版本变了按当前版本并标 changed。
 */
export async function buildSceneAnchor(options: {
  scene: string; objectPage: boolean; selection?: TAnchorSelection; resumed?: boolean;
  list: () => Promise<TReferenceSnapshot[]>;
}): Promise<ConversationAnchor> {
  const snapshots = await options.list();
  const selected = options.selection ? snapshots.find(card => card.cardId === options.selection!.cardId) : options.objectPage ? snapshots[0] : undefined;
  if (options.selection && !selected && !options.resumed) throw Object.assign(new Error("当前页面上聚焦的卡不存在或看不到，请刷新后再发"), { status: 404, code: "ANCHOR_NOT_FOUND" });
  const mismatch = Boolean(selected && options.selection && selected.version !== options.selection.version);
  const stale = mismatch && !options.resumed;
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
  const bodyOf = (snapshot: TReferenceSnapshot) => JSON.stringify(readableValue(snapshot.payload));
  const materialOf = (snapshot: TReferenceSnapshot) => Object.hasOwn(snapshot, "viewingMaterial")
    ? { viewingMaterial: boundedText(JSON.stringify(readableValue((snapshot as unknown as { viewingMaterial: unknown }).viewingMaterial)), 600) } : {};
  return {
    focus: selected ?? null,
    ref: { scene: options.scene, focus: selected ? `${selected.cardId}@${selected.version}` : null,
      items: catalog.map(({ snapshot, item }) => `${item.handle}=${snapshot.cardId}@${snapshot.version}`) },
    refOf: (handle) => {
      const entry = catalog.find(({ item }) => item.handle === handle);
      return entry ? { cardId: entry.snapshot.cardId, version: entry.snapshot.version } : undefined;
    },
    readRef: async (ref) => {
      const latest = (await options.list()).find(card => card.cardId === ref.cardId);
      if (!latest) return { unavailable: true, message: "这一项已不存在或不可见" };
      return { kind: latest.kind, title: boundedText(latest.title, 200),
        ...(latest.version !== ref.version ? { changed: true, message: "这一项在上次展开后有更新，以下是最新内容" } : {}),
        text: boundedText(bodyOf(latest), 5800), ...materialOf(latest) };
    },
    view: { scene: options.scene,
      ...(selected ? { focus: { handle: "A1", title: boundedText(selected.title, 200), ...(stale ? { stale: true as const } : {}),
        ...(mismatch && options.resumed ? { changed: true as const } : {}) } } : {}),
      summary: `当前可见 ${snapshots.length} 项；本地页面内容不代表 World 最新公司事实${stale ? "；本人页面上的聚焦卡是旧版本，这里给的是当前版本" : ""}`,
      items: page(0).items, more: page(0).more },
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
        // 本轮开始后这一项变了（版本、可读内容或正在看的材料）：给最新内容并说明变化，不悄悄当成本轮开始时的那一版。
        const material = (snapshot: TReferenceSnapshot) => JSON.stringify((snapshot as unknown as { viewingMaterial?: unknown }).viewingMaterial);
        const changed = latest.version !== entry.snapshot.version || material(latest) !== material(entry.snapshot)
          || JSON.stringify(readableValue(latest.payload)) !== JSON.stringify(readableValue(entry.snapshot.payload));
        const fullText = bodyOf(latest);
        let text = boundedText(fullText.slice(textOffset), 5800);
        const result = () => {
          const next = textOffset + text.length;
          return { ...entry.item, ...(changed ? { changed: true, message: "这一项在本轮开始后有更新，以下是最新内容" } : {}), text, more: next < fullText.length,
            ...(next < fullText.length ? { cursor: `${runToken}:${activeHandle}:${next}` } : {}),
            ...materialOf(latest) };
        };
        while (Buffer.byteLength(JSON.stringify(result())) > 8192) text = boundedText(text, Math.floor(Buffer.byteLength(text) * 0.8));
        return result();
      }
      // Do not disclose revoked titles or counts from the frozen directory.
      if (catalog.some(({ snapshot }) => !available.has(snapshot.cardId))) return { unavailable: true, message: "页面访问范围已变化，请刷新" };
      return page(offset);
    },
  };
}
