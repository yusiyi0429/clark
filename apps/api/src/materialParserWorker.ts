import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import mammoth from "mammoth";

const [path, kind] = process.argv.slice(2);
if (!path || !kind) process.exit(2);

const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_DOCX_ENTRY = 50 * 1024 * 1024;
const MAX_DOCX_RATIO = 200;

function text(value: string): string {
  return value.replace(/\u0000/g, "").trim();
}

async function pdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("不是有效 PDF 文件头");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const document = await task.promise;
  if (document.numPages > 500) throw new Error("PDF 超过 500 页");
  const pages: string[] = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
  }
  return { text: text(pages.join("\n")), pageCount: document.numPages };
}

async function docx(buffer: Buffer): Promise<{ text: string }> {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_DOCX_ENTRIES || !zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) throw new Error("DOCX ZIP 结构不合法");
  let total = 0;
  for (const entry of entries) {
    if (entry.name.includes("..") || entry.name.startsWith("/") || /(^|\/)word\/(media|embeddings)\//.test(entry.name)) throw new Error("DOCX 含不支持的路径、图片或嵌套对象");
    const data = entry as unknown as { _data: { compressedSize?: number; uncompressedSize?: number } };
    const compressed = data._data.compressedSize || 0;
    const size = data._data.uncompressedSize || 0;
    if (size > MAX_DOCX_ENTRY || (compressed > 0 && size / compressed > MAX_DOCX_RATIO)) throw new Error("DOCX ZIP 资源超限");
    if (/\.rels$/i.test(entry.name) && /TargetMode="External"/i.test(await entry.async("text"))) throw new Error("DOCX 含外部资源");
    total += size;
  }
  if (total > MAX_DOCX_UNCOMPRESSED) throw new Error("DOCX 解压资源超限");
  const result = await mammoth.extractRawText({ buffer });
  return { text: text(result.value) };
}

async function markdown(buffer: Buffer): Promise<{ text: string }> {
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/<[^>]*>/g, "") };
}

try {
  const buffer = await readFile(path);
  const result = kind === "application/pdf" ? await pdf(buffer) : kind.includes("wordprocessingml") ? await docx(buffer)
    : await markdown(buffer);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "材料解析失败");
  process.exitCode = 1;
}
