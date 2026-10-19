/**
 * 交给对话模型的资料里，把内部写法换成正式中文叫法（10/14：「Company Outcome」「01灯塔」出现在一号位看到的回答里）。
 * 从源头减少：本体读取、看板总览、战役与议题清单进模型之前先换一遍；提示词里另有同一条表达要求（promptStyle.ts）。
 * 只换最常见、意思确定的几种；不碰对象 id、引用地址、版本引用和 `cite:` 一类标记，也不碰要做原文比对的修改类工具（材料、业务对象）。
 * 数据库与资料原文不改，工具结果的 details（界面进度行用）也不改。
 */

/** 对照表：资料里的内部写法 → 正式中文叫法。顺序有关：长的、带编号的在前。 */
export const FORMAL_TERM_TABLE: { from: string; to: string; pattern: RegExp }[] = [
  { from: "Company Outcome", to: "公司结果", pattern: /(?<![A-Za-z])Company\s*Outcomes?(?![A-Za-z])/g },
  { from: "Company LTCO", to: "公司长期目标", pattern: /(?<![A-Za-z])Company\s*LTCO(?![A-Za-z])/g },
  { from: "01 灯塔", to: "灯塔项目", pattern: /(?<![\d.:/-])01\s*灯塔(?:项目)?/g },
  { from: "02 TokenOps", to: "TokenOps 项目", pattern: /(?<![\d.:/-])02\s*TokenOps(?![A-Za-z])(?:\s*项目)?/g },
  { from: "03 维信诺", to: "维信诺项目", pattern: /(?<![\d.:/-])03\s*维信诺(?:项目)?/g },
  { from: "02 运营", to: "运营项目", pattern: /(?<![\d.:/-])02\s*运营(?:项目)?/g },
  { from: "Q4 PO", to: "本月目标（Q4）", pattern: /(?<![A-Za-z0-9_-])(?:20\d\d\s*年?\s*)?(Q[1-4])\s*(?:建议\s*)?PO(?![A-Za-z0-9_])/g },
  { from: "LTCO", to: "长期目标", pattern: /(?<![A-Za-z0-9_-])LTCO(?![A-Za-z0-9_])/g },
  { from: "LTO", to: "长期目标", pattern: /(?<![A-Za-z0-9_-])LTOs?(?![A-Za-z0-9_])/g },
  { from: "PO", to: "本月目标", pattern: /(?<![A-Za-z0-9_-])POs?(?![A-Za-z0-9_])/g },
  { from: "LongTermGoal", to: "长期目标", pattern: /(?<![A-Za-z])LongTermGoals?(?![A-Za-z])/g },
  { from: "PeriodGoal", to: "本月目标", pattern: /(?<![A-Za-z])PeriodGoals?(?![A-Za-z])/g },
  { from: "ResponsibilityUnit", to: "战场", pattern: /(?<![A-Za-z])ResponsibilityUnits?(?![A-Za-z])/g },
  { from: "Mission", to: "战役", pattern: /(?<![A-Za-z])Missions?(?![A-Za-z])/g },
  { from: "DRI", to: "负责人", pattern: /(?<![A-Za-z])DRIs?(?![A-Za-z])/g },
  { from: "Owner", to: "负责人", pattern: /(?<![A-Za-z])Owners?(?![A-Za-z])/g },
  { from: "Outcome", to: "结果", pattern: /(?<![A-Za-z])Outcomes?(?![A-Za-z])/g },
  { from: "Battlefield", to: "战场", pattern: /(?<![A-Za-z])Battlefields?(?![A-Za-z])/g },
  { from: "Strategy", to: "战略", pattern: /(?<![A-Za-z])Strategy(?![A-Za-z])/g },
  { from: "Company", to: "公司", pattern: /(?<![A-Za-z])Company(?![A-Za-z])/g },
  { from: "ENO", to: "引擎与本体", pattern: /(?<![A-Za-z0-9_-])ENO(?![A-Za-z0-9_])/g },
];

/**
 * 不能动的片段：链接、`cite:` / `memory:` / `meeting:` 这类引用标记、`对象@版本` 引用、kd-* 文件名。
 * 按这些片段把文字切开，只在片段之间替换。
 */
const PROTECTED = /https?:\/\/[^\s"'）)」』，,；;\]]+|(?<![A-Za-z0-9])[a-z][a-z_-]*:[A-Za-z0-9][A-Za-z0-9_./#@-]*|[A-Za-z0-9_-]+@v?\d+(?:#[A-Za-z0-9_-]+)?|(?<![A-Za-z0-9])kd-[A-Za-z0-9_-]+(?:\.md)?(?:#[A-Za-z0-9_-]+)?/g;
const QUICK_CHECK = /Company|LTCO|LTO|PO|灯塔|TokenOps|维信诺|运营|Goal|ResponsibilityUnit|Mission|DRI|Owner|Outcome|Battlefield|Strategy|ENO/;

/** 换进来的词用这两个字符临时包住，处理完空格再去掉。 */
const START = "\u0002", END = "\u0003";
/** 汉字、全角标点与开括号：紧挨着它们的空格去掉。 */
const TIGHT_LEFT = "[\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef（(「『《“\\[]";
const TIGHT_RIGHT = "[\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef，。；：、）)」』》”\\],.;:!?]";
const HAN = "[\\u3400-\\u9fff]";
/** 只在换进来的词这一侧是汉字时才去空格：「词元云集 02 TokenOps」→「词元云集 TokenOps 项目」保留空格。 */
const SPACE_BEFORE = new RegExp(`(${TIGHT_LEFT}|${END})[ \\t]+${START}(?=${HAN})`, "g");
const SPACE_AFTER = new RegExp(`(?<=${HAN})${END}[ \\t]+(?=${TIGHT_RIGHT}|${START})`, "g");
const MARKS = new RegExp(`[${START}${END}]`, "g");

function replaceTerms(text: string): string {
  let out = text;
  for (const { pattern, to, from } of FORMAL_TERM_TABLE) {
    out = out.replace(pattern, (_match, quarter?: unknown) => `${START}${from === "Q4 PO" ? to.replace("Q4", String(quarter)) : to}${END}`);
  }
  // 换进来的词紧挨着汉字或标点时去掉中间的空格（「3 个 LTO」→「3 个长期目标」、「Mission DRI」→「战役负责人」）；挨着英文、数字时保留（「TKOS Mission」→「TKOS 战役」）。
  out = out.replace(SPACE_BEFORE, `$1${START}`).replace(SPACE_AFTER, END).replace(MARKS, "");
  // 资料里的「集团 / Company」「Company（集团）」换完成了「集团 / 集团」「集团（集团）」：去重。
  return out.replace(/([一-鿿]{2,6})\s*[/／]\s*\1(?![一-鿿])/g, "$1").replace(/([一-鿿]{2,6})[（(]\1[）)]/g, "$1");
}

/** 一段文字里的内部写法换成正式中文叫法；受保护的片段（链接、引用标记、id@版本）原样保留。幂等。 */
export function formalTerms(text: string): string {
  if (!text || !QUICK_CHECK.test(text)) return text;
  let out = "", last = 0;
  for (const match of text.matchAll(PROTECTED)) {
    out += replaceTerms(text.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  return out + replaceTerms(text.slice(last));
}

/** 这些字段的值是 id、引用、地址、枚举，原样保留。 */
const KEEP_KEY = /^(?:id|ids|ref|refs|cite|cites|url|urls|href|uri|key|slug|type|kind|status|sourceRef|.*(?:Id|Ids|Ref|Refs|Url|Key))$/;

/** 工具结果、上下文包这类 JSON 值：只换字符串值，跳过 id、引用、地址类字段；对象的键不动。返回新值，不改原对象。 */
export function formalTermsDeep<T>(value: T): T {
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === "string") return key && KEEP_KEY.test(key) ? item : formalTerms(item);
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([name, entry]) => [name, walk(entry, name)]));
    }
    return item;
  };
  return walk(value) as T;
}
