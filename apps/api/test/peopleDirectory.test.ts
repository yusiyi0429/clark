import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";

const seed = fileURLToPath(new URL("./fixtures/company-people.json", import.meta.url));

describe("独立人员目录", () => {
  it("无需公司认知文件即可提供稳定身份、角色和姓名检索，调用方不能修改目录", () => {
    const directory = loadPeopleDirectory({ companyPeopleSeed: seed });
    const member = directory.searchPeople("测试乙");
    expect(member).toMatchObject([{ personId: "person-fixture-002", displayName: "测试乙", roles: ["dri", "participant"] }]);
    member[0].roles.push("ceo");
    member[0].displayName = "changed";
    expect(directory.searchPeople("测试乙")).toMatchObject([{ personId: "person-fixture-002", displayName: "测试乙", roles: ["dri", "participant"] }]);
  });
});
