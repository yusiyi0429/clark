// 越界路径标红、允许的文件夹不许太宽、干净会话不读本人全局记忆、网关出错快点失败（11/06 第二轮）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outsidePaths, type PathScope } from "../src/agents/pathGuard.js";
import { isInside } from "../src/folders.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

const trace = (dir: string) => readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const runs = (dir: string) => trace(dir).filter((l) => l.argv);
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("越界路径识别", () => {
  const root = tempDir("tl-guard-");
  const cwd = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(cwd, { recursive: true });
  const scope = (platform: NodeJS.Platform = process.platform): PathScope => ({ cwd, home: homedir(), isAllowed: (p) => isInside(cwd, p), platform });
  const out = (tool: string, input: Record<string, unknown>, hint?: string) => outsidePaths(tool, input, scope(), hint);

  it("文件类工具按字段取路径：工作目录里的不算，外面的算", () => {
    expect(out("Read", { file_path: join(cwd, "a.ts") })).toEqual([]);
    expect(out("Write", { file_path: "src/a.ts" })).toEqual([]);
    expect(out("Edit", { file_path: join(other, "a.ts") })).toEqual([join(other, "a.ts")]);
    expect(out("Write", { file_path: "../other/x.txt" })).toEqual(["../other/x.txt"]);
    expect(out("Glob", { pattern: "**/*.ts" })).toEqual([]);
    expect(out("Glob", { pattern: "*.txt", path: other })).toEqual([other]);
    expect(out("Grep", { pattern: "x", path: cwd })).toEqual([]);
    expect(out("NotebookEdit", { notebook_path: join(other, "n.ipynb") })).toHaveLength(1);
    expect(out("WebFetch", { url: "https://example.com/a/../b" })).toEqual([]);
  });

  it("Bash、PowerShell：认出引号里的绝对路径、~、主目录变量、..、重定向目标；程序本身和 /dev/null 不算", () => {
    const f = join(other, "secret.txt");
    expect(out("Bash", { command: `cat "${f}"` })).toEqual([f]);
    expect(out("Bash", { command: "cat ~/.ssh/id_rsa" })).toEqual(["~/.ssh/id_rsa"]);
    expect(out("Bash", { command: "ls ../../ && echo ok > ../out.txt" })).toEqual(["../../", "../out.txt"]);
    expect(out("Bash", { command: "pnpm test 2>/dev/null | tail -5" })).toEqual([]);
    expect(out("Bash", { command: "node scripts/build.mjs --out=dist" })).toEqual([]);
    expect(out("Bash", { command: "curl -s https://example.com/x" })).toEqual([]);
    expect(out("PowerShell", { command: "Get-Content -Path $env:USERPROFILE\\.claude\\.credentials.json" })).toEqual(["$env:USERPROFILE\\.claude\\.credentials.json"]);
    expect(out("Bash", { command: "ls" }, f)).toEqual([f]); // Claude Code 给的 blocked_path 也算
  });

  it("Windows 上 Git Bash 的 /c/... 换成盘符；/tmp 这类算越界", () => {
    if (process.platform !== "win32") return;
    const posix = "/" + cwd[0]!.toLowerCase() + cwd.slice(2).replace(/\\/g, "/");
    expect(outsidePaths("Bash", { command: `cat ${posix}/a.txt` }, scope("win32"))).toEqual([]);
    expect(outsidePaths("Bash", { command: "cat /tmp/x.log" }, scope("win32"))).toEqual(["/tmp/x.log"]);
  });
});

describe("会话里的越界请求、允许的文件夹、全局记忆、网关出错", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  const outside = resolve(tempDir("tl-outside-"), "x.txt");
  let pick: string | null = work;
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  beforeAll(async () => {
    t = await startTestRunner({ fetchImpl: offline, pickFolder: () => pick });
    token = await pair(t.port);
    expect((await api(t.port, token, "POST", "/v1/folders/pick", {})).status).toBe(200);
  });
  afterAll(async () => { await t.cleanup(); });

  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  const open = async (extra: Record<string, unknown> = {}) => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi", ...extra });
    expect(s.status).toBe(200);
    return s.body.id as string;
  };
  const pending = (id: string) => until(async () => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.pendingPermissions[0]);
  const lastPermissionResponse = () => trace(work).filter((l) => l.permissionResponse).at(-1)!.permissionResponse;
  const kill = (id: string) => api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});

  it("越界的写：标出路径，不能「这张卡都允许」，网页硬要也只放行这一次", async () => {
    fake({ writePath: outside });
    const id = await open();
    const p = await pending(id);
    expect(p.outsidePaths).toEqual([outside]);
    expect(p.canAllowForSession).toBe(false);
    await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${p.requestId}`, { decision: "allow", allowForSession: true });
    await until(() => trace(work).some((l) => l.permissionResponse));
    expect(lastPermissionResponse()).toMatchObject({ behavior: "allow" });
    expect(lastPermissionResponse().updatedPermissions).toBeUndefined();
    await kill(id);
  });

  it("没越界的「这张卡都允许」：建议里写进仓库设置的一律改成只在本会话", async () => {
    fake({ suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test" }], behavior: "allow", destination: "localSettings" }, { type: "setMode", mode: "acceptEdits", destination: "session" }] });
    const id = await open();
    const p = await pending(id);
    expect(p.outsidePaths).toEqual([]);
    expect(p.canAllowForSession).toBe(true);
    await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${p.requestId}`, { decision: "allow", allowForSession: true });
    await until(() => trace(work).filter((l) => l.permissionResponse).length >= 2);
    const updated = lastPermissionResponse().updatedPermissions as { destination: string }[];
    expect(updated).toHaveLength(2);
    expect(updated.every((u) => u.destination === "session")).toBe(true);
    await kill(id);
  });

  it("允许的文件夹不能是主目录或它的上级，也不能碰 Claude 配置目录和本机程序数据目录", async () => {
    for (const p of [homedir(), resolve(homedir(), ".."), join(homedir(), ".claude"), t.dataDir, resolve(t.dataDir, "..")]) {
      pick = p;
      const r = await api(t.port, token, "POST", "/v1/folders/pick", {});
      expect(r.status, p).toBe(400);
      expect(r.body.error.code).toBe("validation");
      // 主目录和它的上级也是 ~/.claude 的上级，本来就会被拦；单列一条是为了提示说得准。
      if (p === homedir()) expect(r.body.error.message).toContain("主目录");
    }
    pick = work;
  });

  it("干净会话排除主目录这一层的 CLAUDE.md 和 .claude；带个人配置时不排除", async () => {
    fake({});
    const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
    const a = await open();
    const ex: string[] = settingsOf(runs(work).at(-1)!.argv).claudeMdExcludes;
    const h = homedir().replace(/\\/g, "/");
    expect(ex.map((e) => e.toLowerCase())).toEqual([`${h}/.claude/**`, `${h}/CLAUDE.md`, `${h}/CLAUDE.local.md`].map((e) => e.toLowerCase()));
    await kill(a);
    const b = await open({ includePersonalConfig: true });
    expect(settingsOf(runs(work).at(-1)!.argv).claudeMdExcludes).toBeUndefined();
    await kill(b);
  });

  it("网关模型：重试 2 次、等响应头 40 秒；每次重试马上提示网页，最后算模型服务的错", async () => {
    await api(t.port, token, "PUT", "/v1/models/gw", { label: "网关", source: "gateway", baseUrl: "https://hub.example.com", model: "m", apiKey: "k" });
    fake({ mode: "gateway_down" });
    const id = await open({ modelProfileId: "gw" });
    const run = runs(work).at(-1)!;
    expect([run.maxRetries, run.apiTimeout]).toEqual(["2", "40000"]);
    const events = await until(async () => {
      const r = await api(t.port, token, "GET", `/v1/sessions/${id}`);
      return r.body.session.status === "idle" && r.body.session.lastSeq;
    });
    expect(events).toBeGreaterThan(0);
    const log = readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.filter((e) => e.type === "notice" && e.code === "api_retry").map((e) => e.text)).toEqual([
      "连不上模型服务（超时或拒绝连接），正在重试（第 1/2 次）", "连不上模型服务（超时或拒绝连接），正在重试（第 2/2 次）",
    ]);
    expect(log.find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "api" });
    await kill(id);
    // 订阅保留 Claude Code 默认重试
    fake({});
    const s = await open();
    expect([runs(work).at(-1)!.maxRetries, runs(work).at(-1)!.apiTimeout]).toEqual([null, null]);
    await kill(s);
  });
});
