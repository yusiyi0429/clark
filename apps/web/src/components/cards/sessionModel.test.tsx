import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockRunner } from "@/lib/local/mock";
import { foldEvents, type SessionEntry } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { PENDING_MODEL_TITLE, effortText, harnessLabel, sessionModelText, withPendingModel } from "@/lib/local/runModel";
import { SessionComposer, SessionTranscript, sessionModels } from "./SessionTranscript";

const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
const subject = { kind: "card" as const, id: "00000000-0000-4000-8000-0000000000c1" };

describe("子会话换模型（32 条，D 契约 5e52c73f）", () => {
  it("now：同来源或没在跑时当场换，摘要和下面那一行马上是新模型；换模型那一句进过程行，不单独一行", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const seen: TLocalSessionEvent[] = [];
    const controller = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
    const changed = await runner.setSessionModel(session.id, { modelProfileId: "sub-haiku" });
    expect(changed.applied).toBe("now");
    expect(changed.session.modelProfileId).toBe("sub-haiku");
    expect(changed.session.pendingModel).toBeUndefined();
    expect(withPendingModel(harnessLabel(changed.session.run, changed.session.agent), changed.session.pendingModel)?.label).toBe("Claude Code · Haiku 5.5");
    await until(() => seen.some((event) => event.type === "notice" && event.code === "model_changed"));
    const entries = foldEvents(seen).entries;
    expect(entries.find((entry) => entry.kind === "notice" && entry.code === "model_changed")).toBeTruthy();
    controller.abort();
    // 过程行里：前后的步骤和这一句并成一段，展开一行是「换成 …」，总结不把它算成步数。
    const at = "2026-11-09T01:00:00Z";
    const html = renderToStaticMarkup(<SessionTranscript agentName="Claude Code" canAct onDecide={vi.fn()} live={false} entries={[
      { kind: "step", seq: 1, at, toolUseId: "t1", title: "读文件 a.ts", done: true, isError: false },
      { kind: "notice", seq: 2, at, level: "info", code: "model_changed", text: "换成 haiku" },
      { kind: "step", seq: 3, at, toolUseId: "t3", title: "运行 pnpm test", done: true, isError: false },
    ] satisfies SessionEntry[]} />);
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    expect(html).toContain('aria-label="运行 1 条命令 · 读 1 个文件，展开"');
    expect(html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")).toContain("|读文件 a.ts|换成 haiku|运行 pnpm test|");
  });

  it("after_turn：跑着时换来源要等这一轮做完，下面那一行写「当前 → 新」、悬停「这一轮做完后换」；换上后回到只写新模型", async () => {
    const runner = createMockRunner({ stepMs: 5 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const changed = await runner.setSessionModel(session.id, { modelProfileId: "tokenhub-deepseek" });
    expect(changed.applied).toBe("after_turn");
    expect(changed.session.modelProfileId).toBe("subscription");
    expect(changed.session.pendingModel?.modelProfileId).toBe("tokenhub-deepseek");
    const pending = withPendingModel(harnessLabel(changed.session.run, changed.session.agent), changed.session.pendingModel)!;
    expect(pending.label).toMatch(/^Claude Code · .+ → deepseek-v4\.1-flash$/);
    expect(pending.title).toBe(PENDING_MODEL_TITLE);
    const html = renderToStaticMarkup(<SessionComposer label="插话" disabled={false} onSend={vi.fn()} subject={subject} model={{ label: pending.label, title: pending.title ?? undefined }}
      models={{ rows: sessionModels(runner, await runner.listModels(), changed.session, vi.fn(), vi.fn())!.rows, busy: null, onPick: vi.fn() }} />);
    expect(html).toContain(`title="${PENDING_MODEL_TITLE}"`);
    expect(html).toContain('data-testid="session-model"');
    let after = changed.session;
    await until(() => { void runner.listSessions().then((list) => { after = list.find((entry) => entry.id === session.id) ?? after; }); return after.modelProfileId === "tokenhub-deepseek"; });
    expect(after.pendingModel).toBeUndefined();
    expect(withPendingModel(harnessLabel(after.run, after.agent), after.pendingModel)?.label).toBe("Claude Code · deepseek-v4.1-flash");
    // 没换成本机 400：没有这个模型。
    await expect(runner.setSessionModel(session.id, { modelProfileId: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("思考程度（36 条，D 契约 c97b38c5）", () => {
  it("给人看的字：低 / 中 / 高 / 超高 / 最高 / 极限，项目对话的 off 是「不思考」，没选是「自动」", () => {
    expect((["low", "medium", "high", "xhigh", "max", "ultra", "off"] as const).map((effort) => effortText(effort))).toEqual(["低", "中", "高", "超高", "最高", "极限", "不思考"]);
    expect(effortText(null)).toBe("自动");
  });

  it("子会话下面一行写「Claude 订阅 · Opus 5.5 · 高」（67 条），悬停前面多写执行方；开工带的思考程度进摘要；开着只换思考程度当场换，换成网关模型（不能选）回到自动、不写后半", async () => {
    const runner = createMockRunner({ stepMs: 5 });
    const models = await runner.listModels();
    const effortsOf = (id: string) => models.find((model) => model.id === id)?.efforts;
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代", effort: "high" });
    expect(session.effort).toBe("high");
    expect(sessionModelText(session, effortsOf(session.modelProfileId))).toEqual({ label: "Claude 订阅 · Opus 5.5 · 高", title: "Claude Code · Claude 订阅 · Opus 5.5 · 高" });
    const changed = await runner.setSessionModel(session.id, { effort: "max" });
    expect(changed.applied).toBe("now");
    expect(changed.session.effort).toBe("max");
    expect(sessionModelText(changed.session, effortsOf(changed.session.modelProfileId))?.label).toBe("Claude 订阅 · Opus 5.5 · 最高");
    expect((await runner.setSessionModel(session.id, { effort: null })).session.effort).toBeUndefined();
    await expect(runner.setSessionModel(session.id, { modelProfileId: "tokenhub-deepseek", effort: "high" })).rejects.toMatchObject({ status: 400 });
    // 换模型不带思考程度：新模型也支持就留着。
    await runner.setSessionModel(session.id, { effort: "low" });
    expect((await runner.setSessionModel(session.id, { modelProfileId: "sub-haiku" })).session.effort).toBe("low");
    // 面板「思考」那一行只列这个模型的几档，「自动」在前（开着才画，这里看给它的数据）；思考是自动时下面一行只写模型名。
    const now = (await runner.listSessions())[0]!;
    const picks = sessionModels(runner, models, now, vi.fn(), vi.fn())!;
    expect(picks.rows.map((row) => [row.name, row.value])).toEqual([["执行方", "Claude Code"], ["来源", "Claude 订阅"], ["模型", "Haiku 5.5"], ["思考", "低"]]);
    expect(picks.rows[3]!.options.map((option) => option.label)).toEqual(["自动", "低", "中", "高", "超高", "最高"]);
    expect(sessionModelText({ ...now, effort: undefined }, effortsOf(now.modelProfileId))?.label).not.toContain("自动");
    expect(sessionModelText({ run: { ...session.run!, modelName: "deepseek-v4.1-flash" }, agent: "claude-code" }, effortsOf("tokenhub-deepseek"))?.label).toBe("Claude 订阅 · deepseek-v4.1-flash");
  });
});
