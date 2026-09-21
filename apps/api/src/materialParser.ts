import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";

export const MAX_MATERIAL_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MATERIAL_BATCH_BYTES = 100 * 1024 * 1024;
export const MAX_MATERIAL_FILES = 10;
export const MAX_MATERIAL_TEXT_CHARS = 100_000;
export const MAX_PREFLIGHT_MATERIAL_CHARS = 300_000;
const FILE_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;

export type ParsedMaterial = {
  fileName: string;
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/markdown";
  sizeBytes: number;
  pageCount?: number;
  extractedText: string;
  sha256: string;
  tempPath: string;
};

export class MaterialParseError extends Error {
  constructor(message: string, public readonly code = "INVALID_MATERIAL") {
    super(message);
  }
}

function safeName(name: string): string {
  const value = basename(name).replace(/[\u0000-\u001f/\\]/g, "_").trim();
  if (!value || value.length > 240) throw new MaterialParseError("文件名不合法", "INVALID_MATERIAL_NAME");
  return value;
}

function kindFor(name: string, mime: string): ParsedMaterial["mimeType"] {
  const extension = extname(name).toLowerCase();
  if (extension === ".pdf" && (mime === "application/pdf" || mime === "application/octet-stream")) return "application/pdf";
  if (extension === ".docx" && (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || mime === "application/octet-stream")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".md" && (mime.startsWith("text/") || mime === "application/octet-stream")) return "text/markdown";
  throw new MaterialParseError("仅支持 PDF、DOCX 和 Markdown（.md）", "UNSUPPORTED_MATERIAL_TYPE");
}

function runWorker(path: string, kind: ParsedMaterial["mimeType"]): Promise<{ text: string; pageCount?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", new URL("./materialParserWorker.mjs", import.meta.url).pathname, path, kind], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, FILE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new MaterialParseError("材料解析超过 15 秒", "MATERIAL_PARSE_TIMEOUT"));
      if (code !== 0) return reject(new MaterialParseError(stderr.trim() || "材料解析失败", "MATERIAL_PARSE_FAILED"));
      try {
        const result = JSON.parse(stdout) as { text?: unknown; pageCount?: unknown };
        if (typeof result.text !== "string") throw new Error("invalid worker output");
        resolve({ text: result.text, ...(typeof result.pageCount === "number" ? { pageCount: result.pageCount } : {}) });
      } catch {
        reject(new MaterialParseError("材料解析结果无效", "MATERIAL_PARSE_FAILED"));
      }
    });
  });
}

/** 在调用方临时目录内顺序校验；成功后文件仍留在 tempPath，供同一批原子落盘。 */
export async function parseMaterialBatch(files: { filename: string; mimetype: string; buffer: Buffer }[]): Promise<{ directory: string; materials: ParsedMaterial[] }> {
  if (files.length > MAX_MATERIAL_FILES) throw new MaterialParseError(`每批最多 ${MAX_MATERIAL_FILES} 份文件`, "MATERIAL_BATCH_TOO_LARGE");
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (total > MAX_MATERIAL_BATCH_BYTES) throw new MaterialParseError("材料总大小超过 100 MiB", "MATERIAL_BATCH_TOO_LARGE");
  const directory = await mkdtemp(join(process.env.TMPDIR || "/tmp", "warmap-material-"));
  const started = Date.now();
  try {
    const materials: ParsedMaterial[] = [];
    for (const file of files) {
      if (Date.now() - started > 90_000) throw new MaterialParseError("整批材料解析超过 90 秒", "MATERIAL_BATCH_TIMEOUT");
      if (file.buffer.length === 0 || file.buffer.length > MAX_MATERIAL_FILE_BYTES) throw new MaterialParseError("单个材料必须在 1–20 MiB 内", "MATERIAL_FILE_TOO_LARGE");
      const fileName = safeName(file.filename);
      const mimeType = kindFor(fileName, file.mimetype);
      const tempPath = join(directory, randomUUID());
      await writeFile(tempPath, file.buffer, { mode: 0o600 });
      const result = await runWorker(tempPath, mimeType);
      const extractedText = result.text.trim();
      if (!extractedText) throw new MaterialParseError("材料没有可用文字层", "MATERIAL_NO_TEXT");
      if (extractedText.length > MAX_MATERIAL_TEXT_CHARS) throw new MaterialParseError("材料抽取文字超过 100,000 字符", "MATERIAL_TEXT_TOO_LARGE");
      materials.push({ fileName, mimeType, sizeBytes: file.buffer.length, extractedText, sha256: createHash("sha256").update(file.buffer).digest("hex"), tempPath, ...(result.pageCount ? { pageCount: result.pageCount } : {}) });
    }
    if (materials.reduce((sum, material) => sum + material.extractedText.length, 0) > MAX_PREFLIGHT_MATERIAL_CHARS) {
      throw new MaterialParseError("材料预审文本超过 300,000 字符", "MATERIAL_TEXT_TOO_LARGE");
    }
    return { directory, materials };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function ensureMaterialStorage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function cleanupMaterialTemp(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function readStoredMaterial(storageDir: string, storageKey: string): Promise<Buffer> {
  if (!/^[0-9a-f-]+\/[0-9a-f-]+$/.test(storageKey)) throw new MaterialParseError("材料存储键无效", "MATERIAL_NOT_FOUND");
  return readFile(join(storageDir, storageKey));
}
