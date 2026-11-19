import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 界面上任何地方不出省略号（本人 11/18；网页那一侧的守门在 apps/web/src/styles/noEllipsis.test.ts）。
 * 这里守后端和本机程序：apps/api/src、apps/local/src 里代码拼上去的「…」。超长就截断，不拼任何符号；
 * 预览、摘要这类要收起的，由网页渐隐。
 *
 * 怎么认「拼」：字符串字面量和模板字符串的每一段里，单个「…」（不是「……」）在这一段去掉首尾空白后的开头或结尾，
 * 或者这一段很短（像「| … |」这种占位）。提示词正文里夹在句子中间的「…」「……」是写给模型的内容，不算。
 *
 * ALLOWED：只给模型看（提示词、上下文材料、对话压缩）或写日志的，以及不是拼上去的（原文内容），保留。
 * 键是「文件（相对 apps/）」和字面量所在的具名函数、变量、方法或属性（不按行号，行号会挪）；texts 是那里放行的每一段字面量原文，
 * 一处一条（同一个名字下多拼一处、或者原文变了，都对不上、都挂）。每条写明理由。
 */
const ALLOWED: { file: string; owner: string; texts: string[]; reason: string }[] = [
  { file: "api/src/articleText.ts", owner: "hellip", texts: ["…"], reason: "不是拼的：HTML 实体 &hellip; 解码回原文里的「…」，是文章内容。" },
  { file: "api/src/battlefieldSummary.ts", owner: "clip", texts: ["…"], reason: "战场汇总的输入材料，只给汇总模型看。" },
  { file: "api/src/companyMap.ts", owner: "clip", texts: ["…"], reason: "read_scope 沿公司地图读的工具结果，只给对话模型看。" },
  { file: "api/src/conversationCompaction.ts", owner: "clip", texts: ["…（已截断）"], reason: "对话压缩交给压缩模型的文字。" },
  { file: "api/src/conversationDigests.ts", owner: "clip", texts: ["…"], reason: "整理会话纪要时交给纪要模型的原话。" },
  { file: "api/src/conversationHistorySearch.ts", owner: "snippetOf", texts: ["…", "…"], reason: "检索历史对话的工具结果片段，只给对话模型看。" },
  { file: "api/src/conversationRecall.ts", owner: "clip", texts: ["…"], reason: "回看以前对话的工具结果和首页「以前的对话」资料卡（Chat 放进本轮资料），只给模型看。" },
  { file: "api/src/conversationRecovery.ts", owner: "tail", texts: ["…"], reason: "点「继续」时交给模型的接续说明（上一轮回答的结尾）。" },
  { file: "api/src/conversationStream.ts", owner: "clipText", texts: ["…（较早一轮的内容较长，已截短）"], reason: "此前几轮的提问、回答截短后放进模型历史。" },
  { file: "api/src/mcpCeoReads.ts", owner: "short", texts: ["…"], reason: "/mcp/me 只读工具的结果，给本机执行方的模型看。" },
  { file: "api/src/mcpWebSearch.ts", owner: "excerpt", texts: ["…"], reason: "/mcp/me 的 web_search 结果摘要，给本机执行方的模型看。" },
  { file: "api/src/meetingCardRead.ts", owner: "snippetOf", texts: ["…", "…"], reason: "检索会议卡的工具结果片段，只给模型看。" },
  { file: "api/src/meetingContext.ts", owner: "clip", texts: ["…"], reason: "会后解读、影响卡追问的模型输入。" },
  { file: "api/src/meetingEvidence.ts", owner: "paragraphs", texts: ["…"], reason: "预审和 Chat 读群材料的正文段落，只给模型看。" },
  { file: "api/src/missionPlanRead.ts", owner: "clip", texts: ["…"], reason: "/internal/mission-plans 给独立 Chat 的模型读的计划条目。" },
  { file: "api/src/personalMemoryRecall.ts", owner: "recallDirectory", texts: ["…"], reason: "个人记忆召回给模型的目录。" },
  { file: "api/src/piConversationRuntime.ts", owner: "content", texts: ["…"], reason: "空闲重启时补进模型历史的最近几条消息。" },
  { file: "api/src/piConversationRuntime.ts", owner: "excerpt", texts: ["…"], reason: "对话里 web_search 交给模型的结果摘要（进度行只取标题）。" },
  { file: "api/src/piConversationRuntime.ts", owner: "clip", texts: ["\n…（已截断，可用 read_material 读全文）"], reason: "read_group_evidence 交给模型的材料正文。" },
  { file: "api/src/preflightAnchors.ts", owner: "clip", texts: ["…"], reason: "会前预审按挂点读的内容，只给预审模型看。" },
  { file: "api/src/tracing.ts", owner: "clip", texts: ["…[+"], reason: "上报运行轨迹（日志）的正文截断。" },
  { file: "api/src/worldReader.ts", owner: "clip", texts: ["…"], reason: "read_ontology 等工具结果里的本体组件正文，只给模型看。" },
  { file: "local/src/handoff.ts", owner: "clip", texts: ["…（共 "], reason: "换执行方时补给新执行方的上下文（只拼进送出去的那句，不记进事件）和 read_earlier_turns 的结果，只给模型看。" },
  { file: "local/src/planCheck.ts", owner: "planFactsSection", texts: ["…"], reason: "写进规划员系统提示词的那一节。" },
];

const APPS = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["api/src", "local/src"];
const SHORT = 12;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** 单个「…」（前后都不是「…」）的位置。 */
function singles(text: string): number[] {
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "…" && text[index - 1] !== "…" && text[index + 1] !== "…") at.push(index);
  }
  return at;
}

function spliced(text: string): boolean {
  const trimmed = text.trim();
  const found = singles(trimmed);
  if (!found.length) return false;
  return trimmed.length <= SHORT || found.some((index) => index === 0 || index === trimmed.length - 1);
}

type Hit = { file: string; owner: string; line: number; text: string };

/** 这一段字面量在哪个具名的函数、变量、方法或属性里（最近的那个）；白名单按它认，不按行号。 */
function ownerOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isVariableDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isPropertyAssignment(at) || ts.isPropertyDeclaration(at)) && at.name) {
      return at.name.getText();
    }
  }
  return "";
}

function hits(): Hit[] {
  const out: Hit[] = [];
  for (const root of ROOTS) {
    for (const path of sources(join(APPS, root))) {
      const code = readFileSync(path, "utf8");
      const file = relative(APPS, path).replaceAll("\\", "/");
      const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const text = (node as ts.LiteralLikeNode).text;
          if (spliced(text)) out.push({ file, owner: ownerOf(node), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return out;
}

/** 按白名单逐段对：extra 是放不过的命中，missing 是白名单里写了、源码里已经没有的。 */
function compare(found: Hit[], allowed: typeof ALLOWED): { extra: Hit[]; missing: string[] } {
  const left = new Map(allowed.map((item) => [`${item.file} ${item.owner}`, [...item.texts]]));
  const extra = found.filter((hit) => {
    const texts = left.get(`${hit.file} ${hit.owner}`);
    const at = texts?.indexOf(hit.text) ?? -1;
    if (at < 0) return true;
    texts!.splice(at, 1);
    return false;
  });
  return { extra, missing: [...left].flatMap(([key, texts]) => texts.map((text) => `${key} ${JSON.stringify(text)}`)) };
}
const unallowed = (found: Hit[], allowed: typeof ALLOWED) => compare(found, allowed).extra;

describe("后端和本机程序不拼省略号（本人 11/18）", () => {
  const found = hits();

  it("界面上看得到的文字没有拼上去的「…」", () => {
    expect(unallowed(found, ALLOWED).map((hit) => `${hit.file}:${hit.line} ${hit.owner} ${JSON.stringify(hit.text)}`)).toEqual([]);
  });

  it("白名单按原文和处数认：放行的名字下面再多拼一处「…」也挂", () => {
    const extra = (owner: string, text: string): Hit => ({ file: "api/src/piConversationRuntime.ts", owner, line: 0, text });
    expect(unallowed([...found, extra("content", "…")], ALLOWED)).toHaveLength(1);
    expect(unallowed([...found, extra("excerpt", "…（新拼的）")], ALLOWED)).toHaveLength(1);
  });

  it("白名单里每一条都还在，并写了理由", () => {
    for (const item of ALLOWED) expect(item.reason.trim(), `${item.file} ${item.owner}`).not.toBe("");
    // 源码里已经不拼了的，从白名单里删掉。
    expect(compare(found, ALLOWED).missing).toEqual([]);
  });

  it("本机程序的开发测试页没有省略号", () => {
    const page = readFileSync(join(APPS, "local/src/http/devPage.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(page).not.toContain("…");
  });

  it("认得出拼上去的「…」，不误伤提示词正文", () => {
    expect(spliced("…")).toBe(true);
    expect(spliced("\n…")).toBe(true);
    expect(spliced("…（共 ")).toBe(true);
    expect(spliced("正在想…")).toBe(true);
    expect(spliced("| … |")).toBe(true);
    expect(spliced("不写「完成……」「推进……」这类空话")).toBe(false);
    expect(spliced("编号 N1、N2…，按先后排，和已有的个人记忆核对有没有重复")).toBe(false);
  });
});
