/**
 * 公司（战场）称呼：面向 CEO 的文字一律用中文名（AIDC、词元云集、房懂懂），不用内部简称或代号（TK、FDD）。
 * 英文简称按整词匹配（TK 不命中 TKOS）。
 */
export type BattlefieldName = { id: string; name: string; code?: string | null };

const ASCII_WORD = /^[A-Za-z0-9]+$/;
const wordPattern = (value: string, flags = "") => new RegExp(`(?<![A-Za-z0-9])${value}(?![A-Za-z0-9])`, flags);

export function mentionsBattlefield(text: string, battlefield: BattlefieldName): boolean {
  return [battlefield.name, battlefield.code, battlefield.id].some((word) => {
    const value = word?.trim();
    if (!value) return false;
    return ASCII_WORD.test(value) ? wordPattern(value, "i").test(text) : text.includes(value);
  });
}

/** 把战场的英文代号（编号、id）换成战场名；名字本身就是这个代号的（如 AIDC）不换。中文和英文字母之间补一个空格。 */
export function plainCompanyNames(text: string, battlefields: BattlefieldName[]): string {
  let next = text;
  for (const battlefield of battlefields) {
    const name = battlefield.name.trim();
    if (!name) continue;
    for (const alias of new Set([battlefield.code?.trim(), battlefield.id.trim()])) {
      if (!alias || !ASCII_WORD.test(alias) || alias.toLowerCase() === name.toLowerCase()) continue;
      next = next.replace(wordPattern(alias, "gi"), name);
    }
  }
  return next
    // 代号两边原有的空格在换成中文名后多余
    .replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, "$1")
    .replace(/(\p{Script=Han})([A-Za-z])/gu, "$1 $2")
    .replace(/([A-Za-z])(\p{Script=Han})/gu, "$1 $2");
}
