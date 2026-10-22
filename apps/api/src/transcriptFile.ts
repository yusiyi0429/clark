import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { MaterialParseError, runWorker } from "./materialParser.js";
import { htmlToText } from "./meetingEvidence.js";
import {
  FEISHU_TRANSCRIPT_PARSER_VERSION,
  MEETING_NOTES_PARSER_VERSION,
  MIAOJI_MARKDOWN_FORMAT,
  parseFeishuTranscriptText,
  parseMiaojiMarkdown,
  parseSpeakerLines,
  SPEAKER_LINES_PARSER_VERSION,
  splitMeetingNotes,
  TRANSCRIPT_PARSER_VERSION,
  type ParsedTranscriptTurn,
} from "./transcriptMarkdown.js";

/**
 * 主持人上传的会议记录：按扩展名抽出文字，再按固定顺序认格式（确定性，不调模型）。
 * docx / pdf 走材料解析同一个子进程（mammoth、pdfjs，带超时与 ZIP 资源上限）。
 */
export type TranscriptFileKind = "text" | "html" | "docx" | "pdf";
type FileError = { code: string; message: string };

const KINDS: Record<string, TranscriptFileKind> = {
  ".md": "text", ".markdown": "text", ".txt": "text", ".html": "html", ".htm": "html", ".docx": "docx", ".pdf": "pdf",
};

export function transcriptFileKind(fileName: string): { kind: TranscriptFileKind } | FileError {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".doc") return { code: "DOC_NOT_SUPPORTED", message: "请另存为 docx 再上传" };
  const kind = KINDS[extension];
  return kind ? { kind } : { code: "UNSUPPORTED_FILE_TYPE", message: "只收 txt、md、pdf、docx、html" };
}

class TranscriptFileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** 文本文件按 UTF-8 读，去 BOM。 */
export function textFileText(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new TranscriptFileError("INVALID_TRANSCRIPT_ENCODING", "会议记录不是 UTF-8 编码");
  }
}

/** HTML：去 script/style，块级标签与 <br> 变换行，去标签，解实体。 */
export function htmlFileText(buffer: Buffer): string {
  return htmlToText(textFileText(buffer));
}

async function documentText(buffer: Buffer, kind: "docx" | "pdf"): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR || "/tmp", "warmap-transcript-"));
  try {
    const path = join(directory, "upload");
    await writeFile(path, buffer, { mode: 0o600 });
    return (await runWorker(path, kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function extractTranscriptText(file: { fileName: string; buffer: Buffer }): Promise<{ ok: true; kind: TranscriptFileKind; text: string } | ({ ok: false } & FileError)> {
  const detected = transcriptFileKind(file.fileName);
  if (!("kind" in detected)) return { ok: false, ...detected };
  try {
    const raw = detected.kind === "text" ? textFileText(file.buffer) : detected.kind === "html" ? htmlFileText(file.buffer)
      : await documentText(file.buffer, detected.kind);
    // jsonb 存不了空字符
    const text = raw.replace(/\u0000/g, "");
    if (!text.trim()) return { ok: false, code: "EMPTY_TRANSCRIPT", message: "会议记录没有文字" };
    return { ok: true, kind: detected.kind, text };
  } catch (error) {
    if (error instanceof TranscriptFileError || error instanceof MaterialParseError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

export type TranscriptFormat = "miaoji_markdown" | "feishu_text" | "speaker_lines" | "meeting_notes";
export type RecognizedTranscript =
  | { ok: true; format: TranscriptFormat; parserVersion: string; turns: ParsedTranscriptTurn[] }
  | ({ ok: false; line: number | null } & FileError);

/**
 * 识别链，先中先用：妙记 Markdown（有 `### 文字记录` 但结构错仍按原样报错）→ 飞书妙记 txt（第一行日期可有可无）
 * → 通用说话人行 → 都不是就按纪要导入。飞书 txt 与说话人行至少 2 段才认，免得一行带时间或冒号的正文吞掉整份纪要。
 */
export function recognizeTranscript(text: string): RecognizedTranscript {
  const miaoji = parseMiaojiMarkdown(text);
  if (miaoji.ok) return { ok: true, format: MIAOJI_MARKDOWN_FORMAT, parserVersion: TRANSCRIPT_PARSER_VERSION, turns: miaoji.transcript.turns };
  if (miaoji.error.code !== "MISSING_TRANSCRIPT_SECTION") return { ok: false, ...miaoji.error };
  const feishu = parseFeishuTranscriptText(text);
  if (feishu.ok && feishu.transcript.turns.length >= 2) return { ok: true, format: "feishu_text", parserVersion: FEISHU_TRANSCRIPT_PARSER_VERSION, turns: feishu.transcript.turns };
  const speakers = parseSpeakerLines(text);
  if (speakers) return { ok: true, format: "speaker_lines", parserVersion: SPEAKER_LINES_PARSER_VERSION, turns: speakers };
  const notes = splitMeetingNotes(text);
  if (!notes.ok) return { ok: false, ...notes.error };
  return { ok: true, format: "meeting_notes", parserVersion: MEETING_NOTES_PARSER_VERSION, turns: notes.transcript.turns };
}
