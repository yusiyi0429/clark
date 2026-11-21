import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FormatRegistry } from "@sinclair/typebox";

/** 读 JSON 文件；不存在或坏了就用默认值（本机状态坏了不该让程序起不来）。 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，断电时不会留下半截 JSON。mode 0600：同机其他用户读不到。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** 契约里用了 uuid 和 date-time 两种格式；本机没有 ajv，用 Value.Check 前要先登记。 */
export function registerFormats(): void {
  if (!FormatRegistry.Has("uuid")) {
    FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  }
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set("date-time", (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)));
  }
}

export const nowIso = () => new Date().toISOString();

/**
 * 嵌在程序里的脚本和页面（托盘、测试页）用 String.raw 写。Bun 打包时会把中文改写成 \\uXXXX，
 * 在 String.raw 里它不会被还原，所以用之前在这里还原。这些脚本本身不含 \\u 写法。
 */
export const embedded = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
