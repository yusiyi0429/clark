import { createHash } from "node:crypto";
import type { TMeetingCardV1Payload } from "@warmap/contracts";

/** 固定键序的 JSON：对象键按字典序（每一层），数组保持顺序。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : entry);
}

/** 冻结 payload 的摘要值（sha256 hex）：不含 confirmation 和同步回执。 */
export function payloadHash(payload: TMeetingCardV1Payload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
