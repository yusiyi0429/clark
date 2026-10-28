import { createHash } from "node:crypto";

/**
 * 固定键序的 JSON：每一层的对象键按 UTF-16 码元顺序排（JS 默认的 `<` 比较，不是 localeCompare），数组保持顺序。
 * 其他核对方（如独立 Chat）重算 payloadHash 时要用同一排序规则。
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : entry);
}

/** 冻结 payload（或写进会议事件的那一份）的摘要值（sha256 hex）：不含 confirmation 和同步回执。 */
export function payloadHash(payload: object): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
