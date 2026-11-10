import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_RUNNER_DEFAULT_PORT } from "@warmap/contracts";
import { readJson, writeJsonAtomic } from "./store.js";

export const VERSION = "0.2.0";
export const DEFAULT_ORIGINS = ["https://tk.tokenkingos.com"];
export const DEFAULT_TIANSHU_URL = "https://tk.tokenkingos.com";

/**
 * 本机配置文件 <dataDir>/config.json，本人或运维手改，网页改不了：
 * - allowedOrigins：允许直连的网页来源（整个替换默认值）；extraOrigins：在默认值上追加（本地开发来源放这里）；
 * - port、claudePath（Claude Code 不在默认位置时指定）、tianshuUrl（托盘「打开天枢」去哪）。
 */
export interface FileConfig {
  port?: number;
  allowedOrigins?: string[];
  extraOrigins?: string[];
  claudePath?: string;
  tianshuUrl?: string;
}

export interface RunnerConfig {
  port: number;
  allowedOrigins: string[];
  dataDir: string;
  claudePath: string | null;
  tianshuUrl: string;
  dev: boolean;
  deviceId: string;
}

export function defaultDataDir(): string {
  if (process.env.TIANSHU_LOCAL_HOME) return process.env.TIANSHU_LOCAL_HOME;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Tianshu", "local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Tianshu", "local");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "tianshu-local");
}

export function loadConfig(opts: { dataDir?: string; dev?: boolean; port?: number } = {}): RunnerConfig {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const file = readJson<FileConfig>(join(dataDir, "config.json"), {});
  const port = opts.port ?? file.port ?? LOCAL_RUNNER_DEFAULT_PORT;
  const origins = new Set([...(file.allowedOrigins ?? DEFAULT_ORIGINS), ...(file.extraOrigins ?? [])]);
  // 开发模式下本机自带的测试页从本端口提供，它的来源要放行。
  if (opts.dev) for (const host of ["127.0.0.1", "localhost"]) origins.add(`http://${host}:${port}`);
  const identity = readJson<{ deviceId?: string }>(join(dataDir, "device.json"), {});
  const deviceId = identity.deviceId ?? randomUUID();
  if (!identity.deviceId) writeJsonAtomic(join(dataDir, "device.json"), { deviceId });
  return {
    port,
    allowedOrigins: [...origins].map((o) => o.replace(/\/+$/, "")),
    dataDir,
    claudePath: file.claudePath ?? null,
    tianshuUrl: file.tianshuUrl ?? DEFAULT_TIANSHU_URL,
    dev: Boolean(opts.dev),
    deviceId,
  };
}
