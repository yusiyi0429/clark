import { Type } from "@sinclair/typebox";
import { plainKnowledgeText } from "../companyMemory.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** 导入写在每节开头的登记段：只有「来源：…」和「资料时间：…」两行。 */
const SOURCE_HEADER_RE = /^来源：[^\n]*\n资料时间：([^\n]+)$/;
/** 节标题后面的资料版本括注，如「（业务视角 v1.0 A4）」：一号位看不懂，面板上不显示。 */
export function plainSectionTitle(title: string): string {
  return title.replace(/\s*[（(][^（）()]*(?:业务视角|v\d+\.\d+)[^（）()]*[）)]\s*$/u, "").trim() || title;
}

const query = Type.Object({ ref: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false });

/**
 * 依据面板直接看企业知识原文（巡检 P0-2）：不绕 Agent，毫秒级返回。
 * ref 用预审 / 回答里的引用写法：`memory:<文件>.md#s<章节号>`；不带 #s 时返回这份文件的全部章节。
 * 企业知识对登录的人只读（Agent 本来就能读），所以只要求登录。
 */
export function registerKnowledgeRoutes(app: AppInstance, ctx: RouteContext): void {
  const { companyMemory, requirePerson, fail } = ctx;
  app.get("/api/knowledge/source", { preHandler: requirePerson, schema: { querystring: query } }, async (req, reply) => {
    const match = /^(?:memory:)?([^#\s/\\]+?\.md)(?:#s(\d+))?$/.exec(req.query.ref.trim());
    if (!match) return fail(reply, 400, "INVALID_KNOWLEDGE_REF", "企业知识引用格式不对");
    const [, file, section] = match;
    const sections = companyMemory.listSections().filter((item) => item.id.startsWith(`${file}#s`)
      && (!section || item.id === `${file}#s${section}`));
    if (!sections.length) return fail(reply, 404, "KNOWLEDGE_NOT_FOUND", "企业知识里没有找到这一节，可能已改版");
    return {
      ref: req.query.ref,
      file,
      sections: sections.map((item) => {
        const { passages } = companyMemory.getPassages(item.id, undefined, 200);
        // 导入时每节开头写了一段「来源：…／资料时间：…」：那是给 Agent 的登记信息，不是原文。
        // 面板上不显示这一段；「更新于」用资料时间，而不是场次开出来、文件落盘的时间。
        const header = passages.length ? SOURCE_HEADER_RE.exec(passages[0].text.trim()) : null;
        const body = header ? passages.slice(1) : passages;
        const asOf = header ? Date.parse(header[1].trim()) : Number.NaN;
        return { id: item.id, title: plainSectionTitle(item.title),
          updatedAt: Number.isFinite(asOf) ? new Date(asOf).toISOString() : item.updatedAt,
          passages: body.map((passage) => ({ id: passage.id, text: plainKnowledgeText(passage.text) })) };
      }),
    };
  });
}
