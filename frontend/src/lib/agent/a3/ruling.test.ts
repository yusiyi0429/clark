import { describe, expect, it } from "vitest";
import { rule, ruleAfterRepair, ruleUnrepaired } from "./ruling";
import type { CriticVerdict, TargetHit } from "./stages";

const hit: TargetHit = {
  target: { kind: "judgment", id: "04-J1", text: "Sensor 出卡精度优先于召回" },
  match: "supports",
  why: "首访是第一印象",
  hops: null,
};
const critic = (over: Partial<CriticVerdict>): CriticVerdict => ({ pass: true, checks: [], why: [], modelSlot: "synth", ...over });

describe("最终裁决（预研 v3）", () => {
  it("批判通过：结论照模型的，quality ok", () => {
    const r = rule({ status: "valid", statusReason: "", critic: critic({}), hits: [hit] });
    expect(r.status).toBe("valid");
    expect(r.quality.state).toBe("ok");
    expect(r.repairAsk).toBeNull();
    expect(r.hits).toHaveLength(1);
  });

  it("ISS-224：premiseDenied → 要修正，修正的话里写明前提规则；status 暂不动", () => {
    const r = rule({
      status: "invalid",
      statusReason: "上下文没有证据表明已与维信诺接触",
      critic: critic({ pass: false, checks: ["premiseDenied"], why: ["把一号位给定的前提当成了无依据"], modelSlot: null }),
      hits: [hit],
    });
    expect(r.repairAsk).toMatch(/给定的公司事实是前提/);
    expect(r.quality.state).toBe("needsCorrection");
    expect(r.status).toBe("invalid");
  });

  it("修正后机检干净 → corrected，status 用修正稿的", () => {
    const before = rule({
      status: "invalid",
      statusReason: "上下文没有记录",
      critic: critic({ pass: false, checks: ["premiseDenied"], why: ["前提被否定"], modelSlot: null }),
      hits: [hit],
    });
    const after = ruleAfterRepair({ status: "valid", statusReason: "", before, machine: { checks: [], why: [] } });
    expect(after.status).toBe("valid");
    expect(after.quality.state).toBe("corrected");
    expect(after.quality.notes.join("")).toContain("已按批判意见重写");
  });

  it("修正后仍是同一种错 → needsCorrection，status 置 null（不知道就不显示成「不成立」）", () => {
    const before = rule({
      status: "invalid",
      statusReason: "上下文没有记录",
      critic: critic({ pass: false, checks: ["premiseDenied"], why: ["前提被否定"], modelSlot: null }),
      hits: [hit],
    });
    const after = ruleAfterRepair({
      status: "invalid",
      statusReason: "本轮没查到接触记录",
      before,
      machine: { checks: ["premiseDenied"], why: ["仍在用材料状态否定前提"] },
    });
    expect(after.status).toBeNull();
    expect(after.quality.state).toBe("needsCorrection");
  });

  it("targetMismatch：撤掉靶点、议题照旧、记 corrected —— 不发修正", () => {
    const r = rule({
      status: "valid",
      statusReason: "",
      critic: critic({ pass: false, checks: ["targetMismatch"], why: ["04-J1 讲的是 Sensor 精度"] }),
      hits: [hit],
    });
    expect(r.hits).toEqual([]);
    expect(r.status).toBe("valid");
    expect(r.quality.state).toBe("corrected");
    expect(r.repairAsk).toBeNull();
  });

  it("overclaim / evidenceThin 只留痕，不改结论", () => {
    const r = rule({ status: "valid", statusReason: "", critic: critic({ pass: true, checks: ["overclaim"], why: ["说得太满"] }), hits: [] });
    expect(r.quality.state).toBe("ok");
    expect(r.quality.notes).toContain("说得太满");
  });

  it("批判没跑成 → criticUnavailable，结论照模型的，但不是通过", () => {
    const r = rule({ status: "valid", statusReason: "", critic: critic({ pass: false, unavailable: true, why: ["网宿 502"] }), hits: [hit] });
    expect(r.quality.state).toBe("criticUnavailable");
    expect(r.status).toBe("valid");
    expect(r.repairAsk).toBeNull();
  });

  it("没预算修正：needsCorrection 且原因留痕，status 置 null", () => {
    const before = rule({
      status: "invalid",
      statusReason: "上下文没有记录",
      critic: critic({ pass: false, checks: ["contradiction"], why: ["判了 invalid 结尾却说值得"], modelSlot: null }),
      hits: [],
    });
    const r = ruleUnrepaired(before, "只剩 5 秒");
    expect(r.status).toBeNull();
    expect(r.quality.notes.join("")).toContain("只剩 5 秒");
  });
});
