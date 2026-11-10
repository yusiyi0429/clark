import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { childEnv } from "./claudeEnv.js";

type Json = Record<string, any>;

/** 可执行文件：正式是 Codex 的 codex.js（经 node）或 codex；测试用 node + 假脚本。 */
export interface CodexBin { command: string; prefixArgs: string[] }

/**
 * 找本机装的 Codex。Windows 上 npm 装的是 codex.cmd 外壳，经 shell 起会把参数拼进命令行（模型名、地址都在参数里），
 * 所以直接用 node 跑同目录 node_modules 里的 codex.js（它再起原生的 codex.exe）。别的系统 codex 就是可执行文件。没装回 null。
 */
export function findCodexBin(env: NodeJS.ProcessEnv = process.env): CodexBin | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (process.platform === "win32") {
      const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(join(dir, "codex.cmd")) && existsSync(js)) return { command: "node", prefixArgs: [js] };
    } else if (existsSync(join(dir, "codex"))) {
      return { command: join(dir, "codex"), prefixArgs: [] };
    }
  }
  return null;
}

/**
 * Codex 子进程的环境变量：同 Claude Code 的白名单（不继承桌面应用注入的钥匙），不带 OPENAI_API_KEY 这类（免得按 API 计费），
 * 天枢专用的配置目录经 CODEX_HOME 传（没给就用本人的 ~/.codex）。
 */
export function codexEnv(base: NodeJS.ProcessEnv, home: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return childEnv(base, { ...(home ? { CODEX_HOME: home } : {}), ...extra });
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/**
 * codex app-server 的 JSON-RPC（stdio，一行一条，省略 "jsonrpc"；RFC 附录 E）：
 * 同时带 id 和 method 的是它发来的请求（id 是它自己的序号，会和我们的重号），只带 id 的是对我们请求的回复，只带 method 的是通知。
 */
export class CodexRpc {
  private buf = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly notifyFns: ((method: string, params: Json) => void)[] = [];
  private readonly requestFns: ((id: number | string, method: string, params: Json) => void)[] = [];
  exited = false;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8").on("data", (d: string) => this.onData(d));
    child.stdin.on("error", () => { /* 进程已退出时写 stdin 会 EPIPE，由 exit 处理 */ });
    child.on("exit", () => {
      this.exited = true;
      for (const w of this.waiting.values()) w.reject(new CodexRpcError(-1, "Codex 退出了"));
      this.waiting.clear();
    });
  }

  onNotification(fn: (method: string, params: Json) => void) { this.notifyFns.push(fn); }
  onServerRequest(fn: (id: number | string, method: string, params: Json) => void) { this.requestFns.push(fn); }

  private write(o: Json) {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  request<T = Json>(method: string, params: Json = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.exited) return reject(new CodexRpcError(-1, "Codex 退出了"));
      const t = setTimeout(() => { this.waiting.delete(id); reject(new CodexRpcError(-2, `Codex 没有回 ${method}`)); }, timeoutMs);
      t.unref?.();
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json = {}) { this.write({ method, params }); }
  respond(id: number | string, result: Json) { this.write({ id, result }); }
  respondError(id: number | string, message: string) { this.write({ id, error: { code: -32601, message } }); }

  private onData(d: string) {
    this.buf += d;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Json;
      try { m = JSON.parse(line); } catch { continue; }
      if (typeof m.method === "string" && m.id !== undefined) for (const fn of this.requestFns) fn(m.id, m.method, m.params ?? {});
      else if (typeof m.method === "string") for (const fn of this.notifyFns) fn(m.method, m.params ?? {});
      else if (typeof m.id === "number") {
        const w = this.waiting.get(m.id);
        if (!w) continue;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new CodexRpcError(Number(m.error.code) || 0, String(m.error.message ?? "Codex 报错")));
        else w.resolve(m.result ?? {});
      }
    }
  }

  close() { if (!this.exited) this.child.stdin.end(); }
}

/** 起一个 codex app-server 并握手，回执里的 userAgent 带版本（如 tianshu_local/0.159.2 (Windows …)）。起不来抛错。 */
export async function openCodex(bin: CodexBin, env: Record<string, string>, opts: { cwd?: string; args?: string[]; detached?: boolean } = {}): Promise<{ rpc: CodexRpc; version: string }> {
  const child = spawn(bin.command, [...bin.prefixArgs, "app-server", ...(opts.args ?? [])], {
    cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: opts.detached ?? false,
  });
  const spawned = await new Promise<Error | null>((resolve) => { child.once("spawn", () => resolve(null)); child.once("error", (e) => resolve(e)); });
  if (spawned) throw spawned;
  const rpc = new CodexRpc(child);
  try {
    const init = await rpc.request<Json>("initialize", { clientInfo: { name: "tianshu_local", title: "天枢本机程序", version: "1" }, capabilities: { experimentalApi: false } }, 60_000);
    rpc.notify("initialized");
    const version = /\/(\d+\.\d+\.\d+)/.exec(String(init.userAgent ?? ""))?.[1] ?? "";
    return { rpc, version };
  } catch (e) {
    rpc.close();
    try { child.kill(); } catch { /* 已退出 */ }
    throw e;
  }
}

/** 起一个 app-server 做一件事就关（读额度、读模型目录、读登录状态）：不开对话、不花 token。 */
export async function withCodex<T>(bin: CodexBin, env: Record<string, string>, fn: (rpc: CodexRpc) => Promise<T>): Promise<T> {
  const { rpc } = await openCodex(bin, env);
  try { return await fn(rpc); } finally {
    rpc.close();
    setTimeout(() => { try { rpc.child.kill(); } catch { /* 已退出 */ } }, 2_000).unref();
  }
}
