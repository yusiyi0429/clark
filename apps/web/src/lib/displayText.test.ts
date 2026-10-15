import { describe, expect, it } from "vitest";
import { ceoTerms, ceoTermsDeep, cleanDisplayText, isPastDue, knowledgeName, materialTitle, shortSourceName, stripGoalNotes, stripInternalRefs, tableRowToSentence, uniqueSources } from "./displayText";

const LONG = "《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》A1 公司原则；飞书《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》（wiki Cv8twqUjmi0kwUkFJPvcObavnpd，docx QeXAdjeWNo92QGx7uxBctrPenQk，revision 12，2026-10-10 17:08 北京时间版）";

describe("出处短名", () => {
  it("只留文档名，ID、token、revision、URL 都不露", () => {
    expect(shortSourceName("《Company 词元云集（知识库页，「9月复盘」章节）》（https://tokenking.feishu.cn/wiki/E9DywZNqtidsBzkrcg6cRAAUn2e）")).toBe("《Company 词元云集》");
    const long = shortSourceName(LONG);
    expect(long).toBe("《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》");
    expect(long).not.toMatch(/wiki|docx|revision/);
    expect(shortSourceName("2026_09_月度复盘（妙记，2026-10-08 13:59–14:59，组织者刘人豪）（https://tokenking.feishu.cn/minutes/obcn，引用妙记 AI 总结）")).toBe("2026_09_月度复盘");
    expect(shortSourceName("虚构资料/10月第2周经营周报")).toBe("《10月第2周经营周报》");
    expect(shortSourceName("真实会议纪要：《20260712 词元云集_公司业务战略及产品部署讨论会议纪要》（https://x.cn/docx/P，docx 会议纪要）")).toBe("《20260712 词元云集_公司业务战略及产品部署讨论会议纪要》");
    expect(shortSourceName("manual")).toBe("手工录入");
    expect(shortSourceName("CEO 对话确认（2026-10-11 16:22（北京时间））")).toBe("对话中确认（2026-10-11 16:22）");
    expect(shortSourceName("一号位对话确认（2026-10-11 16:22（北京时间））")).toBe("对话中确认（2026-10-11 16:22）");
    expect(shortSourceName("一号位 对话确认")).toBe("对话中确认");
  });

  it("kd-* 换成中文名", () => {
    expect(knowledgeName("kd-demo-materials")).toBe("资料说明");
    expect(knowledgeName("kd-goals.md")).toBe("目标：长期目标、本月目标与候选战役");
    expect(knowledgeName("kd-unknown")).toBe("企业知识");
    expect(shortSourceName("memory:kd-goals#s1")).toBe("《目标：长期目标、本月目标与候选战役》");
  });

  it("同一出处合并成一条，原文留给 hover", () => {
    const merged = uniqueSources([LONG, LONG, "虚构资料/10月第2周经营周报"]);
    expect(merged.map((item) => item.name)).toEqual(["《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》", "《10月第2周经营周报》"]);
    expect(merged[0].full).toBe(LONG);
  });
});

describe("正文清洗", () => {
  it("去掉 @某人 与链接", () => {
    expect(cleanDisplayText("9 月复盘汇总总结 @梦怡")).toBe("9 月复盘汇总总结");
    expect(cleanDisplayText("客户侧部署滞后（https://tokenking.feishu.cn/wiki/E9DywZ）。")).toBe("客户侧部署滞后。");
  });

  it("Markdown 表格行改写成一句话", () => {
    expect(tableRowToSentence("| 战略表达 | 不再使用“上位战略”。 | 报告聚焦 |")).toBe("战略表达：不再使用“上位战略”；报告聚焦");
    expect(tableRowToSentence("|-|-|-|")).toBe("");
    const cleaned = cleanDisplayText("| **议题** | **确认结论** |\n|-|-|\n| 战略表达 | 不再使用“上位战略” |");
    expect(cleaned).not.toContain("|");
    expect(cleaned).toContain("战略表达：不再使用“上位战略”");
  });
});

describe("内部引用写法", () => {
  it("预审证据边界不露出 meeting: / material: 写法和输入字段名", () => {
    const basis = "本轮使用会议邀请 meeting:78a5d698-98ee-45d0-bb4e-c98417f2656a、两条 AI 建议候选议题、群材料 material:054db381-25c0-48ad-8bba-af65e5fb26bd@v1（完整，未截断）及企业知识。decisionHistory 中没有仍有效的已确认决定。";
    const cleaned = stripInternalRefs(basis);
    expect(cleaned).toBe("本轮使用会议邀请、两条 AI 建议候选议题、群材料（完整，未截断）及企业知识。历史决定中没有仍有效的已确认决定。");
    expect(cleaned).not.toMatch(/meeting:|material:|decisionHistory/);
  });

  it("企业知识引用换成中文名，段落锚点一起去掉；普通英文不动", () => {
    expect(stripInternalRefs("见 memory:kd-goals#sec-1 与 material:abc@v2#p3")).toBe("见 《目标：长期目标、本月目标与候选战役》 与");
    expect(stripInternalRefs("Token: 200 万 TPM，TokenOps 毛利")).toBe("Token: 200 万 TPM，TokenOps 毛利");
    expect(cleanDisplayText("依据 issue:3db45f6f-7673 的研究")).toBe("依据 的研究");
  });
});

describe("截止日过期", () => {
  it("dueDate 或正文里的「时间：预计 2026 年 8 月初」早于今天算过期", () => {
    expect(isPastDue("2026-10-01", null, "2026-10-11")).toBe(true);
    expect(isPastDue("2026-10-11", null, "2026-10-11")).toBe(false);
    expect(isPastDue(null, "形成三个版本（时间：预计 2026 年 8 月初；完成标准：可运行）", "2026-10-11")).toBe(true);
    expect(isPastDue(null, "时间：2026 年 12 月底", "2026-10-11")).toBe(false);
    expect(isPastDue(null, "没有时间", "2026-10-11")).toBe(false);
  });
});

describe("一号位用语 ceoTerms", () => {
  it("LTO → 长期目标，PO → 本月目标，中文旁多余空格去掉", () => {
    expect(ceoTerms("AIDC 首项目 LTO 与 2026 Q4 PO 确认")).toBe("AIDC 首项目长期目标与本月目标（Q4）确认");
    expect(ceoTerms("AIDC 首项目的建议 LTO 与 2026 Q4 PO 是否定为正式目标？")).toBe("AIDC 首项目的建议长期目标与本月目标（Q4）是否定为正式目标？");
    expect(ceoTerms("LTO：到首项目交付期")).toBe("长期目标：到首项目交付期");
    expect(ceoTerms("词元云集 2026 年 10 月既有 PO")).toBe("词元云集 2026 年 10 月既有本月目标");
    expect(ceoTerms("LTO/PO 均为待确认建议")).toBe("长期目标/本月目标均为待确认建议");
  });
  it("带季度的目标只分长期目标 / 本月目标两类：Q4 PO、Q4 目标、2026 Q4 建议 PO 都写「本月目标（Q4）」，其它 PO 仍写「本月目标」", () => {
    expect(ceoTerms("房懂懂 Q4 PO")).toBe("房懂懂本月目标（Q4）");
    expect(ceoTerms("房懂懂 2026 Q4 目标")).toBe("房懂懂本月目标（Q4）");
    expect(ceoTerms("2026 年 Q4 建议 PO 确认")).toBe("本月目标（Q4）确认");
    expect(ceoTerms("LTO与Q4PO确认")).toBe("长期目标与本月目标（Q4）确认");
    expect(ceoTerms("HQ4 目标")).toBe("HQ4 目标");
    expect(ceoTerms("建议 PO：按上表")).toBe("建议本月目标：按上表");
    expect(ceoTerms("建议 LTO：到首项目")).toBe("建议长期目标：到首项目");
  });
  it("只换独立的缩写词，TPO、POC、PORT、章节编号不误伤", () => {
    for (const keep of ["TPO 方案", "POC 验证", "PORT 3000", "MPO", "LTOs", "A4-PO", "A4-LTO 词元云集", "po 与 lto", "PO2"]) expect(ceoTerms(keep)).toBe(keep);
    expect(ceoTerms("POC 通过后定本期 PO")).toBe("POC 通过后定本期本月目标");
  });
  it("去括注：整段〔…〕去掉，带 建议 / PO / 既有 / 承诺 / 长期目标 的全角（…）去掉", () => {
    expect(ceoTerms("到首项目交付期，完成复制。〔建议 LTO〕（非正式承诺）")).toBe("到首项目交付期，完成复制。");
    expect(ceoTerms("收益。〔建议LTO〕")).toBe("收益。");
    expect(ceoTerms("AIDC 首项目形成〔建议，非已批承诺〕")).toBe("AIDC 首项目形成");
    expect(ceoTerms("词元云集长期目标〔沿用词元云集现有长期目标〕")).toBe("词元云集长期目标");
    expect(ceoTerms("AIDC（2026 Q4 建议 PO）：首项目形成")).toBe("AIDC：首项目形成");
    expect(ceoTerms("词元云集（2026 年 10 月既有 PO）按期")).toBe("词元云集按期");
    expect(ceoTerms("增长目标（需要对外承诺的部分）")).toBe("增长目标");
    expect(ceoTerms("沿用（长期目标）")).toBe("沿用");
    expect(ceoTerms("长期目标〔建议〕：到首项目交付期")).toBe("长期目标：到首项目交付期");
  });
  it("别的括号和正文不误删：不带关键词的（…）、半角括号、POC 等", () => {
    for (const keep of ["收入（含税）三成", "交付周期（约 6 周）", "增长（Q4 前）", "毛利率(含税)", "验证（POC 通过后）", "TPO（试点）方案"]) expect(ceoTerms(keep)).toBe(keep);
    expect(stripGoalNotes(null)).toBe("");
    expect(stripGoalNotes("没有括注")).toBe("没有括注");
  });
  it("幂等、空值安全", () => {
    const once = ceoTerms("建议 LTO 与 Q4 PO");
    expect(ceoTerms(once)).toBe(once);
    expect(ceoTerms(null)).toBe("");
    expect(ceoTerms(undefined)).toBe("");
    expect(ceoTerms("")).toBe("");
  });
  it("ceoTermsDeep 递归处理字符串，没有缩写时返回同一引用", () => {
    const clean = { a: ["x", { b: "无缩写" }] };
    expect(ceoTermsDeep(clean)).toBe(clean);
    expect(ceoTermsDeep({ title: "LTO 审视", list: [{ t: "Q4 PO" }, 3, null], id: "abc" })).toEqual({ title: "长期目标审视", list: [{ t: "本月目标（Q4）" }, 3, null], id: "abc" });
    expect(ceoTermsDeep({ goal: "完成复制〔建议〕", note: "按期（2026 年 10 月既有 PO）" })).toEqual({ goal: "完成复制", note: "按期" });
  });
});

describe("一号位用语 ceoTerms：本体原文里的 Demo 措辞", () => {
  it("长期目标成功标准不出现 Demo，按资料包构建时的同一组改写显示", () => {
    const text = "已有 LTO 包含 TKOS 持续经营和 TokenOps 商业闭环两项结果；正式量化阈值尚未提供，不能以 Demo 或产品接通替代真实客户使用与付费。";
    expect(ceoTerms(text)).toBe("已有长期目标包含 TKOS 持续经营和 TokenOps 商业闭环两项结果；正式量化阈值尚未提供，不能以产品试用或接通替代真实客户使用与付费。");
    expect(ceoTerms("本次 Demo 不展开")).toBe("本次不展开");
    expect(ceoTerms("首批 Demo 客户")).toBe("首批样板客户");
    expect(ceoTermsDeep({ success: "不能以 Demo 或产品接通替代" })).toEqual({ success: "不能以产品试用或接通替代" });
    expect(ceoTerms("DemoDay")).toBe("DemoDay");
  });
});

describe("材料名只显示原始标题", () => {
  it("去掉资料包文字层抽取件的内部后缀「（PDF 文字版）.md」「（Word 文字版）.md」", () => {
    expect(materialTitle("FireworksAI_国内对标分析_管理层讨论稿_V2（PDF 文字版）.md")).toBe("FireworksAI_国内对标分析_管理层讨论稿_V2");
    expect(materialTitle("无问芯穹与硅基流动对比研究（Word 文字版）.md")).toBe("无问芯穹与硅基流动对比研究");
    expect(materialTitle("研究报告 (PDF 文字版).md")).toBe("研究报告");
  });
  it("普通文件名原样返回（包括带小数点的标题）", () => {
    expect(materialTitle("季度复盘.pdf")).toBe("季度复盘.pdf");
    expect(materialTitle("方案 V2.0")).toBe("方案 V2.0");
  });
});
