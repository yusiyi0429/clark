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
