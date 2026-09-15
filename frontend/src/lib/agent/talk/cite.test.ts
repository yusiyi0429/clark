import { describe, expect, it } from "vitest";

import { citedCodes, unknownCodes } from "./cite";

describe("短码引用的白名单", () => {
  it("抠得出图谱短码，且不把 E 号段算进来", () => {
    const got = citedCodes("按 01-J2 和 ISS-D6，另见 [E3]");
    expect(got).toContain("01-J2");
    expect(got).toContain("ISS-D6");
    expect(got).not.toContain("E3");
  });

  it("引了这一轮没载入过的号，报出来", () => {
    // 一个编造的短码读起来比没有引用更可信 —— 这正是要机检的原因。
    expect(unknownCodes("依据 01-J9", ["01-J2", "ISS-D6"])).toEqual(["01-J9"]);
  });

  it("大小写不敏感 —— 同一条别报成编的", () => {
    expect(unknownCodes("依据 iss-d6", ["ISS-D6"])).toEqual([]);
  });

  it("这一轮压根没载入任何编号时一律不报", () => {
    // 图挂了或者纯外部那一档，每个短码都会被判成编的 —— 一份全是误报的清单等于没有清单。
    expect(unknownCodes("依据 01-J2", [])).toEqual([]);
  });
});
