// 子会话停了、要人介入都报给项目主管线（设计 18.10）：停了报一条 stopped（一两句摘要、卡在哪、这一轮的产出物），
// 要介入照旧是 status 条目带待决的内容（批准卡要的 canAllowForSession 也带上）；回答、批准、转话走现有的网页接口。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSyncItem } from "@warmap/contracts";
import { firstSentences } from "../src/stopReport.js";
import { registerFormats } from "../src/store.js";
import { cutText } from "../src/textCut.js";
import { api, pair, raw, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("头一两句", () => {
  it("取前两句，去掉 Markdown 记号；没标点的行当一句；太长截到 200 字", () => {
    expect(firstSentences("登录页改好了，测试都过了。截图放在 out/ 里。还顺手修了个错字。")).toBe("登录页改好了，测试都过了。截图放在 out/ 里。");
    expect(firstSentences("## 做完了\n\n- 改了 **src/login.ts**\n- 加了 `login.test.ts`\n- 第三条\n\n```ts\nconst x = 1;\n```")).toBe("改了 src/login.ts；加了 login.test.ts。");
    expect(firstSentences("Fixed the login page. All tests pass. Also renamed a file.")).toBe("Fixed the login page. All tests pass.");
    expect(firstSentences("Fixed the login page.\nAll tests pass.\nDone.")).toBe("Fixed the login page. All tests pass.");
    expect(firstSentences("升到 v1.2.3 了。")).toBe("升到 v1.2.3 了。");
    expect(firstSentences("看 [PR](https://github.com/x/y/pull/1) 就行")).toBe("看 PR 就行");
    expect(firstSentences("```\n只有代码\n```")).toBeNull();
    expect(firstSentences(null)).toBeNull();
    expect(firstSentences("长".repeat(300))).toHaveLength(200);
  });

  it("冒号、逗号、顿号结尾的行话没说完：直接接下一行，不补「；」（3700 验收「三件事都做完了：；已删除…」）", () => {
    expect(firstSentences("三件事都做完了：\n- 已删除旧文件\n- 改了配置\n- 跑过测试")).toBe("三件事都做完了：已删除旧文件；改了配置。"); // 照旧只取前两句
    expect(firstSentences("改了登录页，\n顺手修了错字、\n补了测试")).toBe("改了登录页，顺手修了错字、补了测试");
    expect(firstSentences("Done:\n- removed old files")).toBe("Done: removed old files");
  });
});

describe("停了、要人介入都报给云端", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-stop-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  /** 发件箱里这个会话的同步条目（没关联云端，都还排着）。 */
  const items = (id: string) => (JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries as { item: any }[])
    .map((e) => e.item).filter((i) => i.sessionId === id);
  const stops = (id: string) => items(id).filter((i) => i.type === "stopped");
  const pending = async (id: string) => until(async () => (await call("GET", `/v1/sessions/${id}`)).body.pendingPermissions[0]);
  const card = (name: string) => {
    mkdirSync(join(work, name), { recursive: true });
    return { subject: { kind: "card", cardId: name, projectId: "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10" }, title: name, cwd: join(work, name), firstMessage: `做 ${name}` };
  };

  beforeAll(async () => {
    t = await startTestRunner({ pickFolder: work });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    writeFileSync(join(work, ".fake-claude.json"), "{}");
  });
  afterAll(() => t.cleanup());

  it("要批准：status 条目带待决的那一步和能不能「这张卡都允许」；在项目对话里批了就交给子会话；做完一轮报停了，带这一轮的产出物", async () => {
    const s = (await call("POST", "/v1/sessions", card("A"))).body;
    const p = await pending(s.id);
    const ask = await until(() => items(s.id).find((i) => i.type === "status" && i.data.status === "waiting_permission"));
    expect(ask.subject).toMatchObject({ kind: "card", cardId: "A", projectId: "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10" });
    expect(ask.data.permission).toEqual({ requestId: p.requestId, toolName: p.toolName, title: p.title, outsidePaths: [], canAllowForSession: p.canAllowForSession, paths: ["hello.txt"] });
    expect(stops(s.id)).toEqual([]); // 要人介入不算停了

    // 等批准的时候交了一份产出物
    writeFileSync(join(work, "A", "说明.md"), "# 改了什么");
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", s.id, "session.json"), "utf8")).mcpSecret;
    const mcp = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${s.id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_artifact", arguments: { path: "说明.md", title: "改动说明" } } }),
    });
    expect(mcp.body.result.isError).toBe(false);

    // 网页从项目对话那边批：现有的接口
    expect((await call("POST", `/v1/sessions/${s.id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" })).status).toBe(200);
    const [stop] = await until(() => (stops(s.id).length ? stops(s.id) : null));
    expect(Value.Check(LocalSyncItem, stop)).toBe(true);
    const artifactKey = items(s.id).find((i) => i.type === "artifact").key;
    expect(stop.subject).toMatchObject({ kind: "card", cardId: "A" });
    expect(stop.data).toEqual({ why: "turn_done", summary: "写好了", blocker: null, outputs: [{ key: artifactKey, title: "改动说明", fileName: "说明.md" }] });
    // 已经批过的再批：409
    expect((await call("POST", `/v1/sessions/${s.id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" })).status).toBe(409);

    // 转话：停了以后说一句，开新的一轮；本人点停下，报 interrupted，产出物不再重复带
    expect((await call("POST", `/v1/sessions/${s.id}/messages`, { text: "再改一处" })).status).toBe(200);
    await pending(s.id);
    await call("POST", `/v1/sessions/${s.id}/interrupt`, {});
    await until(() => stops(s.id).length === 2);
    expect(stops(s.id)[1].data).toMatchObject({ why: "interrupted", blocker: null, outputs: [] });

    // 一轮做到一半强停：报 killed；强停一个已经停着的不再报
    await call("POST", `/v1/sessions/${s.id}/messages`, { text: "接着" });
    await pending(s.id);
    await call("POST", `/v1/sessions/${s.id}/kill`, {});
    await until(() => stops(s.id).length === 3);
    expect(stops(s.id)[2].data).toMatchObject({ why: "killed", blocker: null });
    await call("POST", `/v1/sessions/${s.id}/kill`, {});
    await new Promise((r) => setTimeout(r, 200));
    expect(stops(s.id)).toHaveLength(3);
  });

  it("出错停住：卡在哪写执行方的报错，不当成做成了什么", async () => {
    const c = card("B");
    writeFileSync(join(c.cwd, ".fake-claude.json"), JSON.stringify({ mode: "auth" }));
    const s = (await call("POST", "/v1/sessions", c)).body;
    const [stop] = await until(() => (stops(s.id).length ? stops(s.id) : null));
    expect(stop.data).toEqual({ why: "error", summary: null, blocker: "Not logged in · Please run /login", outputs: [] });
  });
});

describe("上屏文字的截断", () => {
  it("截断不会留下半个 emoji", () => {
    // 第 200 个 UTF-16 单元正好是 😀 的前一半：网页上会画成 �。
    expect(firstSentences(`${"字".repeat(199)}😀尾`)).toBe("字".repeat(199));
    expect(cutText(`${"字".repeat(5)}😀尾`, 6)).toBe("字".repeat(5));
    expect(cutText("ab😀", 4)).toBe("ab😀");
    expect(cutText("短", 6)).toBe("短");
  });
});
