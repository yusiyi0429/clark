/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/limits.py
 *
 * M7 接口自身的硬约束。写在一处，是因为它们是**服务端**的约束，不是我们的
 * 选择：抄第二份就一定会有一份忘了跟着改，而这类不一致的表现是线上 422、
 * 离线全绿。
 */

/**
 * P3（`/api/v1/context/dynamic`）的 q 上限。超了服务端返回 422
 * `string_too_long`，**不是**悄悄截断——所以必须由调用方先裁。
 *
 * 实验台踩过这个坑：这条约束曾经只有配方装配那一处遵守，锚点检索那一处没有。
 * 一条真实信号两三百字，于是每次实验的第一步（按问题选锚点）都 422，表现是
 * 「找不到 CARD-* 锚点」——看起来像图谱里没有，实际是请求根本没被受理。
 */
export const P3_MAX_QUERY_CHARS = 100;

/** 句读。断在这些字符后面，不断在词中间。 */
const MARKS = "。！？；，";

/**
 * 把一段自然语言裁成 P3 收得下的检索式。
 *
 * 换行与全角竖线一律折成空格（多行信号原文直接送过去，服务端只看总长），
 * 尽量断在句读上——断在词中间会把最后一个词切成两半，那是给 embedding 添
 * 噪音。找不到句读（一整句没有标点）就硬切。
 */
export function clip(value: string, limit: number = P3_MAX_QUERY_CHARS): string {
  const flat = (value ?? "").replace(/[\s｜|]+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const head = flat.slice(0, limit);
  let cut = -1;
  for (const mark of MARKS) cut = Math.max(cut, head.lastIndexOf(mark));
  // 断出两三个字的检索式对 embedding 毫无意义，那还不如硬切满 100 字。
  return cut >= 10 ? head.slice(0, cut + 1) : head;
}
