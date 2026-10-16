/**
 * 给 CEO 看的来源与正文清洗（纯展示层）：出处只留文档短名，ID / token / revision / 完整 URL 收进 hover（title）；
 * 企业知识的内部文件名（kd-*）换成中文名；正文去掉 @某人 与 Markdown 表格残留。原始数据不改。
 */

/** 首演资料包里企业知识文档的中文短名（与资料包 memory[].title 对应，去掉了版本、括注）。 */
const KNOWLEDGE_NAMES: Record<string, string> = {
  "kd-company": "集团身份、原则与战略",
  "kd-battlefields": "三个战场：责任、边界与价值链",
  "kd-goals": "目标：长期目标、本月目标与候选战役",
  "kd-people": "责任名单",
  "kd-metrics": "指标口径与统计规则",
  "kd-gaps": "待补与未核实事项",
  "kd-demo-materials": "资料说明",
  "kd-tk-september-review": "词元云集 9 月复盘",
  "kd-tk-meeting-0712": "词元云集 7/12 会议未决问题",
};

/**
 * 材料名只显示原始标题：资料包里的文字层抽取件叫「标题（PDF 文字版）.md」「标题（Word 文字版）.md」，括注和后面的扩展名是内部后缀，不给一号位看。
 * 没有这种后缀的文件名原样返回（普通文件的扩展名由各处自己的规则处理）。
 */
const TEXT_LAYER_SUFFIX_RE = /\s*[（(][^（）()]*文字版[^（）()]*[）)]\s*(?:\.[A-Za-z0-9]{1,5})?\s*$/;
export function materialTitle(fileName: string): string {
  const title = fileName.replace(TEXT_LAYER_SUFFIX_RE, "").trim();
  return title || fileName;
}

/** 企业知识文件名 → 中文名：已知的 kd-* 用映射；其他 kd-* 写「企业知识」；普通文件名去掉 .md。 */
export function knowledgeName(file: string): string {
  const base = file.replace(/\.md$/i, "").trim();
  if (KNOWLEDGE_NAMES[base]) return KNOWLEDGE_NAMES[base];
  if (/^kd-/i.test(base)) return "企业知识";
  return base;
}

const URL_RE = /https?:\/\/[^\s）)」』，,；;]+/g;
/** 括号里只装着链接、wiki / docx token、revision 等后台信息的整段括注。 */
const TECH_PAREN_RE = /[（(][^（）()]*(?:https?:\/\/|wiki\s|docx\s|revision|token)[^（）()]*[）)]/gi;

/** 去掉书名号里的括注：《Company 词元云集（知识库页，「9月复盘」章节）》→ 《Company 词元云集》。 */
const stripTitleNote = (title: string) => title.replace(/[（(][^（）()]*[）)]\s*$/, "").trim();

const SOURCE_WORDS: Record<string, string> = { manual: "手工录入", ontology: "公司资料", import: "资料导入" };

const CONVERSATION_CONFIRMED_RE = /^(?:CEO|一号位)\s*对话确认/;

/**
 * 一条出处的短名：优先取书名号里的文档名（去重，最多两个）；没有书名号时去掉链接与括注、取第一段，
 * 去掉「虚构资料/」「真实会议纪要：」这类资料包内部前缀后加书名号。完整原文由调用方放进 title。
 */
export function shortSourceName(ref: string | null | undefined): string {
  const raw = (ref ?? "").trim();
  if (!raw) return "";
  if (SOURCE_WORDS[raw]) return SOURCE_WORDS[raw];
  // 对话里明说改法后写入的判断：服务端出处是「一号位对话确认（时间）」，旧数据是「CEO 对话确认（时间）」；界面统一写「对话中确认」（巡检 P2-21）。
  if (CONVERSATION_CONFIRMED_RE.test(raw)) return shortSourceName(raw.replace(CONVERSATION_CONFIRMED_RE, "对话中确认"));
  const memory = /^memory:([^#]+)/.exec(raw);
  if (memory) return `《${knowledgeName(memory[1])}》`;
  if (/^kd-/i.test(raw)) return `《${knowledgeName(raw)}》`;
  const titles = [...new Set([...raw.matchAll(/《([^《》]+)》/g)].map((match) => stripTitleNote(match[1])).filter(Boolean))];
  if (titles.length) return titles.slice(0, 2).map((title) => `《${title}》`).join("、") + (titles.length > 2 ? ` 等 ${titles.length} 份` : "");
  const cut = raw.replace(TECH_PAREN_RE, "").replace(URL_RE, "").split(/[；;]/)[0]
    .replace(/[（(][^（）()]*[）)]/g, "");
  const packed = /^(?:虚构资料|真实资料|演示资料)\s*[/／]/.test(cut);
  const first = cut
    .replace(/^(?:虚构资料|真实资料|演示资料)\s*[/／]\s*/, "")
    .replace(/^[^：:《]{0,8}[：:]\s*/, (prefix) => (/纪要|资料|来源/.test(prefix) ? "" : prefix))
    .trim();
  const head = packed ? first.split(/[/／]/)[0].trim() : first;
  if (!head) return "资料";
  return packed && !/^[《「]/.test(head) ? `《${head}》` : head;
}

/** 一组出处去重后的短名（保留顺序），每条带上原文供 hover。 */
export function uniqueSources(refs: (string | null | undefined)[]): { name: string; full: string }[] {
  const seen = new Map<string, string[]>();
  for (const ref of refs) {
    const name = shortSourceName(ref);
    if (!name) continue;
    const list = seen.get(name) ?? [];
    if (ref && !list.includes(ref)) list.push(ref);
    seen.set(name, list);
  }
  return [...seen].map(([name, full]) => ({ name, full: full.join("\n") }));
}

/** 一行 Markdown 表格（| a | b | c |）→ 一句话「a：b；c」；分隔行（|-|-|）返回空串；不是表格行原样返回。 */
export function tableRowToSentence(line: string): string {
  const trimmed = line.trim();
  if (!/^\|.*\|$/.test(trimmed)) return line;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.replace(/\*\*/g, "").trim().replace(/[。；;]+$/, "")).filter(Boolean);
  if (!cells.length || cells.every((cell) => /^:?-+:?$/.test(cell))) return "";
  const [head, ...rest] = cells;
  return rest.length ? `${head}：${rest.join("；")}` : head;
}

/** 引用写法（预审、Agent 内部依据里的 `meeting:<id>`、`material:<id>@v1#p3`）。 */
const INTERNAL_REF_RE = /[ \t]*(?<![A-Za-z0-9])(?:meeting|material|issue|research|discussion|decision|feedback|fact|signal|transcript|outcome|thread|mission|todo|cite):[A-Za-z0-9][A-Za-z0-9_-]*(?:@v\d+)?(?:#[A-Za-z0-9_-]+)?/g;
const MEMORY_REF_RE = /(?<![A-Za-z0-9])memory:([A-Za-z0-9][A-Za-z0-9_-]*)(?:#[A-Za-z0-9_-]+)?/g;
/** 模型偶尔照抄的输入字段名 → 中文。 */
const FIELD_WORDS: Record<string, string> = {
  decisionHistory: "历史决定", groupMaterials: "群材料", relatedMeeting: "关联会议", sourceMaterial: "源材料",
  inputCoverage: "预审依据", changesNote: "执行变化说明", taskDefinition: "评审范围",
};
const FIELD_RE = new RegExp(`(?<![A-Za-z])(?:${Object.keys(FIELD_WORDS).join("|")})(?![A-Za-z])(?:[ \\t](?=\\p{Script=Han}))?`, "gu");

/**
 * 给一号位看的正文里去掉内部引用写法（`meeting:<id>`、`material:<id>@v1`）和输入字段名（decisionHistory 等）；
 * `memory:<章节>` 换成企业知识的中文名。纯展示层，原始数据不改。
 */
export function stripInternalRefs(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(MEMORY_REF_RE, (_, id: string) => `《${knowledgeName(id)}》`)
    .replace(INTERNAL_REF_RE, "")
    .replace(FIELD_RE, (word) => FIELD_WORDS[word.trim()] ?? word)
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 给 CEO 看的正文：去掉「@某人」、括号里的链接与后台 token、裸链接、内部引用写法；Markdown 表格行改写成句子；粗体记号去掉。
 */
export function cleanDisplayText(text: string | null | undefined): string {
  if (!text) return "";
  return stripInternalRefs(text)
    .split(/\r?\n/)
    .map(tableRowToSentence)
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
    .join("\n")
    .replace(TECH_PAREN_RE, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(URL_RE, "")
    .replace(/\s*(?<![A-Za-z0-9])@[\p{Script=Han}A-Za-z0-9_-]{1,20}/gu, "")
    .replace(/\*\*/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * 截止日是否已过（按公司日历日比较，today 用 YYYY-MM-DD）：有 dueDate 用 dueDate；没有时从正文里认「时间：预计 2026 年 8 月初」
 * 这类写法（月初 / 月中按当月 10 / 20 日，月底或只写月份按月末）。认不出返回 false。
 */
export function isPastDue(dueDate: string | null | undefined, text: string | null | undefined, today: string): boolean {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(dueDate ?? "")?.[0] ?? dueFromText(text ?? "");
  return Boolean(day && day < today);
}

function dueFromText(text: string): string | null {
  const match = /(?:时间|截止|完成时间|预计)[：:]?\s*(?:预计\s*)?(\d{4})\s*年\s*(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日|(初|上旬|中|中旬|底|末|下旬))?/.exec(text);
  if (!match) return null;
  const [, year, month, date, part] = match;
  const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const dayOfMonth = date ? Number(date) : part === "初" || part === "上旬" ? 10 : part === "中" || part === "中旬" ? 20 : last;
  return `${year}-${month.padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}

/** HeroUI 页签两侧滚动键的 aria 写死了英文；渲染后改成中文（巡检 P2-31）。 */
const TAB_SCROLL_LABEL: Record<string, string> = {
  "Scroll tabs left": "页签向左滚动", "Scroll tabs right": "页签向右滚动", "Scroll tabs up": "页签向上滚动", "Scroll tabs down": "页签向下滚动",
};
export function localizeTabScrollButtons(root: ParentNode | null | undefined): void {
  root?.querySelectorAll<HTMLElement>("button[aria-label^='Scroll tabs']").forEach((button) => {
    const label = TAB_SCROLL_LABEL[button.getAttribute("aria-label") ?? ""];
    if (label) button.setAttribute("aria-label", label);
  });
}

// ---------- 一号位用语：LTO / PO 缩写 → 中文，去括注（纯展示层，数据库原文不改） ----------

const CJK_NEIGHBOR = /[㐀-鿿　-〿＀-￯]/;
/** 术语独立成词：前后不是字母 / 数字 / 下划线，前面也不是连字符（A4-PO 这类章节编号不动）；TPO、POC、PORT 不受影响。 */
const NOT_WORD_BEFORE = "(?<![A-Za-z0-9_-])";
const NOT_WORD_AFTER = "(?![A-Za-z0-9_])";
const TERM_RE = new RegExp(String.raw`(\s*)${NOT_WORD_BEFORE}(LTO|PO)${NOT_WORD_AFTER}(\s*)`, "g");
/** 带季度的目标：「2026 Q4 建议 PO」「Q4 PO」「Q4 目标」。目标只分长期目标、本月目标两类，整段写成「本月目标（Q4）」：季度信息留在括号里。 */
const QUARTER_GOAL_RE = new RegExp(String.raw`([ \t]*)${NOT_WORD_BEFORE}(?:20\d\d[ \t]*年?[ \t]*)?(Q[1-4])[ \t]*(?:建议[ \t]*)?(?:PO${NOT_WORD_AFTER}|目标)([ \t]*)`, "g");
/** 〔…〕整段是资料原文里的备注（〔建议〕〔建议 LTO〕〔建议，非已批承诺〕〔沿用词元云集现有长期目标〕），显示时整段去掉，连前面的空格。 */
const BRACKET_NOTE_RE = /[ \t]*〔[^〔〕]*〕/g;
/** 全角（…）括注里带这些词的才去：建议 / PO / LTO / 既有 / 承诺 / 长期目标（「（2026 Q4 建议 PO）」「（2026 年 10 月既有 PO）」「（非正式承诺）」）；正文里别的括号不动。 */
const NOTE_WORD = String.raw`(?:建议|既有|承诺|长期目标|${NOT_WORD_BEFORE}(?:PO|LTO)${NOT_WORD_AFTER})`;
const PAREN_NOTE_RE = new RegExp(String.raw`[ \t]*（[^（）]*${NOTE_WORD}[^（）]*）`, "g");
const NEEDS_TERMS_RE = /LTO|PO|〔|（|Q[1-4]|Demo/;
/**
 * 本体与资料原文里的「Demo」措辞（如长期目标成功标准「不能以 Demo 或产品接通替代真实客户使用与付费」）：一号位看的文字不出现
 * 演示类字眼，按资料包构建时的同一组改写（data/集团待命名-演示1/build-pack.mjs WORDS）显示。
 */
const DEMO_WORDS: [RegExp, string][] = [[/本次 ?Demo ?不展开/g, "本次不展开"], [/不能以 ?Demo ?或产品接通替代/g, "不能以产品试用或接通替代"], [/ ?Demo ?客户/g, "样板客户"]];

/** 汉字（含全角标点）紧挨着中文词时去掉多余空格；换行、拉丁字母 / 数字一侧的空格保留。 */
function tidy(space: string, neighbor: string | undefined): string {
  if (!space || space.includes("\n")) return space;
  return neighbor && CJK_NEIGHBOR.test(neighbor) ? "" : space;
}

/** 去括注：整段〔…〕，以及带「建议 / PO / LTO / 既有 / 承诺 / 长期目标」的全角（…）。其他括号原样。 */
export function stripGoalNotes(text: string | null | undefined): string {
  if (!text) return "";
  if (!/[〔（]/.test(text)) return text;
  return text.replace(BRACKET_NOTE_RE, "").replace(PAREN_NOTE_RE, "");
}

/**
 * 一号位看的正文里，把 LTO / PO 缩写换成中文，并去掉括注：
 * - LTO → 长期目标，PO → 本月目标；带季度的「2026 Q4 建议 PO」「Q4 PO」「Q4 目标」统一写「本月目标（Q4）」（保留季度；目标只分长期目标、本月目标两类）；
 * - 去括注（stripGoalNotes）：〔建议〕〔建议 LTO〕〔建议，非已批承诺〕〔沿用…〕整段去掉；（2026 Q4 建议 PO）（2026 年 10 月既有 PO）（非正式承诺）这类带关键词的括注去掉，别的括号不动。
 * 只换独立的缩写词（TPO、POC、PORT、A4-PO 这类不动）；中文旁边的多余空格一并去掉。幂等，原始数据不改。
 */
export function ceoTerms(text: string | null | undefined): string {
  if (!text) return "";
  if (!NEEDS_TERMS_RE.test(text)) return text;
  return DEMO_WORDS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), stripGoalNotes(text))
    .replace(QUARTER_GOAL_RE, (match, lead: string, quarter: string, trail: string, offset: number, whole: string) =>
      `${tidy(lead, whole[offset - 1])}本月目标（${quarter}）${tidy(trail, whole[offset + match.length])}`)
    .replace(TERM_RE, (match, lead: string, term: string, trail: string, offset: number, whole: string) =>
      `${tidy(lead, whole[offset - 1])}${term === "LTO" ? "长期目标" : "本月目标"}${tidy(trail, whole[offset + match.length])}`);
}

/** 递归地对对象 / 数组里所有字符串做 ceoTerms（卡片、列表等接口返回的展示数据）；没有缩写时原样返回同一引用。 */
export function ceoTermsDeep<T>(value: T): T {
  if (typeof value === "string") return (NEEDS_TERMS_RE.test(value) ? ceoTerms(value) : value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => { const mapped = ceoTermsDeep(item); if (mapped !== item) changed = true; return mapped; });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const mapped = ceoTermsDeep(item);
      if (mapped !== item) changed = true;
      next[key] = mapped;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
