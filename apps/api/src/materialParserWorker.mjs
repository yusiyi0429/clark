import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import mammoth from "mammoth";
import { pdfText } from "./materialPdfText.mjs";

const [path, kind] = process.argv.slice(2);
if (!path || !kind) process.exit(2);
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_DOCX_ENTRY = 50 * 1024 * 1024;
const MAX_DOCX_RATIO = 200;
const clean = (value) => value.replace(/\u0000/g, "").trim();

async function parsePdf(buffer) {
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("不是有效 PDF 文件头");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const document = await task.promise;
  if (document.numPages > 500) throw new Error("PDF 超过 500 页");
  // 逐页取文字块，按 hasEOL 断行、按行距分段（materialPdfText.mjs），页与页之间空一行。
  const pages = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    pages.push(content.items);
  }
  return { text: clean(pdfText(pages)), pageCount: document.numPages };
}

/** .rels 里有没有超链接以外的外部关系（TargetMode="External"）。 */
function externalNonHyperlink(xml) {
  return (xml.match(/<Relationship\b[^>]*>/gi) ?? []).some((tag) => /TargetMode\s*=\s*"External"/i.test(tag)
    && !/Type\s*=\s*"[^"]*\/hyperlink"/i.test(tag));
}

async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_DOCX_ENTRIES || !zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) throw new Error("DOCX ZIP 结构不合法");
  let total = 0;
  for (const entry of entries) {
    // 图片（word/media）只是不读；嵌入对象（word/embeddings，OLE 等）仍拒收。
    if (entry.name.includes("..") || entry.name.startsWith("/") || /(^|\/)word\/embeddings\//.test(entry.name)) throw new Error("DOCX 含不支持的路径或嵌入对象");
    const { compressedSize = 0, uncompressedSize = 0 } = entry._data;
    if (uncompressedSize > MAX_DOCX_ENTRY || (compressedSize > 0 && uncompressedSize / compressedSize > MAX_DOCX_RATIO)) throw new Error("DOCX ZIP 资源超限");
    // 外部关系只放行超链接（研究报告的来源链接）；外部模板、外链图片、外部对象等仍拒收。
    if (/\.rels$/i.test(entry.name) && externalNonHyperlink(await entry.async("text"))) throw new Error("DOCX 含外部资源");
    total += uncompressedSize;
  }
  if (total > MAX_DOCX_UNCOMPRESSED) throw new Error("DOCX 解压资源超限");
  return { text: clean((await mammoth.extractRawText({ buffer })).value) };
}

try {
  const buffer = await readFile(path);
  const result = kind === "application/pdf" ? await parsePdf(buffer) : kind.includes("wordprocessingml") ? await parseDocx(buffer)
    : { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/<[^>]*>/g, "") };
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "材料解析失败");
  process.exitCode = 1;
}
