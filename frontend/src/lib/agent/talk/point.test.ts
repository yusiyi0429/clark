// src/lib/agent/talk/point.test.ts
import { describe, expect, it } from "vitest";
import { applyProposal, checkEntry, checkProposal, isTrigger } from "./point";

const empty = { issueId: "ISS-1", thesis: "", statements: [], openQuestions: [], candidate: null };

/** 一份该过的提议。四条拒绝用例都由它派生 —— 只坏一处，别的保持合法。 */
const good = {
  thesis: "准入这条到底是硬门槛还是可谈的价格问题",
  statements: ["三家里有两家把准入写进了合同"],
  openQuestions: ["第三家的口径还没拿到"],
  candidate: {
    statement: "当前更支持把准入当硬门槛，但只在这三家这个范围内成立",
    basis: "E3 与 E7 两条合同原文都写了准入前置",
    boundary: "不主张这条对没进过集采的客户成立",
    reopenIf: "出现一家绕过准入直接交付成功的客户",
  },
};

describe("判断状态的迁移提议", () => {
  // 先钉住「什么样的提议该过」。没有这一条，一个无条件返回 ok:false 的实现
  // 能把下面所有拒绝用例全过掉 —— 那是这份测试唯一真正的漏洞。
  it("合法提议照收，四栏原样端回来", () => {
    const r = checkProposal(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.thesis).toBe(good.thesis);
      expect(r.value.candidate?.reopenIf).toBe(good.candidate.reopenIf);
    }
  });

  it("校验不过的提议一个字都不落库", () => {
    const r = checkProposal({ ...good, thesis: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.join("")).toContain("thesis");
  });

  it("候选判断缺依据就打回 —— basis 是他表态的前提", () => {
    const r = checkProposal({ ...good, candidate: { ...good.candidate, basis: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.join("")).toContain("basis");
  });

  it("模型提不出确认 —— 结构上想加确认栏的，整份拒", () => {
    for (const bad of [
      { ...good, confirmed: { at: "now" } },
      { ...good, state: "judged" },
      { ...good, candidate: { ...good.candidate, confirmed: true } },
    ]) expect(checkProposal(bad).ok).toBe(false);
  });

  it("模型提不出确认 —— 正文里自称已确认的，也整份拒", () => {
    const r = checkProposal({
      ...good,
      candidate: { ...good.candidate, statement: "准入是硬门槛这条已确认，公司据此执行" },
    });
    expect(r.ok).toBe(false);
  });

  it("只改一栏就只动一栏，别的原样", () => {
    const next = applyProposal({ ...empty, thesis: "旧争点", statements: ["S1"] }, { thesis: "新争点" });
    expect(next.thesis).toBe("新争点");
    expect(next.statements).toEqual(["S1"]);
  });

  it("重开条件写空话的候选被打回", () => {
    const r = checkProposal({ ...good, candidate: { ...good.candidate, reopenIf: "情况有变化时" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.join("")).toContain("reopenIf");
  });
});

describe("触发物识别与让步日志", () => {
  it("isTrigger 拒空串 —— 任何一条日志都得说清是什么促成的", () => {
    expect(isTrigger("")).toBe(false);
    expect(isTrigger("   ")).toBe(false);
    expect(isTrigger("E3 说算力翻倍")).toBe(true);
  });

  it("checkEntry 拒空 trigger —— 空串是唯一一条不分 kind 的硬要求", () => {
    const r = checkEntry({
      turn: 1,
      trigger: "   ",
      before: "旧判断",
      after: "新判断",
      kind: "concede",
      rationale: "理由",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.join("")).toContain("trigger");
  });
});
