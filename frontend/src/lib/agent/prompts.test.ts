import { describe, expect, it } from "vitest";

import {
  assemble,
  cognitiveFor,
  defaultCognitive,
  expandSkills,
  PROMPT_SYSTEM,
  PromptKeyError,
  SkillNotFoundError,
} from "./prompts";

const A1A_KEYS = ["a1a.triage", "a1a.issue.update", "a1a.issue.new", "a1a.issue.external"];

describe("五段 prompt 装配", () => {
  it("四个 A1a 工程段都读得到，system 段是固定那一句", async () => {
    for (const key of A1A_KEYS) {
      const p = await assemble(key, { input: "信号原文：X", context: "【公司经营状态】Y" });
      expect(p.system).toBe(PROMPT_SYSTEM);
      expect(p.user).toContain("信号原文：X");
      expect(p.user).toContain("【公司经营状态】Y");
    }
  });

  it("key 不存在时报出 key 名，不回落到空模板", async () => {
    // 回落成空模板的话，模型自由作文，产出仍是一份 JSON —— 看不出 prompt 根本没装上。
    await expect(assemble("a1a.nope", {})).rejects.toThrow(PromptKeyError);
    await expect(assemble("a1a.nope", {})).rejects.toThrow("a1a.nope");
  });

  it("认知段没给、也没有默认文件时，来源记成 empty 并留下占位说明", async () => {
    // 六个 key 现在都有默认文件了，所以这条走一个不存在的 key 的取值路径 ——
    // 「没装上」必须仍然表现为 empty，而不是一个看着正常的 default。
    expect(await defaultCognitive("a1a.nope")).toBe("");
    const c = await cognitiveFor("a1a.nope");
    expect(c.source).toBe("empty");
    expect(c.text).toBe("");
  });

  it("六个 key 的认知段都读得到，技能正文进了 prompt，frontmatter 没进", async () => {
    for (const key of [...A1A_KEYS, "a3.pre-research", "a4.research"]) {
      const c = await cognitiveFor(key);
      expect(c.source, key).toBe("default");
      // 技能正文的标志：每份技能第一行都是带版本号的 H1。
      expect(c.text, key).toContain("Skill v");
      /*
       * frontmatter 是给方法部门登记用的，不是给模型的指令。认它靠 frontmatter 里
       * 那几个值本身（`status: Calibration Draft`、`owner:`），不靠 `status:` 这个
       * 子串 —— a3 的认知段正文里就要讲 `status` 这个字段该填什么。
       */
      expect(c.text, key).not.toContain("Calibration Draft");
      expect(c.text, key).not.toContain("owner:");
      expect(c.text.startsWith("---"), key).toBe(false);
      expect(c.text, key).not.toContain("{{SKILL:");
    }
  });

  it("A1a 四个 key 引的是同一份 S01 技能，不是各抄一份", async () => {
    const texts = await Promise.all(A1A_KEYS.map((k) => cognitiveFor(k).then((c) => c.text)));
    const marker = "Issue Framing Skill v";
    for (const t of texts) expect(t).toContain(marker);
  });

  it("技能文档不存在或名字不合法时抛错，不换成空串", async () => {
    // 换空串的话第 ③ 段只剩「这一次做哪一步」的引子，认知标准整段消失 ——
    // 而模型照样产出格式完整的结果。
    await expect(expandSkills("{{SKILL:m1a-s99-nope}}")).rejects.toThrow(SkillNotFoundError);
    await expect(expandSkills("{{SKILL:m1a-s99-nope}}")).rejects.toThrow("m1a-s99-nope");
    await expect(expandSkills("{{SKILL:../../etc/passwd}}")).rejects.toThrow(SkillNotFoundError);
  });

  it("运行时给了认知段就用它，并记下来源", async () => {
    const p = await assemble("a1a.triage", { input: "X", cognitive: "先问它在说什么" });
    expect(p.cognitiveSource).toBe("runtime");
    expect(p.user).toContain("先问它在说什么");
  });

  it("所有占位符都被换掉，不留花括号", async () => {
    const p = await assemble("a1a.issue.new", {});
    expect(p.user).not.toContain("{{");
    expect(p.user).toContain("（无）");
  });

  it("上下文里的 $& 这类替换符号照原样进 prompt", async () => {
    // String.replace 的第二个参数是字符串时，$& 会被当成「整个匹配」展开 ——
    // 图谱正文里真出现一次 $& 就会把 {{CONTEXT}} 这五个字符塞回去。所以必须用函数形式。
    const p = await assemble("a1a.triage", { context: "毛利率 $& 同比 $' 变化" });
    expect(p.user).toContain("毛利率 $& 同比 $' 变化");
  });

  it("chars 是 system 加 user 的总字数", async () => {
    const p = await assemble("a1a.issue.update", { input: "X" });
    expect(p.chars).toBe(p.system.length + p.user.length);
  });
});
