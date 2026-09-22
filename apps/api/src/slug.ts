/**
 * 注册表 id 的稳定 slug：NFKC 归一、小写、非字母数字折成 '-'，中文保留。
 * 空结果由调用方回退 uuid（纯符号名称）。
 */
export function slugId(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 改名去重按“显示重名”判：其他行的 id 或其名称 slug 等于新 slug 都算冲突。
 * 只比 id 会漏掉 migration 种下的手写 id（如 growth 的显示名是增长战场）。
 */
export function hasNameSlugConflict(
  rows: { id: string; name: string }[],
  selfId: string,
  nextSlug: string | null,
): boolean {
  if (!nextSlug) return false;
  return rows.some((row) => row.id !== selfId && (row.id === nextSlug || slugId(row.name) === nextSlug));
}
