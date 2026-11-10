import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { foldEvents, type SessionEntry } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { SessionComposer, SessionTranscript, processSummary, roundStart } from "./SessionTranscript";

const step = (seq: number, title: string, at: string, done = true): SessionEntry => ({ kind: "step", seq, at, toolUseId: `t${seq}`, title, done, isError: false });
const render = (entries: SessionEntry[], live = true) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={live} />);
/** 组头：带 aria-expanded 的按钮。 */
const heads = (html: string) => [...html.matchAll(/<button[^>]*aria-expanded="[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!);

const permit = (seq: number, title: string, at: string, decision: "allow" | "deny" | null): SessionEntry => ({ kind: "permission", seq, at, decision,
  request: { requestId: `p${seq}`, toolName: "Bash", title, input: {}, outsidePaths: [], canAllowForSession: true, requestedAt: at } });
/** 去掉标签的纯文字。 */
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("过程收起（28 条，照 Claude Code）", () => {
  it("被批准行隔开的步骤合成一段：两句对话之间只一行；批过的不出单独行、不写「已批准」", () => {
    const html = render([
      { kind: "user", seq: 1, at: "2026-11-09T01:00:00Z", text: "先跑测试" },
      step(2, "读文件 web/a.ts", "2026-11-09T01:00:01Z"),
      permit(3, "运行 pnpm test", "2026-11-09T01:00:02Z", "allow"),
      step(4, "运行 pnpm test", "2026-11-09T01:00:03Z"),
      permit(5, "搜索 roundStart", "2026-11-09T01:00:04Z", "allow"),
      step(6, "搜索 roundStart", "2026-11-09T01:00:05Z"),
      { kind: "assistant", seq: 7, at: "2026-11-09T01:00:06Z", text: "测完了" },
      step(8, "改文件 web/a.ts", "2026-11-09T01:00:07Z"),
    ], false);
    expect(heads(html)).toHaveLength(2);
    expect(html).not.toContain("已批准");
    expect(html).not.toContain("data-resolved");
    // 收着：只有总结，点开才一步一行；步骤不写时间。
    expect(html).toContain('aria-label="运行 1 条命令 · 读 1 个文件 · 搜索 1 次 · 4 秒，展开"');
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toContain("|读文件 web/a.ts|运行 pnpm test|搜索 roundStart|");
    expect(html).not.toMatch(/<time>/);
  });

  it("总结按类型数：运行 5 条命令 · 读 3 个文件 · 改 2 个文件 · 搜索 2 次，后面跟这一段的用时；别的写「其他 N 步」", () => {
    const titles = ["运行 a", "运行 b", "运行 c", "运行 d", "运行 e", "读文件 x", "读文件 y", "读 z", "改文件 x", "写文件 n", "搜索 foo", "找文件 *.ts"];
    const html = render(titles.map((title, index) => step(index + 1, title, `2026-11-09T01:0${index < 6 ? 0 : 1}:${String(index * 5).padStart(2, "0")}Z`)), false);
    expect(heads(html)[0]).toMatch(/运行 5 条命令 · 读 3 个文件 · 改 2 个文件 · 搜索 2 次<\/span><span[^>]*>1 分 55 秒/);
    expect(processSummary(["派子任务 看代码", "运行 x", "更新计划"])).toBe("运行 1 条命令 · 其他 2 步");
  });

  it("在跑时这一行是转圈加当前那一步；做完了（或不在跑）收成总结", () => {
    const entries = [step(1, "读文件 a.ts", "2026-11-09T01:00:00Z"), step(2, "运行 pnpm test", "2026-11-09T01:00:05Z", false), step(3, "读文件 b.ts", "2026-11-09T01:00:06Z")];
    const live = heads(render(entries))[0]!;
    expect(live).toContain('aria-label="进行中"');
    expect(text(live)).toContain("|运行 pnpm test|");
    expect(render(entries)).toContain('aria-label="运行 pnpm test，展开"');
    // 在跑时最后那段在转圈，最下面不再出「在跑」那一行。
    expect(render(entries)).not.toContain("session-working");
    const done = heads(render(entries, false))[0]!;
    expect(done).not.toContain('aria-label="进行中"');
    expect(text(done)).toContain("|运行 1 条命令 · 读 2 个文件|6 秒|");
    // 后面已经有对话了，前面那段不再转圈。
    expect(heads(render([...entries, { kind: "assistant", seq: 4, at: "2026-11-09T01:00:07Z", text: "好了" }]))[0]).not.toContain('aria-label="进行中"');
  });

  it("换了做法的：不单独成行，点开后那一步行尾一个淡色「换个做法」；没有那一步也算一行；还没批的照旧是选项框", () => {
    const denied = render([
      step(1, "读文件 a.ts", "2026-11-09T01:00:00Z"),
      step(2, "运行 rm -rf dist", "2026-11-09T01:00:01Z", false),
      permit(3, "运行 rm -rf dist", "2026-11-09T01:00:02Z", "deny"),
      permit(4, "运行 git push", "2026-11-09T01:00:03Z", "deny"),
    ], false);
    expect(heads(denied)).toHaveLength(1);
    expect(text(denied)).toContain("|读文件 a.ts|运行 rm -rf dist|换个做法|运行 git push|换个做法|");
    expect(denied.match(/换个做法/g)).toHaveLength(2);
    const pending = render([step(1, "读文件 a.ts", "2026-11-09T01:00:00Z"), permit(2, "运行 pnpm test", "2026-11-09T01:00:01Z", null)]);
    expect(pending).toContain("同类以后都批准");
    expect(heads(pending)).toHaveLength(1);
  });

  it("AskUserQuestion 这一步不画，留问答那一行；产出、交回照旧单独一行", () => {
    const html = render([
      step(1, "读文件 a.ts", "2026-11-09T01:00:00Z"),
      step(2, "AskUserQuestion", "2026-11-09T01:00:01Z"),
      { kind: "notice", seq: 3, at: "2026-11-09T01:00:02Z", level: "info", text: "问：要不要删旧说明？" },
      { kind: "notice", seq: 4, at: "2026-11-09T01:00:03Z", level: "info", text: "答：删掉" },
      step(5, "写文件 交回说明.md", "2026-11-09T01:00:04Z"),
      { kind: "artifact", seq: 6, at: "2026-11-09T01:00:05Z", title: "交回说明", fileName: "交回说明.md" },
    ], false);
    expect(html).not.toContain("AskUserQuestion");
    expect(text(html)).toMatch(/读 1 个文件\|.*要不要删旧说明？.*删掉.*改 1 个文件\|.*交出 交回说明\.md/);
  });
});

describe("子会话回执（17.4）", () => {
  const at = "2026-11-08T02:00:00Z";
  const ev = (seq: number, body: Record<string, unknown>) => ({ seq, at, ...body }) as unknown as TLocalSessionEvent;
  const ids = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"] as const;

  it("按编号挂到那句话上：一个勾已送达、两个勾已读、failed 写「没读到 · 重发」；本机补发的话没有回执", () => {
    const view = foldEvents([
      ev(1, { type: "user_message", text: "先跑测试", source: "web", messageId: ids[0] }),
      ev(2, { type: "user_message", text: "再改样式", source: "web", messageId: ids[1] }),
      ev(3, { type: "user_message", text: "额度恢复了，接着做", source: "web" }),
      ev(4, { type: "user_message", text: "顺手提交", source: "web", messageId: ids[2] }),
      ev(5, { type: "receipt", messageId: ids[0], state: "delivered" }),
      ev(6, { type: "receipt", messageId: ids[1], state: "delivered" }),
      ev(7, { type: "receipt", messageId: ids[1], state: "read" }),
      ev(8, { type: "receipt", messageId: ids[2], state: "delivered" }),
      ev(9, { type: "receipt", messageId: ids[2], state: "failed" }),
    ]);
    expect(view.entries.map((entry) => entry.kind === "user" ? entry.receipt ?? null : "-")).toEqual(["delivered", "read", null, "failed"]);
    const html = render(view.entries);
    expect(html).toMatch(/先跑测试<\/div><span[^>]*data-receipt="delivered"[^>]*aria-label="已送达"/);
    expect(html).toMatch(/再改样式<\/div><span[^>]*data-receipt="read"[^>]*aria-label="已读"/);
    expect(html).toMatch(/额度恢复了，接着做<\/div><div/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("顺手提交没读到 ·重发");
    // 这里答不了（别的电脑、手机）：只写「没读到」，不给重发。
    const away = renderToStaticMarkup(<SessionTranscript entries={view.entries} agentName="Claude Code" canAct={false} onDecide={vi.fn()} live />);
    expect(away.replace(/<[^>]+>/g, "")).toContain("顺手提交没读到");
    expect(away).not.toContain("重发");
  });
});

describe("子会话的输入框", () => {
  it("不放占位字（空着就是一行），读屏名字还是「给{子会话名}插话」", () => {
    const html = renderToStaticMarkup(<SessionComposer label="给拆左栏插话" disabled={false} onSend={vi.fn()} subject={{ kind: "card", id: "00000000-0000-4000-8000-0000000000c1" }} />);
    const box = html.match(/<textarea[^>]*>/)?.[0] ?? "";
    expect(box).toContain('aria-label="给拆左栏插话"');
    expect(box).toMatch(/placeholder=""/);
    expect(html).not.toContain("插话…");
  });
});

describe("子会话在跑时界面在动（27 条）", () => {
  const said = (seq: number, at: string): SessionEntry => ({ kind: "user", seq, at, text: "接着做" });
  it("刚说完、在想：最下面一行转圈「在跑」加这一轮跑了多久；最后是一段过程（它自己转圈）、不在跑、在等批准时不出", () => {
    const thinking = [step(1, "读 a.ts", "2026-11-07T01:00:00Z"), said(2, "2026-11-07T01:00:03Z")];
    expect(render(thinking)).toMatch(/data-testid="session-working"><span[^>]*aria-label="在跑"/);
    expect(render([...thinking, step(3, "跑 pnpm test", "2026-11-07T01:00:05Z", false)])).not.toContain("session-working");
    expect(render(thinking, false)).not.toContain("session-working");
    expect(render([...thinking, permit(4, "运行 pnpm test", "2026-11-07T01:00:06Z", null)])).not.toContain("session-working");
  });

  it("时长从这一轮开始算：最近一句本人说的；还没说过取第一条", () => {
    expect(roundStart([said(1, "a"), step(2, "x", "b"), said(3, "c"), step(4, "y", "d")])).toBe("c");
    expect(roundStart([step(1, "x", "b")])).toBe("b");
    expect(roundStart([])).toBeNull();
  });

  it("输入框：在跑时没字是停止方块，同项目对话、伙伴台", () => {
    const html = renderToStaticMarkup(<SessionComposer label="给 A 插话" disabled={false} onSend={async () => true} subject={{ kind: "card", id: "c1" }} busy onStop={vi.fn()} />);
    expect(html).toContain('aria-label="停止本次回答"');
  });
});
