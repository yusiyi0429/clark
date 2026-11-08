import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockRunner } from "@/lib/local/mock";
import { foldEvents } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { AGENT_PERMISSION_MODES, PERMISSION_MODE_TEXT } from "@/lib/local/permissionModes";
import { PermissionModeMenu, modeByKey } from "./PermissionMode";
import { SessionComposer } from "./SessionTranscript";
import { startBatch } from "@/lib/work/queue";

// 交代取不到（404）时按标题拼，开工照开；这里只看带给本机的档。
vi.mock("@/lib/board/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/board/cloud")>();
  const missing = async () => { throw new actual.CloudError(404, "没有"); };
  return { ...actual, cardBrief: missing, topicBrief: missing, patchCard: async () => undefined };
});
import { startTopic } from "@/lib/local/start";
import type { CardItem } from "@/lib/board/cards";

describe("子会话的权限模式（17.2 第 11 条）", () => {
  it("五档的中文名和短副标题；Claude Code 五档都有，Codex 没有「先出计划」", () => {
    expect(AGENT_PERMISSION_MODES["claude-code"].map((mode) => PERMISSION_MODE_TEXT[mode].name)).toEqual(["自动", "每次都问", "自动接受改文件", "先出计划", "全部放行"]);
    expect(AGENT_PERMISSION_MODES.codex).not.toContain("plan");
    expect(PERMISSION_MODE_TEXT.auto.hint).toBe("由天枢判断哪些要问你");
  });

  it("菜单开着时数字键 1–5 选那一档，按的是这个执行方能选的第几档", () => {
    expect(modeByKey("1", AGENT_PERMISSION_MODES["claude-code"])).toBe("auto");
    expect(modeByKey("4", AGENT_PERMISSION_MODES["claude-code"])).toBe("plan");
    expect(modeByKey("4", AGENT_PERMISSION_MODES.codex)).toBe("bypassPermissions");
    expect(modeByKey("5", AGENT_PERMISSION_MODES.codex)).toBeNull();
    expect(modeByKey("a", AGENT_PERMISSION_MODES["claude-code"])).toBeNull();
  });

  it("输入框下面左侧写当前档；指挥不了本机时只写档名、点不开", () => {
    const html = renderToStaticMarkup(<SessionComposer label="给拆左栏插话" disabled={false} onSend={vi.fn()} subject={{ kind: "card", id: "00000000-0000-4000-8000-0000000000c1" }}
      mode={{ modes: AGENT_PERMISSION_MODES["claude-code"], value: "acceptEdits", set: vi.fn() }} />);
    expect(html).toMatch(/<textarea[\s\S]*data-testid="permission-mode"[^>]*>[\s\S]*自动接受改文件/);
    expect(html).toContain('aria-label="权限模式：自动接受改文件"');
    const away = renderToStaticMarkup(<PermissionModeMenu modes={AGENT_PERMISSION_MODES["claude-code"]} value="auto" disabled onChange={vi.fn()} />);
    expect(away).toMatch(/disabled=""/);
    expect(renderToStaticMarkup(<SessionComposer label="给拆左栏插话" disabled={false} onSend={vi.fn()} subject={{ kind: "card", id: "00000000-0000-4000-8000-0000000000c1" }} />)).not.toContain("permission-mode");
  });

  it("中途换档：本机报 permission_mode，会话跟着变；先出计划批了自动转成「自动」", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代", permissionMode: "plan" });
    expect(session.permissionMode).toBe("plan");
    const seen: TLocalSessionEvent[] = [];
    const controller = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
    const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
    await until(() => seen.some((event) => event.type === "permission_request"));
    const request = seen.find((event) => event.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("没有权限请求");
    const approved = await runner.decidePermission(session.id, request.request.requestId, { decision: "allow" });
    expect(approved.permissionMode).toBe("auto");
    expect(foldEvents(seen).permissionMode).toBe("auto");
    const changed = await runner.setPermissionMode(session.id, "acceptEdits");
    expect(changed.permissionMode).toBe("acceptEdits");
    await until(() => foldEvents(seen).permissionMode === "acceptEdits");
    expect(seen.filter((event) => event.type === "permission_mode").map((event) => event.type === "permission_mode" && event.by)).toEqual(["plan_approved", "web"]);
    controller.abort();
  });
});

describe("项目主管线下面的默认档（17.2 第 11 条，契约 919cc7f8）", () => {
  it("手机上点开是底部抽屉：触发写当前档，声明弹出对话框", () => {
    const html = renderToStaticMarkup(<PermissionModeMenu modes={AGENT_PERMISSION_MODES["claude-code"]} value="plan" sheet onChange={vi.fn()} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="权限模式：先出计划"');
    expect(html).not.toContain("permission-mode-sheet");
  });

  it("开工时把项目的默认档带给本机：卡（一批开工）和专题都带，不给的本机按自动", async () => {
    {
      const runner = createMockRunner({ stepMs: 1 });
      const [model] = await runner.listModels();
      const item = { id: "00000000-0000-4000-8000-0000000000c9", title: "拆左栏", version: 1, doneDefinition: "做完", card: null } as unknown as CardItem;
      await startBatch(runner, [{ item, model: model!, cwd: "C:\work", role: null, permissionMode: "plan" }]);
      await startTopic(runner, { id: "00000000-0000-4000-8000-0000000000d9", title: "调研" }, model!, undefined, "acceptEdits");
      await startTopic(runner, { id: "00000000-0000-4000-8000-0000000000e9", title: "没给" }, model!);
      const modes = Object.fromEntries((await runner.listSessions()).map((session) => [session.title, session.permissionMode]));
      expect(modes).toEqual({ 拆左栏: "plan", 调研: "acceptEdits", 没给: "auto" });
    }
  });
});
