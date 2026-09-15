/**
 * 预研 v3 的批判（2026-09-05）：对象是预研结论本身，不再是影响提案。
 * 真实样本是 ISS-224：一号位写「我们的第一个客户是维信诺」，模型判 invalid，理由是
 * 「当前上下文没有任何证据表明该公司已与维信诺接触」—— 机检必须把这一类拦在模型之前。
 */
import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import { criticize, machineChecks, type CriticSubject } from "./critic";
import type { TargetHit } from "./stages";

const target = { kind: "judgment" as const, id: "04-J1", text: "Sensor 出卡精度优先于召回" };
const hit: TargetHit = { target, match: "supports", why: "首访是第一印象", hops: null };

const fine: CriticSubject = {
  question: "首访维信诺这件事值不值得现在投入认知资源？",
  verdict: "值得现在投入：首客首访定的是 TKOS 外供版的验收口径，错过这次没有第二次。",
  take: "我判断值得。\n\n为什么是现在：8.6 代线在建，对方的注意力窗口就是这几个月。\n\n反问：这次接触是谁开的口？",
  status: "valid",
  statusReason: "",
  soWhat: "值得升级深研，先把首访要拿回来的三样东西定下来。",
  premises: [{ text: "维信诺是 TKOS 的第一个客户", quote: "我们的TKOS的第一个客户是维信诺" }],
};

function stub(reply: unknown, slot: "pro" | "alt" = "pro", onCall?: () => void): Harness {
  return {
    slot,
    async callMessages() {
      onCall?.();
      return { text: JSON.stringify(reply) };
    },
    note() {},
    substep() {},
  } as unknown as Harness;
}

describe("machineChecks", () => {
  it("干净的结论一条都不报", () => {
    expect(machineChecks({ doc: fine, hits: [hit], evidence: [] }).checks).toEqual([]);
  });

  it("ISS-224：判 invalid、理由是「上下文没有证据表明…」—— 报 premiseDenied", () => {
    const r = machineChecks({
      doc: {
        ...fine,
        status: "invalid",
        statusReason: "议题声称维信诺是第一个客户，但当前上下文没有任何证据表明该公司已与维信诺接触或维信诺表达过意向，议题基础不成立。",
        soWhat: "当前不值得升级深研，待有真实客户信号出现后再评估。",
      },
      hits: [hit],
      evidence: [],
    });
    expect(r.checks).toContain("premiseDenied");
  });

  it("判 invalid 的理由是议题本身的问题（量级、公开事实推翻）—— 不报", () => {
    const r = machineChecks({
      doc: { ...fine, status: "invalid", statusReason: "这件事的量级不到本期 Outcome 的门槛，公开披露的产线规划里也没有对应节点。", soWhat: "不值得升级。" },
      hits: [],
      evidence: [],
    });
    expect(r.checks).not.toContain("premiseDenied");
  });

  it("判了 invalid、结尾却说值得升级 —— 报 contradiction", () => {
    const r = machineChecks({
      doc: { ...fine, status: "invalid", statusReason: "议题本身自相矛盾。", soWhat: "值得升级深研。" },
      hits: [],
      evidence: [],
    });
    expect(r.checks).toContain("contradiction");
  });

  it("说得太满又没有数字或编号支撑 —— 报 overclaim（p1，只留痕）", () => {
    const r = machineChecks({ doc: { ...fine, verdict: "这件事必然改变公司命运，毫无疑问值得投入。" }, hits: [], evidence: [] });
    expect(r.checks).toContain("overclaim");
  });
});

describe("criticize", () => {
  it("机检报了 premiseDenied 就直接打回，一次模型都不叫（modelSlot 记 null）", async () => {
    let called = 0;
    const h = stub({ pass: true, why: [] }, "pro", () => (called += 1));
    const r = await criticize(h, {
      doc: { ...fine, status: "invalid", statusReason: "本体没有记录维信诺与公司的接触。", soWhat: "不值得。" },
      hits: [hit],
      evidence: [],
    });
    expect(r.pass).toBe(false);
    expect(r.modelSlot).toBeNull();
    expect(r.unavailable).toBeFalsy();
    expect(called).toBe(0);
  });

  it("机检过了才叫模型，主链 pro 时批判走 synth（首包快的那一家）", async () => {
    const h = stub({ pass: true, checks: [], why: ["前提用对了，结论和结尾一致"] });
    const r = await criticize(h, { doc: fine, hits: [hit], evidence: [] });
    expect(r.pass).toBe(true);
    expect(r.modelSlot).toBe("synth");
  });

  it("模型报的代号进 checks；不认识的代号丢掉", async () => {
    const h = stub({ pass: false, checks: ["targetMismatch", "nonsense"], why: ["04-J1 讲的是 Sensor 精度，和首访不是一回事"] });
    const r = await criticize(h, { doc: fine, hits: [hit], evidence: [] });
    expect(r.pass).toBe(false);
    expect(r.checks).toEqual(["targetMismatch"]);
  });

  it("模型返回的不是合法 JSON：unavailable，不是打回，也不是通过", async () => {
    const h = { slot: "pro", async callMessages() { return { text: "不是 JSON" }; }, note() {}, substep() {} } as unknown as Harness;
    const r = await criticize(h, { doc: fine, hits: [], evidence: [] });
    expect(r.pass).toBe(false);
    expect(r.unavailable).toBe(true);
  });

  it("模型调用抛了：unavailable 且原因留痕", async () => {
    const h = { slot: "pro", async callMessages() { throw new Error("网宿 502"); }, note() {}, substep() {} } as unknown as Harness;
    const r = await criticize(h, { doc: fine, hits: [], evidence: [] });
    expect(r.unavailable).toBe(true);
    expect(r.why.join("")).toContain("502");
  });
});
