import { describe, expect, it } from "vitest";
import { mentionsBattlefield, plainCompanyNames } from "../src/companyNames.js";

const battlefields = [
  { id: "aidc", code: "AIDC", name: "AIDC" },
  { id: "tk", code: "TK", name: "词元云集" },
  { id: "fdd", code: "FDD", name: "房懂懂" },
];

describe("company names", () => {
  it("replaces internal battlefield codes with Chinese company names in titles", () => {
    expect(plainCompanyNames("TK是否强化业务系统接入能力？", battlefields)).toBe("词元云集是否强化业务系统接入能力？");
    expect(plainCompanyNames("AIDC是否调整项目准入标准？", battlefields)).toBe("AIDC 是否调整项目准入标准？");
    expect(plainCompanyNames("FDD 与 tk 的内部结算价怎么定", battlefields)).toBe("房懂懂与词元云集的内部结算价怎么定");
    // TKOS、TokenOps 不是公司代号
    expect(plainCompanyNames("TKOS 与TokenOps分线验收", battlefields)).toBe("TKOS 与 TokenOps 分线验收");
  });

  it("matches English codes as whole words only", () => {
    expect(mentionsBattlefield("TK 9 月复盘", battlefields[1])).toBe(true);
    expect(mentionsBattlefield("TKOS 方法说明", battlefields[1])).toBe(false);
    expect(mentionsBattlefield("【词元云集】复盘", battlefields[1])).toBe(true);
  });
});
