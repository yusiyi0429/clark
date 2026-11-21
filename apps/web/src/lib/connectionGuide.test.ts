import { describe, expect, it } from "vitest";
import { connectCommands, connectionGuide, SYNC_INSTRUCTION } from "./connectionGuide";

describe("连接说明文件", () => {
  it("三种工具的说明都不含令牌，放令牌的地方写占位，请本人自己粘贴", () => {
    for (const client of ["codex", "claude", "other"] as const) {
      const text = connectionGuide({ role: "member", client, endpoint: "https://t.example/mcp/me", expires: "30 天", token: "tsm_testtoken123" } as Parameters<typeof connectionGuide>[0]);
      expect(text, client).not.toContain("tsm_testtoken123");
      expect(text, client).not.toMatch(/tsm_/);
      expect(text, client).toContain("<你的天枢令牌>");
      expect(text, client).toContain("这一处请本人自己粘贴令牌，Agent 不要读取或保存令牌");
      expect(text, client).not.toContain("文件里有用户的个人令牌");
    }
  });
  it("三种工具、两种角色的说明都要求配置写在用户级，不进项目仓库", () => {
    for (const role of ["member", "ceo"] as const) for (const client of ["codex", "claude", "other"] as const) {
      const text = connectionGuide({ role, client, endpoint: "https://t.example/mcp/me", expires: "30 天" });
      expect(text, `${role}/${client}`).toContain("配置写在用户级，不要写进项目仓库里的文件");
    }
  });
  it("Codex：令牌与工具放行写进 config.toml，不靠环境变量；含验证、用法、「同步本周进展」和删文件提醒，不再设定时同步", () => {
    const text = connectionGuide({ role: "member", client: "codex", endpoint: "https://t.example/mcp/me", expires: "不过期" });
    expect(text).toContain("# 把 Codex 连到天枢");
    expect(text).toContain("[mcp_servers.tianshu]");
    expect(text).toContain('url = "https://t.example/mcp/me"');
    expect(text).toContain('http_headers = { Authorization = "Bearer <你的天枢令牌>" }');
    expect(text).toContain('default_tools_approval_mode = "approve"');
    expect(text).not.toContain("TIANSHU_TOKEN");
    expect(connectCommands("codex", "https://t.example/mcp/me", "tsm_x")[0].value).toContain("http_headers");
    expect(text).toContain("list_my_items");
    expect(text).toContain("只在用户明确要求时才往天枢里写");
    expect(text).not.toContain("不用等用户开口");
    // 「同步本周进展」是本人开口要的，照旧；10/30 起不再让 Agent 建每周五的定时同步。
    expect(text).toContain(`用户说「同步本周进展」时，照这段做：${SYNC_INSTRUCTION}`);
    // 同步只写进展：天枢里还没有的工作列给本人，不替他建事项，也没有 ◆ 粒度规定。
    expect(SYNC_INSTRUCTION).toContain("不要新建事项");
    expect(SYNC_INSTRUCTION).not.toContain("create_item");
    expect(SYNC_INSTRUCTION).not.toContain("◆");
    expect(text).not.toContain("第三步");
    expect(text).not.toContain("每周五");
    expect(text).not.toContain("定时");
    expect(text).not.toContain("无人值守");
    expect(text).not.toContain("codex exec");
    expect(text).not.toContain("LaunchAgent");
    expect(text).toContain("申请在沙箱外执行");
    expect(text).toContain("提醒用户删掉这个文件");
  });
  it("Claude Code：user 作用域，换目录也能用", () => {
    const text = connectionGuide({ role: "member", client: "claude", endpoint: "https://t.example/mcp/me", expires: "10/28 10:00" });
    expect(text).toContain('claude mcp add --transport http --scope user tianshu https://t.example/mcp/me --header "Authorization: Bearer <你的天枢令牌>"');
    expect(text).not.toContain("第三步");
    expect(connectCommands("claude", "e", "k")[0].value).toContain("--scope user");
    expect(text).toContain("同步本周进展");
    expect(text).not.toContain("claude -p");
  });
  it("其他工具：通用的远程 MCP 步骤，配置写在用户级，不给 Codex/Claude 专用命令", () => {
    const text = connectionGuide({ role: "member", client: "other", endpoint: "https://t.example/mcp/me", expires: "不过期" });
    expect(text).toContain("# 把 AI 工具 连到天枢");
    expect(text).toContain("`Authorization: Bearer <你的天枢令牌>`");
    expect(text).toContain("OpenCode");
    expect(text).not.toContain("codex mcp add");
    expect(text).toContain("同步本周进展");
    expect(text).not.toContain("定时");
    expect(connectCommands("other", "https://t.example/mcp/me", "tsm_z").map((row) => row.value)).toEqual(["tianshu", "https://t.example/mcp/me", "Authorization: Bearer tsm_z"]);
  });
  it("CEO：验证待办、常用只读问法和回天枢处理动作，没有同步说明", () => {
    const text = connectionGuide({ role: "ceo", client: "codex", endpoint: "https://t.example/mcp/me", expires: "不过期" });
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
