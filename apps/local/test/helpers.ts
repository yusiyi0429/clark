import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRunner, type Runner, type RunnerOptions } from "../src/app.js";
import type { ToolExec } from "../src/tools.js";
import { FileSecretStore } from "../src/secrets.js";
import { HeadlessDesktop, type MenuAction } from "../src/desktop/index.js";

export const ORIGIN = "https://tk.tokenkingos.com";
export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

export function tempDir(prefix = "tl-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function startTestRunner(opts: {
  approvePairing?: boolean; pickFolder?: string | null | (() => string | null); fetchImpl?: typeof fetch; skillsDir?: string; dataDir?: string;
  toolsExec?: ToolExec; holdTiming?: RunnerOptions["holdTiming"]; codexLimits?: RunnerOptions["codexLimits"]; cloneRepo?: RunnerOptions["cloneRepo"];
  /** 换掉默认的假托盘（测由桌面版托管时用）。 */
  desktop?: RunnerOptions["desktop"];
} = {}) {
  // 给 dataDir 时接着用上一次的数据（测重启）
  const dataDir = opts.dataDir ?? tempDir();
  const desktop = new HeadlessDesktop();
  desktop.confirm = async () => opts.approvePairing ?? true;
  desktop.pickFolder = async () => (typeof opts.pickFolder === "function" ? opts.pickFolder() : opts.pickFolder ?? null);
  // 托盘菜单：测试里直接点（暂停、恢复）
  let menu: (a: MenuAction) => void = () => {};
  Object.assign(desktop, { start: async (fn: (a: MenuAction) => void) => { menu = fn; } });
  const runner: Runner = await startRunner({
    dataDir, port: 0 as unknown as number, headless: true, desktop: opts.desktop ?? desktop, secrets: new FileSecretStore(dataDir),
    claudeBin: { command: process.execPath, prefixArgs: [FAKE_CLAUDE] }, fetchImpl: opts.fetchImpl, allowedOrigins: [ORIGIN],
    // 测试不读本人真装的技能
    skillsDir: opts.skillsDir ?? join(dataDir, "no-skills"),
    // 测试不查本人电脑上真装的 gh、lark-cli
    toolsExec: opts.toolsExec ?? (async () => null), holdTiming: opts.holdTiming,
    // 测试不起本人电脑上真装的 Codex：默认当没装
    codexLimits: opts.codexLimits ?? (async () => null), cloneRepo: opts.cloneRepo,
  });
  const port = (runner.server.address() as { port: number }).port;
  runner.config.port = port; // 监听随机端口时，Host 检查要按实际端口
  return {
    runner, dataDir, port,
    menu: (a: MenuAction) => menu(a),
    async cleanup() { await runner.close(); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上偶尔占用 */ } },
  };
}

export interface Raw { status: number; headers: http.IncomingHttpHeaders; body: any }

/** 用 http.request 发原始请求：可以随意伪造 Host、Origin，fetch 做不到。 */
export function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let s = "";
      res.setEncoding("utf8").on("data", (d) => (s += d)).on("end", () => {
        let body: any = s;
        try { body = JSON.parse(s); } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** 按网页的走法配对：发起 → 本机确认（测试里自动通过）→ 轮询拿口令。 */
export async function pair(port: number): Promise<string> {
  const start = await raw(port, { method: "POST", path: "/v1/pairings", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  for (let i = 0; i < 50; i++) {
    const s = await raw(port, { path: `/v1/pairings/${start.body.pairingId}`, headers: { origin: ORIGIN } });
    if (s.body.token) return s.body.token;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("配对没通过");
}

/**
 * 测试开会话没带权限模式时补「每次都问」（default）：这些测试是按每一步都问本人写的（假 claude 每轮都要写文件的权限），
 * 本机的默认是「自动」（会在允许的文件夹里自己放行）。测「自动」等档位的测试自己带 permissionMode。
 */
function askEveryStep(method: string, path: string, body: unknown): unknown {
  const fill = (b: unknown) => (b && typeof b === "object" && !("permissionMode" in b) ? { ...b, permissionMode: "default" } : b);
  if (method !== "POST") return body;
  if (path === "/v1/sessions") return fill(body);
  if (path === "/v1/sessions/batch" && body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    return { ...body, items: (body as { items: unknown[] }).items.map(fill) };
  }
  return body;
}

export function api(port: number, token: string, method: string, path: string, body?: unknown): Promise<Raw> {
  body = askEveryStep(method, path, body);
  return raw(port, {
    method, path,
    headers: { origin: ORIGIN, "x-tianshu-local-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 一个有提交、有远端的 git 仓库（规划员开拆前的检查要看到「是仓库、不是空的」，设计 18.11）。远端只是地址，不连。 */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "readme.md"), "项目\n");
  g("add", ".");
  g("-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
  g("remote", "add", "origin", "https://github.com/example/project.git");
  return dir;
}
