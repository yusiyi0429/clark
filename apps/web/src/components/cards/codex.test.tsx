import { describe, expect, it } from "vitest";
import { createMockRunner } from "@/lib/local/mock";
import { modelForTier } from "@/lib/team/roles";
import { effortText, profileModel, profileSource } from "@/lib/local/runModel";
import { AGENT_PERMISSION_MODES } from "@/lib/local/permissionModes";
import { agentRow } from "@/components/home/pages/connectionRows";
import { CROSS_AGENT_SWITCH, sessionModels } from "./SessionTranscript";

const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 300 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };

describe("子会话能用 Codex（17.2 第 38 条，D 契约 b28c1f12）", () => {
  it("连接页 Codex 没登录给「连接」，走本机登录（等浏览器时写「等浏览器登录」）；登好了模型目录里多出 Codex 一组，只读，写「GPT-6.1-Sol · Codex 订阅」", async () => {
    const runner = createMockRunner({ stepMs: 2 });
    const codex = async () => (await runner.status()).agents.find((agent) => agent.kind === "codex")!;
    expect(agentRow(await codex(), Date.now())).toMatchObject({ state: "disconnected", action: "login" });
    expect((await runner.listModels()).some((model) => model.agent === "codex")).toBe(false);
    await runner.login("codex");
    expect(agentRow(await codex(), Date.now())).toMatchObject({ sub: "等浏览器登录", action: null });
    await until(async () => (await codex()).loggedIn);
    const catalog = (await runner.listModels()).filter((model) => model.agent === "codex");
    expect(catalog.map((model) => [model.id, profileModel(model), profileSource(model), model.catalog])).toEqual([
      ["codex-gpt-6_1-sol", "GPT-6.1-Sol", "Codex 订阅", true], ["codex-gpt-5_5", "GPT-5.5", "Codex 订阅", true]]);
    // 思考程度照每个模型自己的几档，gpt-6.1-sol 多一档 ultra（「极限」）。
    expect(catalog[0]!.efforts!.map(effortText)).toEqual(["低", "中", "高", "超高", "最高", "极限"]);
    expect(AGENT_PERMISSION_MODES.codex).not.toContain("plan");
  });

  it("「自动」只在 Claude Code 里挑（Codex 要自己选、规划员只能用 Claude Code）；规划员选 Codex 本机回 400", async () => {
    const runner = createMockRunner({ stepMs: 2, codex: "logged_in" });
    const models = await runner.listModels();
    expect(modelForTier(models, "light")?.agent).toBe("claude-code");
    expect(modelForTier(models.filter((model) => model.agent === "codex"), "strong")).toBeNull();
    await expect(runner.createSession({ subject: { kind: "plan", taskId: "t1" }, title: "拆卡", modelProfileId: "codex-gpt-6_1-sol", firstMessage: "拆" })).rejects.toMatchObject({ status: 400 });
  });

  it("Codex 子会话换模型、思考程度：在跑这一轮时 after_turn，没在跑 now；子会话下面的菜单两组都列，另一个执行方的先灰着", async () => {
    const runner = createMockRunner({ stepMs: 5, codex: "logged_in" });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\work\tianshu", modelProfileId: "codex-gpt-6_1-sol", firstMessage: "交代", effort: "ultra" });
    expect(session).toMatchObject({ agent: "codex", effort: "ultra" });
    const changed = await runner.setSessionModel(session.id, { effort: "high" });
    expect(changed.applied).toBe("after_turn");
    expect(changed.session.pendingModel?.effort).toBe("high");
    const models = await runner.listModels();
    const menu = sessionModels(runner, models, changed.session, () => undefined, () => undefined)!;
    expect(new Set(menu.list.map((model) => model.agent))).toEqual(new Set(["claude-code", "codex"]));
    expect(CROSS_AGENT_SWITCH).toBe(false);
    expect(menu.disabled).toEqual(models.filter((model) => model.agent === "claude-code").map((model) => model.id));
    expect(menu.efforts).toContain("ultra");
  });
});
