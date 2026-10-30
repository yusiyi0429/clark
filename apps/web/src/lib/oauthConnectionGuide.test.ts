import { describe, expect, it } from "vitest";
import { oauthConnectionGuide } from "./connectionGuide";

describe("浏览器授权连接说明", () => {
  it("包含添加和登录两个步骤，旧配置升级移除会覆盖 OAuth 的请求头", () => {
    const codex = oauthConnectionGuide("member", "codex", "https://t.example/mcp/me");
    expect(codex).toContain("codex mcp add tianshu --url https://t.example/mcp/me");
    expect(codex).toContain("codex mcp login tianshu");
    expect(codex).toContain("移除旧的 Authorization 请求头");
    expect(codex).toContain("不要代替我确认授权");
    expect(codex).not.toContain("Bearer"); expect(codex).not.toContain("tsm_");
    const claude = oauthConnectionGuide("ceo", "claude", "https://t.example/mcp/me");
    expect(claude).toContain("--scope user"); expect(claude).toContain("/mcp"); expect(claude).toContain("list_pending");
    expect(claude).not.toContain("list_my_items");
  });
  it("天枢工具设为免确认，Agent 按用户要求建事项、写进展时不弹窗", () => {
    expect(oauthConnectionGuide("member", "codex", "https://t.example/mcp/me")).toContain('default_tools_approval_mode = "approve"');
    expect(oauthConnectionGuide("member", "claude", "https://t.example/mcp/me")).toContain('permissions.allow 里加 "mcp__tianshu"');
    expect(oauthConnectionGuide("member", "other", "https://t.example/mcp/me")).toContain("不用每次确认");
  });
});
