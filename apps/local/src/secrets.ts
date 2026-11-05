import { spawn } from "node:child_process";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./store.js";

/**
 * 钥匙（TokenHub 等网关钥匙、云端同步令牌）只存在本机，任何接口都不回传（ADR：钥匙存储）。
 * - Windows：DPAPI（CurrentUser）加密后存 secrets.json；只有本人登录 Windows 时能解开。
 * - macOS：登录钥匙串，服务名 tianshu-local。
 * - 其他平台和测试：0600 文件（明文），只作兜底。
 * 明文从不出现在命令行参数里：加解密都走子进程的 stdin/stdout。
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

function run(cmd: string, args: string[], input: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(input);
  });
}

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const DPAPI_PROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, 'CurrentUser'))";
const DPAPI_UNPROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s), $null, 'CurrentUser')))";

class DpapiStore implements SecretStore {
  private readonly file: string;
  private readonly cache = new Map<string, string>();
  constructor(dataDir: string) { this.file = join(dataDir, "secrets.json"); }

  async get(name: string): Promise<string | null> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const blob = readJson<Record<string, string>>(this.file, {})[name];
    if (!blob) return null;
    const r = await run("powershell.exe", [...PS, DPAPI_UNPROTECT], blob);
    if (r.code !== 0) throw new Error("本机钥匙解密失败（DPAPI）");
    this.cache.set(name, r.out);
    return r.out;
  }

  async set(name: string, value: string): Promise<void> {
    const r = await run("powershell.exe", [...PS, DPAPI_PROTECT], value);
    if (r.code !== 0 || !r.out.trim()) throw new Error("本机钥匙加密失败（DPAPI）");
    const all = readJson<Record<string, string>>(this.file, {});
    all[name] = r.out.trim();
    writeJsonAtomic(this.file, all);
    this.cache.set(name, value);
  }

  async delete(name: string): Promise<void> {
    const all = readJson<Record<string, string>>(this.file, {});
    delete all[name];
    writeJsonAtomic(this.file, all);
    this.cache.delete(name);
  }
}

const SERVICE = "tianshu-local";
/** `security -i` 从 stdin 读命令，钥匙不进 argv（macOS 上 ps 能看到别人的 argv）。 */
const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

class KeychainStore implements SecretStore {
  private readonly cache = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], "");
    if (r.code !== 0) return null;
    const v = r.out.replace(/\n$/, "");
    this.cache.set(name, v);
    return v;
  }
  async set(name: string, value: string): Promise<void> {
    const r = await run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${quote(name)} -w ${quote(value)}\n`);
    if (r.code !== 0) throw new Error("写入钥匙串失败");
    this.cache.set(name, value);
  }
  async delete(name: string): Promise<void> {
    await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name], "");
    this.cache.delete(name);
  }
}

export class FileSecretStore implements SecretStore {
  private readonly file: string;
  constructor(dataDir: string) { this.file = join(dataDir, "secrets.plain.json"); }
  async get(name: string) { return readJson<Record<string, string>>(this.file, {})[name] ?? null; }
  async set(name: string, value: string) { const all = readJson<Record<string, string>>(this.file, {}); all[name] = value; writeJsonAtomic(this.file, all); }
  async delete(name: string) { const all = readJson<Record<string, string>>(this.file, {}); delete all[name]; writeJsonAtomic(this.file, all); }
}

export function createSecretStore(dataDir: string): SecretStore {
  if (process.env.TIANSHU_LOCAL_PLAIN_SECRETS === "1") return new FileSecretStore(dataDir);
  if (process.platform === "win32") return new DpapiStore(dataDir);
  if (process.platform === "darwin") return new KeychainStore();
  return new FileSecretStore(dataDir);
}
