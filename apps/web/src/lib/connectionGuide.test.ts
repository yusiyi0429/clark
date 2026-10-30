import { describe, expect, it } from "vitest";
import { connectCommands, connectionGuide, syncCommand } from "./connectionGuide";

describe("连接说明文件", () => {
  it("Codex：令牌与工具放行写进 config.toml，不靠环境变量；含验证、用法、每周同步和删文件提醒", () => {
    const text = connectionGuide({ role: "member", client: "codex", endpoint: "https://t.example/mcp/me", token: "tsm_x", expires: "不过期", weeklySync: true });
    expect(text).toContain("# 把 Codex 连到天枢");
    expect(text).toContain("[mcp_servers.tianshu]");
    expect(text).toContain('url = "https://t.example/mcp/me"');
    expect(text).toContain('http_headers = { Authorization = "Bearer tsm_x" }');
    expect(text).toContain('default_tools_approval_mode = "approve"');
    expect(text).not.toContain("TIANSHU_TOKEN");
    expect(connectCommands("codex", "https://t.example/mcp/me", "tsm_x")[0].value).toContain("http_headers");
    expect(text).toContain("list_my_items");
    expect(text).toContain("只在用户明确要求时才往天枢里写");
    expect(text).not.toContain("不用等用户开口");
    expect(text).toContain("第三步：设好每周五自动同步");
    expect(text).toContain("codex exec --skip-git-repo-check");
    expect(text).toContain("LaunchAgent");
    expect(text).toContain("申请在沙箱外执行");
    expect(text).toContain("提醒用户删掉这个文件");
  });
  it("Claude Code：user 作用域，换目录也能用", () => {
    const text = connectionGuide({ role: "member", client: "claude", endpoint: "https://t.example/mcp/me", token: "tsm_y", expires: "10/28 10:00", weeklySync: false });
    expect(text).toContain('claude mcp add --transport http --scope user tianshu https://t.example/mcp/me --header "Authorization: Bearer tsm_y"');
    expect(text).not.toContain("第三步");
    expect(connectCommands("claude", "e", "k")[0].value).toContain("--scope user");
    expect(syncCommand("claude")).toContain("--allowedTools");
  });
  it("其他工具：通用的远程 MCP 步骤，配置写在用户级，不给 Codex/Claude 专用命令", () => {
    const text = connectionGuide({ role: "member", client: "other", endpoint: "https://t.example/mcp/me", token: "tsm_z", expires: "不过期", weeklySync: true });
    expect(text).toContain("# 把 AI 工具 连到天枢");
    expect(text).toContain("`Authorization: Bearer tsm_z`");
    expect(text).toContain("OpenCode");
    expect(text).not.toContain("codex mcp add");
    expect(connectCommands("other", "https://t.example/mcp/me", "tsm_z").map((row) => row.value)).toEqual(["tianshu", "https://t.example/mcp/me", "Authorization: Bearer tsm_z"]);
  });
  it("CEO：验证待办、常用只读问法和回天枢处理动作，没有同步说明", () => {
    const text = connectionGuide({ role: "ceo", client: "codex", endpoint: "https://t.example/mcp/me", token: "tsm_ceo", expires: "不过期", weeklySync: true });
    expect(text).toContain("[mcp_servers.tianshu]");
    expect(text).toContain("`list_pending`");
    expect(text).toContain("`get_issue`");
    expect(text).toContain("`company_progress`");
    expect(text).toContain("`get_meeting`");
    expect(text).toContain("`get_mission_card`");
    expect(text).toContain("拼成完整链接给用户");
    expect(text).toContain("/issues/<id>");
    expect(text).not.toContain("每周五自动同步");
    expect(text).not.toContain("append_progress");
  });
});
