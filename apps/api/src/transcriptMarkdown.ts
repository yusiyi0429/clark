/**
 * 妙记 Markdown 逐字稿的确定性 adapter。
 * 只识别「`### 文字记录` 之后的 `姓名 mm:ss` / `姓名 hh:mm:ss` + 后续正文」，
 * 不做 Agent、姓名猜测、格式猜测；结构错误整份拒绝且带行号，不保存部分结果。
 */

export const TRANSCRIPT_PARSER_VERSION = "miaoji-markdown.v1";
export const MIAOJI_MARKDOWN_FORMAT = "miaoji_markdown";
export const TRANSCRIPT_SECTION_HEADING = "### 文字记录";
export const MAX_TRANSCRIPT_TURNS = 2000;
export const MAX_TURN_TEXT_LENGTH = 20000;

export type ParsedTranscriptTurn = { speakerName: string; offsetSeconds: number; text: string };
export type ParsedTranscript = { turns: ParsedTranscriptTurn[] };
export type TranscriptParseError = { code: string; message: string; line: number | null };
export type TranscriptParseResult = { ok: true; transcript: ParsedTranscript } | { ok: false; error: TranscriptParseError };

const HEADER_3 = /^(.+?)\s+(\d{2}):(\d{2}):(\d{2})$/;
const HEADER_2 = /^(.+?)\s+(\d{2}):(\d{2})$/;

type RawTurn = { speakerName: string; offsetSeconds: number; body: string[]; line: number };

function fail(code: string, message: string, line: number | null): TranscriptParseResult {
  return { ok: false, error: { code, message, line } };
}

type HeaderMatch = { kind: "turn"; speakerName: string; offsetSeconds: number } | { kind: "invalid"; message: string } | { kind: "none" };

/** 两段时间解释为 mm:ss（会议可能超过 60 分钟），三段时间为 hh:mm:ss；形状命中但范围非法即结构错误。 */
function classifyHeader(line: string): HeaderMatch {
  const three = HEADER_3.exec(line);
  if (three) {
    const hours = Number(three[2]);
    const minutes = Number(three[3]);
    const seconds = Number(three[4]);
    if (minutes > 59 || seconds > 59) return { kind: "invalid", message: "发言段时间的分或秒超出 0-59" };
    return { kind: "turn", speakerName: three[1].trim(), offsetSeconds: hours * 3600 + minutes * 60 + seconds };
  }
  const two = HEADER_2.exec(line);
  if (two) {
    const minutes = Number(two[2]);
    const seconds = Number(two[3]);
    if (seconds > 59) return { kind: "invalid", message: "发言段时间的秒超出 0-59" };
    return { kind: "turn", speakerName: two[1].trim(), offsetSeconds: minutes * 60 + seconds };
  }
  return { kind: "none" };
}

export function parseMiaojiMarkdown(input: string | Buffer): TranscriptParseResult {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return fail("INVALID_TRANSCRIPT_ENCODING", "Transcript 不是合法 UTF-8", null);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === TRANSCRIPT_SECTION_HEADING);
  if (sectionIndex === -1) {
    return fail("MISSING_TRANSCRIPT_SECTION", `Transcript 缺少 \`${TRANSCRIPT_SECTION_HEADING}\` 段落`, null);
  }

  const raw: RawTurn[] = [];
  let current: RawTurn | null = null;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const header = classifyHeader(line);
    if (header.kind === "invalid") return fail("INVALID_TURN_TIME", header.message, index + 1);
    if (header.kind === "turn") {
      if (!header.speakerName) return fail("INVALID_TURN_HEADER", "发言段缺少说话人姓名", index + 1);
      if (current) raw.push(current);
      current = { ...header, body: [], line: index + 1 };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) raw.push(current);
  if (raw.length === 0) return fail("EMPTY_TRANSCRIPT", "Transcript 没有可解析的发言段", null);
  if (raw.length > MAX_TRANSCRIPT_TURNS) {
    return fail("TOO_MANY_TURNS", `Transcript 最多 ${MAX_TRANSCRIPT_TURNS} 个发言段`, raw[MAX_TRANSCRIPT_TURNS].line);
  }

  const turns: ParsedTranscriptTurn[] = [];
  let lastOffset: number | null = null;
  for (const turn of raw) {
    const body = turn.body.join("\n").trim();
    if (!body) return fail("EMPTY_TURN_TEXT", "发言段正文为空", turn.line);
    if (body.length > MAX_TURN_TEXT_LENGTH) {
      return fail("TURN_TEXT_TOO_LONG", `发言段正文超过 ${MAX_TURN_TEXT_LENGTH} 字符`, turn.line);
    }
    if (lastOffset !== null && turn.offsetSeconds < lastOffset) {
      return fail("TURN_TIME_OUT_OF_ORDER", "发言段相对时间出现倒序", turn.line);
    }
    lastOffset = turn.offsetSeconds;
    turns.push({ speakerName: turn.speakerName, offsetSeconds: turn.offsetSeconds, text: body });
  }
  return { ok: true, transcript: { turns } };
}
