import { describe, expect, it } from "vitest";
import { ClaudeSetup } from "../src/agents/claudeSetup.js";

describe("Claude Code 的登录状态", () => {
  it("读 claude auth status 时带上 planTier", async () => {
    const calls: string[] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { code: 0, out: "2.1.327 (Claude Code)\n" };
      return { code: 0, out: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", planTier: "max_20x", loginExpiresAt: null }) };
    };
    // 可执行文件在不在按 existsSync 查：拿 node 自己当那个文件，真正跑的是上面的 run。
    const status = await new ClaudeSetup(process.execPath, run).status(true);
    expect(calls).toEqual(["--version", "auth status --json"]);
    expect(status).toMatchObject({ installed: true, version: "2.1.327", loggedIn: true, subscriptionType: "max", planTier: "max_20x" });

    // 老版本没有 planTier：不带这个字段。
    const old = await new ClaudeSetup(process.execPath, async (_cmd, args) => args[0] === "--version"
      ? { code: 0, out: "2.1.300\n" } : { code: 0, out: JSON.stringify({ loggedIn: true, subscriptionType: "pro" }) }).status(true);
    expect(old.subscriptionType).toBe("pro");
    expect(old).not.toHaveProperty("planTier");
  });
});
