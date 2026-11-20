/**
 * 疑似凭据的样式和两个按文字查、遮的小函数（项目转交、对外资料、同事可用的技能共用）。
 * 不引用别的模块：roles.ts 这类被很多模块引的底层文件也能引它，不成环。
 */

/** 常见密钥样式（同网页 lib/home/transfer.ts）：只认长得像值的，变量名不算。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
];
/** 命中那一截只露前 6 位加 ••••。 */
export const secretSample = (match: string) => `${match.slice(0, 6)}••••`;
/** 一行里第一处像密钥的值（按样式的先后），没有为 undefined。 */
export const secretIn = (text: string) => SECRET_PATTERNS.map((pattern) => pattern.exec(text)?.[0]).find(Boolean);
/** 一段文字里像密钥的行：第几行（从 1 数），命中那一截只露前 6 位加 ••••。 */
export function secretLines(text: string): { line: number; sample: string }[] {
  return text.split(/\r?\n/).flatMap((row, index) => {
    const match = secretIn(row);
    return match ? [{ line: index + 1, sample: secretSample(match) }] : [];
  });
}
/** 把像密钥的值换成前 6 位加 ••••。 */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((masked, pattern) => masked.replace(new RegExp(pattern.source, "g"), secretSample), text);
}
