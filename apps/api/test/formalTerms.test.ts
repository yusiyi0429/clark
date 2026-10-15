import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMAL_TERM_TABLE, formalTerms, formalTermsDeep } from "../src/formalTerms.js";
import { PLAIN_TERMS_STYLE } from "../src/promptStyle.js";

describe("交给模型的资料：内部写法换成正式中文叫法", () => {
  it("资料包和本体里常见的写法", () => {
    expect(formalTerms("9月 Company Outcome 达成状态：9月Company Outcome：未达成。")).toBe("9月公司结果达成状态：9月公司结果：未达成。");
    expect(formalTerms("词元云集 01 灯塔（2026 年 10 月既有本月目标）")).toBe("词元云集灯塔项目（2026 年 10 月既有本月目标）");
    expect(formalTerms("推动01灯塔项目正式部署")).toBe("推动灯塔项目正式部署");
    expect(formalTerms("词元云集 02 TokenOps：TokenHub 首版")).toBe("词元云集 TokenOps 项目：TokenHub 首版");
    expect(formalTerms("词元云集 03 维信诺")).toBe("词元云集维信诺项目");
    expect(formalTerms("沿用现有 Company LTCO 原文")).toBe("沿用现有公司长期目标原文");
    expect(formalTerms("Company、Strategy、3 个单元、3 个 LTO、5 个 PO，共 13 个对象")).toBe("公司、战略、3 个单元、3 个长期目标、5 个本月目标，共 13 个对象");
    expect(formalTerms("公司 / Company：控股集团")).toBe("公司：控股集团");
    expect(formalTerms("正式授权与 Mission DRI 待核实")).toBe("正式授权与战役负责人待核实");
    expect(formalTerms("有门对象（Strategy、LongTermGoal、PeriodGoal）只建草稿")).toBe("有门对象（战略、长期目标、本月目标）只建草稿");
    expect(formalTerms("TKOS Mission 推进")).toBe("TKOS 战役推进");
  });

  it("不误伤：章节编号、相近缩写、时间、产品名、链接、引用标记、id@版本", () => {
    expect(formalTerms("A4-PO、TPO、POC、PORT")).toBe("A4-PO、TPO、POC、PORT");
    expect(formalTerms("2026-10-10 17:08 北京时间")).toBe("2026-10-10 17:08 北京时间");
    expect(formalTerms("TKOS 提供企业经营 Method＋Agents")).toBe("TKOS 提供企业经营 Method＋Agents");
    const cited = "[《词元云集 9 月复盘》第 2 版](cite:material:abc-01@v2#p3) memory:kd-goals#PO https://x.cn/Mission/01灯塔 po-oct@3";
    expect(formalTerms(cited)).toBe(cited);
    expect(formalTerms("2026 Q4 建议 PO")).toBe("本月目标（Q4）");
  });

  it("幂等，换一次和换两次一样", () => {
    const text = "词元云集 01 灯塔、9月 Company Outcome、3 个 LTO";
    expect(formalTerms(formalTerms(text))).toBe(formalTerms(text));
  });

  it("JSON 值：只换字符串值，id、引用、地址、出处类字段和对象的键原样保留", () => {
    const value = { objectId: "Mission-01", ref: "p1@1", cite: "meeting:m1", url: "https://x.cn/PO", poSourceRef: "本体：01 灯塔", title: "01 灯塔",
      companyOutcome: "9月 Company Outcome 未达成", items: [{ name: "Mission DRI", count: 3 }], ok: true };
    const copy = structuredClone(value);
    expect(formalTermsDeep(value)).toEqual({ ...copy, title: "灯塔项目", companyOutcome: "9月公司结果未达成", items: [{ name: "战役负责人", count: 3 }] });
    expect(value).toEqual(copy);
  });

  it("提示词的用语要求里有同一份对照", () => {
    expect(PLAIN_TERMS_STYLE).toContain("资料中的英文类型名、内部编号写成正式中文叫法");
    for (const [from, to] of [["Company Outcome", "公司结果"], ["01 灯塔", "灯塔项目"], ["Mission", "战役"], ["DRI", "负责人"]]) {
      expect(PLAIN_TERMS_STYLE).toContain(from);
      expect(PLAIN_TERMS_STYLE).toContain(to);
      expect(FORMAL_TERM_TABLE.some((item) => item.from === from && item.to === to)).toBe(true);
    }
  });

  it("对话运行时在企业知识、本体、看板总览、战役与议题清单和上下文包进模型前都换一遍；读材料、读业务对象不换（修改要按原文比对）", () => {
    const source = readFileSync(new URL("../src/piConversationRuntime.ts", import.meta.url), "utf8");
    for (const wired of ["formalTerms(plainKnowledgeText(item.text))", "JSON.stringify(formalTermsDeep(value))", "JSON.stringify(formalTermsDeep(overview))",
      "JSON.stringify(formalTermsDeep({ missions }))", "JSON.stringify(formalTermsDeep({ issues }))", "globalContext: formalTermsDeep(await scopedGlobal())"]) {
      expect(source).toContain(wired);
    }
    expect(source).toContain("currentObject: input.currentObject,");
  });
});
