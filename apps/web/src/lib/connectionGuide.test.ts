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
  it("其他工具：通用的远程 MCP 步骤，配置写在用户级，不给 Codex/Claude 专用命令", () => {
    const text = connectionGuide({ client: "other", endpoint: "https://t.example/mcp/me", token: "tsm_z", expires: "不过期" });
    expect(text).toContain("# 把 AI 工具 连到天枢");
    expect(text).toContain("`Authorization: Bearer tsm_z`");
    expect(text).toContain("OpenCode");
    expect(text).not.toContain("codex mcp add");
    expect(connectCommands("other", "https://t.example/mcp/me", "tsm_z").map((row) => row.value)).toEqual(["tianshu", "https://t.example/mcp/me", "Authorization: Bearer tsm_z"]);
  });
});
