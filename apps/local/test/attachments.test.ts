// 消息带附件（新首页设计 14.5）、状态条目带在问的提问和在等批准的那一步（B 的 aa6aba9e，新首页 9.6）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionEvent, LocalSyncItem } from "@warmap/contracts";
import { ATTACHMENT_DIR, attachmentNote, formatProblem, safeName, saveAttachments, type FetchAttachment } from "../src/attachments.js";
import { registerFormats } from "../src/store.js";
import { api, ORIGIN, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  expect([...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`)).toEqual([]);
};
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" }).trim();
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MD = Buffer.from("# 需求\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** 附件 id 是天枢给的 uuid；size、sha256 照内容算（content 不给时随便填）。 */
const ID: Record<string, string> = {
  a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b", c: "00000000-0000-4000-8000-00000000000c",
  x: "00000000-0000-4000-8000-0000000000ff", big: "00000000-0000-4000-8000-0000000000b1", gone: "00000000-0000-4000-8000-0000000000e0",
  png: "00000000-0000-4000-8000-000000000001", md: "00000000-0000-4000-8000-000000000002", bad: "00000000-0000-4000-8000-000000000003",
};
const ref = (key: string, fileName: string, content?: Buffer, size?: number) => ({ id: ID[key]!, fileName, size: size ?? content?.length ?? 1, sha256: sha(content ?? Buffer.from(key)) });

describe("附件落地", () => {
  it("格式按 14.5 认；文件名去掉路径和不许的字符；存进 .tianshu-attachments/<编号>/，目录自己忽略自己；同名加 (2)；太大、取不到整句不存", async () => {
    expect(formatProblem("截图.PNG")).toBeNull();
    expect(formatProblem("需求.docx")).toBeNull();
    expect(formatProblem("main.rs")).toBeNull();
    expect(formatProblem("run.log")).toBeNull();
    expect(formatProblem("安装包.exe")).toBe("安装包.exe：格式不支持");
    expect(formatProblem("没有扩展名")).toBe("没有扩展名：格式不支持");
    expect(safeName("..\\..\\x/y:z?.png")).toBe("y_z_.png");
    expect(safeName(".env.json")).toBe("_env.json");
    expect(safeName(`${"长".repeat(200)}.md`)).toHaveLength(120);

    const root = tempDir("tl-att-");
    const files: Record<string, Buffer> = { [ID.a!]: PNG, [ID.b!]: MD, [ID.c!]: Buffer.from("同名"), [ID.bad!]: Buffer.from("被换过的") };
    const fetchOne: FetchAttachment = async (id) => (id === ID.big ? { tooLarge: true } : id === ID.gone ? Promise.reject(new Error("天枢上没有这个附件")) : { bytes: files[id]!, mimeType: null });
    const saved = await saveAttachments(root, [ref("a", "截图.png", PNG), ref("b", "需求.md", MD), ref("c", "需求.md", Buffer.from("同名"))], fetchOne, 1000);
    expect(saved.map((s) => [s.name, s.path, s.size])).toEqual([
      ["截图.png", join(root, ATTACHMENT_DIR, "1000", "截图.png"), PNG.length],
      ["需求.md", join(root, ATTACHMENT_DIR, "1000", "需求.md"), 9],
      ["需求.md", join(root, ATTACHMENT_DIR, "1000", "需求(2).md"), 6],
    ]);
    expect(readFileSync(saved[0]!.path)).toEqual(PNG);
    expect(readFileSync(join(root, ATTACHMENT_DIR, ".gitignore"), "utf8")).toBe("*\n");
    // 同一毫秒又来一句：另开一个目录
    const again = await saveAttachments(root, [ref("b", "需求.md", MD)], fetchOne, 1000);
    expect(again[0]!.path).toBe(join(root, ATTACHMENT_DIR, "1000-2", "需求.md"));
    // 先看格式：有一个不支持就一个都不取
    let asked = 0;
    await expect(saveAttachments(root, [ref("a", "a.png", PNG), ref("x", "x.exe")], async (id) => { asked += 1; return fetchOne(id); }, 2000))
      .rejects.toMatchObject({ kind: "validation", message: "x.exe：格式不支持" });
    // 天枢说的大小就超了：也不取
    await expect(saveAttachments(root, [ref("big", "大.pdf", undefined, 31 * 1024 * 1024)], async (id) => { asked += 1; return fetchOne(id); }, 2500))
      .rejects.toMatchObject({ kind: "validation", message: "大.pdf：超过 30 MB" });
    expect(asked).toBe(0);
    // 太大、取不到：整句不存，已存的删掉
    await expect(saveAttachments(root, [ref("a", "a.png", PNG), ref("big", "大.pdf")], fetchOne, 3000)).rejects.toMatchObject({ kind: "validation", message: "大.pdf：超过 30 MB" });
    await expect(saveAttachments(root, [ref("a", "a.png", PNG), ref("gone", "丢.pdf")], fetchOne, 4000)).rejects.toMatchObject({ kind: "conflict", message: "丢.pdf：取不到（天枢上没有这个附件）" });
    // 取回来的和天枢记的 sha256 对不上：不交
    await expect(saveAttachments(root, [ref("a", "a.png", PNG), ref("bad", "图.png", Buffer.from("原来的"))], fetchOne, 4500))
      .rejects.toMatchObject({ kind: "conflict", message: "图.png：内容和天枢上的对不上（sha256 不一致），没有交给执行方" });
    await expect(saveAttachments(root, [ref("a", "a.png", PNG)], undefined, 5000)).rejects.toMatchObject({ kind: "conflict" });
    expect(readdirSync(join(root, ATTACHMENT_DIR)).sort()).toEqual([".gitignore", "1000", "1000-2"]);
    expect(attachmentNote(saved)).toBe(`本人随这句话发来 3 个附件，已存到工作区，用 Read 打开（图片、PDF 能直接看）：\n- 截图.png（图片）：${saved[0]!.path}\n- 需求.md：${saved[1]!.path}\n- 需求.md：${saved[2]!.path}`);
  });
});

/** 假天枢：收同步，按 id 给附件（attachments 里没有的回 404）。 */
function fakeCloud(attachments: Record<string, Buffer>) {
  const items: any[] = [];
  const asked: string[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/local-runner/sync") {
      const body = JSON.parse(init.body);
      items.push(...body.items);
      return new Response(JSON.stringify({ accepted: body.items.map((i: any) => i.key), rejected: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const m = /^\/api\/local-runner\/attachments\/(.+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      asked.push(`${id} ${init?.headers?.authorization ?? ""}`);
      const f = attachments[id];
      return f ? new Response(new Uint8Array(f), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(f.length) } }) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, items, asked };
}

async function setup(cfg: Record<string, unknown>, opts: { link?: boolean; git?: boolean } = {}) {
  // 卡在真的 git 仓库的工作树里做（附件不能被交回的提交带上；工作树里写文件不问本人）；git: false 是普通文件夹（写文件要批准）
  const repo = tempDir("tl-att-repo-");
  writeFileSync(join(repo, ".fake-claude.json"), JSON.stringify(cfg));
  if (opts.git !== false) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "测试");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, ".gitignore"), ".fake-claude-trace.jsonl\n.fake-claude-turns.jsonl\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  }
  const cloud = fakeCloud({ [ID.png!]: PNG, [ID.md!]: MD, [ID.bad!]: Buffer.from("被换过的") });
  const t = await startTestRunner({ pickFolder: repo, fetchImpl: cloud.impl });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  if (opts.link !== false) expect((await call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "cloud-token-0123456789abcdef" })).status).toBe(200);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const waitStatus = (id: string, want: string) => until(async () => (await session(id)).session.status === want);
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const open = async () => (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "card-att" }, title: "看截图改页面", cwd: repo, firstMessage: "做",
    // git 仓库里按「自动」（工作树里写文件自己放行）；不是 git 的按「每次都问」（用例靠写文件时停下等批准）
    permissionMode: opts.git === false ? "default" : "auto" })).body;
  const turns = (cwd: string, id: string) => readFileSync(join(cwd, ".fake-claude-turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.sid === id);
  return { t, repo, cloud, call, session, waitStatus, events, open, turns };
}

describe("一句话带附件发给子会话（假 claude）", { timeout: 40_000 }, () => {
  it("取回附件存进卡的工作树、交回的提交不带；给执行方的那句接上路径；事件里是原话和附件；格式不支持、没连天枢整句不发", async () => {
    const h = await setup({});
    try {
      const a = await h.open();
      await h.waitStatus(a.id, "idle"); // 工作树里写文件不问本人，一轮直接做完
      const cwd = (await h.session(a.id)).session.cwd as string;

      // 格式不支持：400，什么都不取、不发
      const bad = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "看看", attachments: [ref("png", "截图.png", PNG), ref("x", "装.exe")] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toBe("装.exe：格式不支持");
      expect(h.cloud.asked).toEqual([]);
      // 取不到：409
      const gone = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "看看", attachments: [ref("gone", "丢.pdf")] });
      expect(gone.status).toBe(409);
      expect(gone.body.error.message).toBe("丢.pdf：取不到（天枢上没有这个附件）");
      // sha256 对不上：不交，会话里报一条失败
      const changed = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "看看", attachments: [ref("bad", "图.png", Buffer.from("原来的"))] });
      expect(changed.status).toBe(409);
      expect(h.events(a.id).filter((e) => e.type === "notice" && e.code === "attachment_failed").map((e) => e.text)).toEqual([
        "附件没交给执行方：装.exe：格式不支持", "附件没交给执行方：丢.pdf：取不到（天枢上没有这个附件）", "附件没交给执行方：图.png：内容和天枢上的对不上（sha256 不一致），没有交给执行方",
      ]);
      expect(h.turns(cwd, a.id).filter((l) => l.turnText === "看看")).toEqual([]);

      const ok = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "照这张截图改", attachments: [ref("png", "截图.png", PNG), ref("md", "需求.md", MD)] });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(h.cloud.asked).toContain(`${ID.png} Bearer cloud-token-0123456789abcdef`);
      const said = await until(() => h.turns(cwd, a.id).find((l) => l.turnText?.startsWith("照这张截图改")));
      const ev = h.events(a.id).filter((e) => e.type === "user_message").at(-1);
      conforms(LocalSessionEvent, ev);
      expect(ev.text).toBe("照这张截图改");
      expect(ev.attachments.map((x: any) => [x.name, x.size])).toEqual([["截图.png", PNG.length], ["需求.md", 9]]);
      const png = ev.attachments[0].path as string;
      expect(png.startsWith(join(cwd, ATTACHMENT_DIR))).toBe(true);
      expect(readFileSync(png)).toEqual(PNG);
      expect(said.turnText).toBe(`照这张截图改\n\n${attachmentNote(ev.attachments)}`);
      // 工作树里看不到附件（目录自己忽略自己），交回提交时不会带上
      expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).not.toContain(ATTACHMENT_DIR);
      expect(existsSync(join(cwd, ATTACHMENT_DIR, ".gitignore"))).toBe(true);
      // 只发附件不说话也行
      await until(async () => (await h.session(a.id)).session.status === "idle" && h.events(a.id).filter((e) => e.type === "turn_end").length >= 2);
      const only = await h.call("POST", `/v1/sessions/${a.id}/messages`, { attachments: [ref("md", "需求.md", MD)] });
      expect(only.status).toBe(200);
      await until(() => h.events(a.id).filter((e) => e.type === "user_message").length >= 3);
      // 事件先记、假 claude 后收到：等它真收到这一句
      const note = attachmentNote(h.events(a.id).filter((e) => e.type === "user_message").at(-1).attachments);
      await until(() => h.turns(cwd, a.id).some((l) => l.turnText === note));
      expect(h.events(a.id).filter((e) => e.type === "user_message").at(-1)).toMatchObject({ text: "", attachments: [{ name: "需求.md" }] });
    } finally {
      await h.t.cleanup();
    }
  });

  it("没连天枢：409，不发", async () => {
    const h = await setup({}, { link: false });
    try {
      const a = await h.open();
      await h.waitStatus(a.id, "idle");
      const r = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "看看", attachments: [ref("png", "截图.png", PNG)] });
      expect(r.status).toBe(409);
      expect(r.body.error.message).toBe("截图.png：取不到（没连天枢）");
    } finally {
      await h.t.cleanup();
    }
  });
});

const ASK = [{ question: "用哪个方案？", header: "方案", multiSelect: false, options: [{ label: "A", description: "快" }, { label: "B", description: "稳" }] }];

describe("状态条目带在问的提问、在等批准的那一步（云端的「等你」靠它）", { timeout: 40_000 }, () => {
  it("waiting_permission 带 permission（不带完整输入）；在问时 idle 带 question；答完、一轮做完的 idle 不带", async () => {
    const h = await setup({ ask: ASK }, { git: false });
    try {
      const a = await h.open();
      await h.waitStatus(a.id, "idle");
      const statuses = () => h.cloud.items.filter((i) => i.sessionId === a.id && i.type === "status");
      const asking = await until(() => statuses().find((i) => i.data.status === "idle" && i.data.question));
      expect(asking.data.question).toMatchObject({ questions: ASK });
      conforms(LocalSyncItem, asking);
      const q = (await h.session(a.id)).session.pendingQuestion;
      await h.call("POST", `/v1/sessions/${a.id}/questions/${encodeURIComponent(q.requestId)}`, { choices: [["B"]] });
      await until(() => statuses().filter((i) => i.data.status === "idle").length >= 2);
      expect(statuses().filter((i) => i.data.status === "idle").at(-1).data.question).toBeUndefined(); // 一轮做完停下了

      // 第二轮要写文件：等批准，带那一步给人看的一行
      await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "写吧" });
      const waiting = await until(() => statuses().find((i) => i.data.status === "waiting_permission"));
      expect(waiting.data.permission).toEqual({ requestId: expect.any(String), toolName: "Write", title: "写文件 hello.txt", paths: ["hello.txt"], outsidePaths: [], canAllowForSession: expect.any(Boolean) });
      // 批了：等批准那条了结，后面报的状态不带 permission
      const pending = (await h.session(a.id)).pendingPermissions[0];
      expect(waiting.data.permission.requestId).toBe(pending.requestId);
      await h.call("POST", `/v1/sessions/${a.id}/permissions/${encodeURIComponent(pending.requestId)}`, { decision: "allow" });
      await h.waitStatus(a.id, "idle");
      await until(() => statuses().at(-1).data.status === "idle");
      expect(statuses().at(-1).data.permission).toBeUndefined();
      expect(JSON.stringify(waiting.data)).not.toContain("你好"); // 工具的完整输入不传
      conforms(LocalSyncItem, waiting);
    } finally {
      await h.t.cleanup();
    }
  });
});
