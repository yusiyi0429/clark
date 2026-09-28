import { describe, expect, it } from "vitest";
import { connectCommands, connectionGuide, syncCommand } from "./connectionGuide";

describe("连接说明文件", () => {
  it("Codex：环境变量存令牌再添加，含验证、用法、每周同步和删文件提醒", () => {
    const text = connectionGuide({ client: "codex", endpoint: "https://t.example/mcp/me", token: "tsm_x", expires: "不过期" });
    expect(text).toContain("# 把 Codex 连到天枢");
    expect(text).toContain('SetEnvironmentVariable("TIANSHU_TOKEN", "tsm_x", "User")');
    expect(text).toContain("codex mcp add tianshu --url https://t.example/mcp/me --bearer-token-env-var TIANSHU_TOKEN");
    expect(text).toContain("list_my_items");
    expect(text).toContain("每周五 18:00");
    expect(text).toContain("提醒用户删掉这个文件");
  });
  it("Claude Code：user 作用域，换目录也能用", () => {
    const text = connectionGuide({ client: "claude", endpoint: "https://t.example/mcp/me", token: "tsm_y", expires: "10/28 10:00" });
    expect(text).toContain('claude mcp add --transport http --scope user tianshu https://t.example/mcp/me --header "Authorization: Bearer tsm_y"');
    expect(connectCommands("claude", "e", "k")[0].value).toContain("--scope user");
    expect(syncCommand("claude")).toContain("--allowedTools");
  });
});
