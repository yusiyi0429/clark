/**
 * Commitment 的状态机。**纯函数，不碰 store、不读时钟** —— 时间由调用方传进来，
 * 于是这些用例里的每一条时间线都是确定的。
 */
import { describe, expect, it } from "vitest";

import {
  adjudicate,
  assertWritable,
  convergenceRounds,
  disagreementNote,
  makeEffective,
  submitDraft,
} from "./commitment";
import type { Commitment } from "./types";

const drafted = (): Commitment => ({
  id: "D-04:PRD-2026-09",
  domainId: "D-04",
  periodId: "PRD-2026-09",
  version: 1,
  status: "drafted",
  northStar: "首批 Agents 进入两个真实场景的日常使用",
  items: [
    { id: "i1", proposed: "A4 深研上线", verdict: "accept", evidence: [], milestone: {}, tier: "acceptance" },
    { id: "i2", proposed: "A5 判断生成", verdict: "accept", evidence: [], milestone: {}, tier: "required" },
  ],
  assumptions: [],
  preconditions: [],
  questions: [],
  revisions: [],
});

const at1 = "2026-08-28T10:00:00+08:00";
const at2 = "2026-08-29T10:00:00+08:00";
const at3 = "2026-08-30T10:00:00+08:00";

describe("状态机", () => {
  it("drafted → submitted，版本还是 1（第一次提交不算修订）", () => {
    const c = submitDraft(drafted(), { actor: "产品负责人", at: at1, note: "第一轮" });
    expect(c.status).toBe("submitted");
    expect(c.version).toBe(1);
    expect(c.revisions).toEqual([{ version: 1, at: at1, actor: "产品负责人", note: "第一轮" }]);
    expect(convergenceRounds(c)).toBe(1);
  });

  it("submitted → adjudicated：裁决落在条目上，带时间和人", () => {
    const c = adjudicate(
      submitDraft(drafted(), { actor: "产品负责人", at: at1, note: "" }),
      { i1: { verdict: "endorse", note: "" }, i2: { verdict: "revise", note: "证据换成留存" } },
      { actor: "刘明华", at: at2 }
    );
    expect(c.status).toBe("adjudicated");
    expect(c.items[1].ruling).toEqual({
      verdict: "revise",
      note: "证据换成留存",
      at: at2,
      by: "刘明华",
    });
  });

  it("adjudicated → submitted：版本 +1，这就是「一轮」", () => {
    let c = submitDraft(drafted(), { actor: "产品负责人", at: at1, note: "" });
    c = adjudicate(c, { i1: { verdict: "endorse", note: "" } }, { actor: "刘明华", at: at2 });
    c = submitDraft(c, { actor: "产品负责人", at: at3, note: "按裁决改了 i2" });
    expect(c.status).toBe("submitted");
    expect(c.version).toBe(2);
    expect(convergenceRounds(c)).toBe(2);
  });

  it("submitted → effective，之后一切写入都拒", () => {
    let c = submitDraft(drafted(), { actor: "产品负责人", at: at1, note: "" });
    c = makeEffective(c, { actor: "刘明华", at: at2 });
    expect(c.status).toBe("effective");
    expect(() => assertWritable(c)).toThrow("已经生效");
    expect(() => submitDraft(c, { actor: "产品负责人", at: at3, note: "再改一下" })).toThrow("已经生效");
    expect(() => adjudicate(c, {}, { actor: "刘明华", at: at3 })).toThrow("已经生效");
  });

  it("非法的边一条都不放过", () => {
    const d = drafted();
    // 还没提交就裁决
    expect(() => adjudicate(d, {}, { actor: "刘明华", at: at1 })).toThrow("还没有回传");
    // 还没提交就签生效
    expect(() => makeEffective(d, { actor: "刘明华", at: at1 })).toThrow("还没有回传");
    // 提交了但还没裁完就再提交
    const s = submitDraft(d, { actor: "产品负责人", at: at1, note: "" });
    expect(() => submitDraft(s, { actor: "产品负责人", at: at2, note: "" })).toThrow("已经交出去了");
  });

  it("裁决里塞了不存在的条目 id，直接拒 —— 不静默忽略", () => {
    const s = submitDraft(drafted(), { actor: "产品负责人", at: at1, note: "" });
    expect(() => adjudicate(s, { nope: { verdict: "endorse", note: "" } }, { actor: "刘明华", at: at2 })).toThrow(
      "nope"
    );
  });
});

describe("disagreementNote", () => {
  it("修改超过两条给一句话", () => {
    const c = drafted();
    c.items = ["a", "b", "c"].map((id) => ({
      id,
      proposed: id,
      verdict: "modify" as const,
      reason: "口径不同",
      evidence: [],
      milestone: {},
      tier: "acceptance" as const,
    }));
    expect(disagreementNote(c)).toContain("结构性");
  });

  it("两条以内不出这句话", () => {
    const c = drafted();
    c.items[0].verdict = "modify";
    c.items[0].reason = "口径不同";
    expect(disagreementNote(c)).toBeNull();
  });

  it("这句话不拦提交 —— 它是经验不是校验规则", () => {
    const c = drafted();
    c.items = c.items.map((i) => ({ ...i, verdict: "modify" as const, reason: "都要改" }));
    c.items.push({
      id: "i3",
      proposed: "第三条",
      verdict: "modify",
      reason: "也要改",
      evidence: [],
      milestone: {},
      tier: "required",
    });
    expect(disagreementNote(c)).not.toBeNull();
    expect(() => submitDraft(c, { actor: "产品负责人", at: at1, note: "" })).not.toThrow();
  });
});

describe("非 accept 必须给理由", () => {
  it("modify 没写理由就拒", () => {
    const c = drafted();
    c.items[0].verdict = "rewrite";
    expect(() => submitDraft(c, { actor: "产品负责人", at: at1, note: "" })).toThrow("理由");
  });
});
