import { describe, expect, it } from "vitest";
import { createMockRunner } from "@/lib/local/mock";
import { modelForTier } from "@/lib/team/roles";
import { effortText, profileModel, profileSource } from "@/lib/local/runModel";
import { AGENT_PERMISSION_MODES } from "@/lib/local/permissionModes";
import { agentRow } from "@/components/home/pages/connectionRows";
import { foldEvents } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { sessionModels } from "./SessionTranscript";

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
    // 不看 Claude 订阅的模型目录：没配强档的模型时落到内置那条，由本机挑。
    expect(modelForTier(models, "strong")?.id).toBe("subscription");
    expect(modelForTier(models.filter((model) => model.agent === "codex"), "strong")).toBeNull();
    // 连上 TokenHub、默认还是订阅：「自动」不挑 TokenHub 的 Opus（11/11 定 A）
    await runner.connectTokenHub("good-key");
    const withHub = await runner.listModels();
    expect(withHub.some((model) => model.id.startsWith("th-"))).toBe(true);
    expect(modelForTier(withHub, "strong")?.id).toBe("subscription");
    await expect(runner.createSession({ subject: { kind: "plan", taskId: "t1" }, title: "拆卡", modelProfileId: "codex-gpt-6_1-sol", firstMessage: "拆" })).rejects.toMatchObject({ status: 400 });
  });

  it("Codex 子会话换模型、思考程度：在跑这一轮时 after_turn，没在跑 now；子会话下面的面板执行方两个都能选，来源配不上 Codex 的灰着", async () => {
    const runner = createMockRunner({ stepMs: 5, codex: "logged_in" });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\work\tianshu", modelProfileId: "codex-gpt-6_1-sol", firstMessage: "交代", effort: "ultra" });
    expect(session).toMatchObject({ agent: "codex", effort: "ultra" });
    const changed = await runner.setSessionModel(session.id, { effort: "high" });
    expect(changed.applied).toBe("after_turn");
    expect(changed.session.pendingModel?.effort).toBe("high");
    const models = await runner.listModels();
    const menu = sessionModels(runner, models, changed.session, () => undefined, () => undefined)!;
    const [agent, source, model, effort] = menu.rows;
    expect(agent!.options.map((option) => [option.label, !!option.disabled])).toEqual([["Claude Code", false], ["Codex", false]]);
    expect(source!.options.map((option) => [option.label, !!option.disabled])).toEqual([["Claude 订阅", true], ["TokenHub", true], ["Codex 订阅", false]]);
    expect([agent!.value, source!.value, model!.value, effort!.value]).toEqual(["Codex", "Codex 订阅", "GPT-6.1-Sol", "高"]);
    expect(effort!.options.map((option) => option.label)).toContain("极限");
  });

  it("开着的子会话换到另一家的来源就是换执行方（D 契约 5a217add）：空着时等新的那家起来再回，摘要的执行方跟着变，「先出计划」换到 Codex 变「每次都问」，事件流记一行", async () => {
    const runner = createMockRunner({ stepMs: 2, codex: "logged_in" });
    const models = await runner.listModels();
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:/work/tianshu", firstMessage: "交代", permissionMode: "plan" });
    expect(session).toMatchObject({ agent: "claude-code", permissionMode: "plan" });
    const seen: TLocalSessionEvent[] = [];
    const controller = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
    // 在跑着：这一轮做完再换。
    const later = await runner.setSessionModel(session.id, { modelProfileId: "codex-gpt-5_5" });
    expect(later.applied).toBe("after_turn");
    expect(later.session).toMatchObject({ agent: "claude-code", pendingModel: { modelProfileId: "codex-gpt-5_5" } });
    await until(async () => (await runner.listSessions())[0]!.agent === "codex");
    // 停下来（空着）：当场换回 Claude Code，回执里的会话已经是换好的。
    await runner.interrupt(session.id);
    const back = await runner.setSessionModel(session.id, { modelProfileId: "sub-haiku" });
    expect(back.applied).toBe("now");
    expect(back.session).toMatchObject({ agent: "claude-code", modelProfileId: "sub-haiku", run: { harness: "claude-code" } });
    expect(back.session.pendingModel).toBeUndefined();
    await until(async () => seen.filter((event) => event.type === "notice" && event.code === "harness_changed").length === 2);
    controller.abort();
    const view = foldEvents(seen);
    expect(view.entries.filter((entry) => entry.kind === "notice" && entry.code === "harness_changed").map((entry) => entry.kind === "notice" && entry.text)).toEqual(["换成 Codex · GPT-5.5", "换成 Claude Code · Haiku 5.5"]);
    // 「先出计划」换到 Codex 没有这一档：改成「每次都问」，权限档那颗跟着事件变。
    expect(seen.find((event) => event.type === "permission_mode")).toMatchObject({ mode: "default", by: "harness_changed" });
    expect(view.permissionMode).toBe("default");
    // 面板里两个执行方都能选（换执行方就是换到它能用的来源）；现在是 Claude Code · Claude 订阅。
    const rows = sessionModels(runner, models, back.session, () => undefined, () => undefined)!.rows;
    expect(rows[0]!.options.map((option) => [option.label, !!option.disabled])).toEqual([["Claude Code", false], ["Codex", false]]);
    expect(rows.map((row) => row.value)).toEqual(["Claude Code", "Claude 订阅", "Haiku 5.5", "自动"]);
  });

  it("规划员、验收员不能换到 Codex：面板里 Codex（执行方和它的来源）灰着，本机回 400", async () => {
    const runner = createMockRunner({ stepMs: 2, codex: "logged_in" });
    const models = await runner.listModels();
    const planner = await runner.createSession({ subject: { kind: "plan", taskId: "t1" }, title: "拆卡", firstMessage: "拆" });
    const rows = sessionModels(runner, models, planner, () => undefined, () => undefined)!.rows;
    expect(rows[0]!.options.map((option) => [option.label, !!option.disabled])).toEqual([["Claude Code", false], ["Codex", true]]);
    expect(rows[1]!.options.map((option) => [option.label, !!option.disabled])).toEqual([["Claude 订阅", false], ["TokenHub", false], ["Codex 订阅", true]]);
    await expect(runner.setSessionModel(planner.id, { modelProfileId: "codex-gpt-5_5" })).rejects.toMatchObject({ status: 400 });
    // 选了一项回的是「换好了」；没有要换的（还是现在这个）为 null。
    const picks = sessionModels(runner, models, planner, () => undefined, () => undefined)!;
    expect(picks.pick("model", planner.modelProfileId!)).toBeNull();
    await expect(picks.pick("model", "sub-haiku")).resolves.toBeUndefined();
  });
});
