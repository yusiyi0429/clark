/**
 * 座位这几个纯函数。
 *
 * 值得单测的只有一条性质：**`seatFrom` 永远回一个合法座位。** 它的入参来自 cookie
 * 和 POST body 两个都不可信的地方，而一旦让一个野值漏过去，`landingFor` 会拿它去拼
 * 跳转地址 —— 那一下在屏幕上的样子是「输完口令白屏」，查起来极慢，因为口令那一步
 * 明明成功了。
 */
import { describe, expect, it } from "vitest";

import { landingFor, seatFrom } from "./seat";

describe("seatFrom", () => {
  it("认得出两个座位", () => {
    expect(seatFrom("ceo")).toBe("ceo");
    expect(seatFrom("sec")).toBe("sec");
  });

  it("没有值就落一号位 —— 口令本来就是他那把", () => {
    expect(seatFrom(undefined)).toBe("ceo");
    expect(seatFrom(null)).toBe("ceo");
    expect(seatFrom("")).toBe("ceo");
  });

  it("野值一律收敛成一号位，不许原样漏过去", () => {
    expect(seatFrom("SEC")).toBe("ceo");
    expect(seatFrom(" sec ")).toBe("ceo");
    expect(seatFrom("/sec")).toBe("ceo");
    expect(seatFrom("dri")).toBe("ceo");
    expect(seatFrom(42)).toBe("ceo");
    expect(seatFrom({ seat: "sec" })).toBe("ceo");
  });
});

describe("landingFor", () => {
  it("两个座位各自落在自己那一侧", () => {
    expect(landingFor("ceo")).toBe("/");
    expect(landingFor("sec")).toBe("/sec");
  });
});
