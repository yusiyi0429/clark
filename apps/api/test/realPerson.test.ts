import { describe, expect, it } from "vitest";
import { isRealPerson } from "../src/people.js";

describe("选人名单只放真人（巡检 P2-23）", () => {
  it("「会议纪要」这类记录账号不是人", () => {
    expect(isRealPerson({ personId: "minutes-record", displayName: "会议纪要" })).toBe(false);
    expect(isRealPerson({ personId: "x-1", displayName: "会议纪要" })).toBe(false);
    expect(isRealPerson({ personId: "record", displayName: "记录" })).toBe(false);
    expect(isRealPerson({ personId: "wang-li", displayName: "王丽" })).toBe(true);
    expect(isRealPerson({ personId: "ceo", displayName: "一号位" })).toBe(true);
  });
});
