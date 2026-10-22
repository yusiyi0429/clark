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

export const FEISHU_TRANSCRIPT_PARSER_VERSION = "feishu-minutes-txt.v1";
/** 发言头只认「姓名 hh:mm:ss(.mmm)」：姓名不超过 40 字、不带句读，免得把正文里「定在 10:30:00」当成发言头。 */
const FEISHU_HEADER = /^([^，。？！,.?!：:]{1,40}?)\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.\d{1,3})?\s*$/;
const FEISHU_START = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*(CST|UTC\+0?8:?0{0,2})?\b/;

/**
 * 飞书妙记开放接口导出的逐字稿（txt）：第一行「2026-10-12 09:20:02 CST|26min 25s」，然后是关键词，
 * 之后每段「姓名 hh:mm:ss.mmm」加正文。第一段发言之前的内容不要；超过上限时把相邻同一人的发言并成一段（引文仍在同一段里连续）。
 * startedAt：第一行的开会时刻（按北京时间）；没有就是 null。
 */
export function parseFeishuTranscriptText(text: string): TranscriptParseResult & { startedAt?: string | null } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  // 开会时刻在开头几行里（前面可能还有一行标题）。
  const start = lines.slice(0, 6).map((line) => FEISHU_START.exec(line.trim())).find(Boolean) ?? null;
  const startedAt = start ? new Date(`${start[1]}T${start[2]}+08:00`).toISOString() : null;
  const raw: RawTurn[] = [];
  let current: RawTurn | null = null;
  for (const [index, line] of lines.entries()) {
    const match = FEISHU_HEADER.exec(line);
    const speakerName = match?.[1].trim() ?? "";
    if (match && speakerName && !/^\d{4}-\d{2}-\d{2}$/.test(speakerName) && Number(match[3]) < 60 && Number(match[4]) < 60) {
      const offsetSeconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
      if (current) raw.push(current);
      current = { speakerName, offsetSeconds, body: [], line: index + 1 };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) raw.push(current);
  let turns: ParsedTranscriptTurn[] = raw
    .map((turn) => ({ speakerName: turn.speakerName, offsetSeconds: turn.offsetSeconds, text: turn.body.join("\n").trim() }))
    .filter((turn) => turn.text);
  if (turns.length > MAX_TRANSCRIPT_TURNS) {
    const merged: ParsedTranscriptTurn[] = [];
    for (const turn of turns) {
      const last = merged.at(-1);
      if (last && last.speakerName === turn.speakerName && last.text.length + turn.text.length < MAX_TURN_TEXT_LENGTH) last.text += `\n${turn.text}`;
      else merged.push({ ...turn });
    }
    turns = merged;
  }
  if (!turns.length) return { ...fail("EMPTY_TRANSCRIPT", "妙记逐字稿没有可解析的发言段", null), startedAt };
  if (turns.length > MAX_TRANSCRIPT_TURNS) return { ...fail("TOO_MANY_TURNS", `逐字稿最多 ${MAX_TRANSCRIPT_TURNS} 个发言段`, null), startedAt };
  for (const [index, turn] of turns.entries()) {
    if (turn.text.length > MAX_TURN_TEXT_LENGTH) return { ...fail("TURN_TEXT_TOO_LONG", `发言段正文超过 ${MAX_TURN_TEXT_LENGTH} 字符`, null), startedAt };
    if (index > 0 && turn.offsetSeconds < turns[index - 1].offsetSeconds) return { ...fail("TURN_TIME_OUT_OF_ORDER", "发言段相对时间出现倒序", null), startedAt };
  }
  return { ok: true, transcript: { turns }, startedAt };
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

export const SPEAKER_LINES_PARSER_VERSION = "speaker-lines.v1";
export const MEETING_NOTES_PARSER_VERSION = "meeting-notes.v1";
export const MEETING_NOTES_SPEAKER = "会议纪要";
/** 说话人行：姓名不超过 20 字、不带句读；「姓名：内容」或独占一行的「姓名 mm:ss / hh:mm:ss(.mmm)」。 */
const COLON_LINE = /^([^，。？！,.?!：:；;]{1,20}?)\s*[：:]\s*(\S.*)$/;
const TIME_HEADER = /^([^，。？！,.?!：:；;]{1,20}?)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?\s*$/;
/** 说话人行至少占非空行的这个比例才算逐字稿（时间头算上它后面那行正文）。 */
const SPEAKER_COVERAGE = 0.6;

/**
 * 没有 `### 文字记录` 标题的通用说话人格式（确定性，不猜）：每行「姓名：内容」，或「姓名 00:01:02」独占一行后接正文。
 * 至少 2 段、说话人行覆盖大部分非空行才认；否则返回 null 交给下一种。第一段之前的内容（标题、日期）不要。
 */
export function parseSpeakerLines(text: string): ParsedTranscriptTurn[] | null {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim()).length;
  for (const style of ["colon", "time"] as const) {
    const raw: { speakerName: string; offsetSeconds: number; body: string[] }[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const colon = style === "colon" ? COLON_LINE.exec(trimmed) : null;
      const time = style === "time" ? TIME_HEADER.exec(trimmed) : null;
      const speakerName = (colon ?? time)?.[1].trim();
      if (speakerName && !(time && (Number(time[3]) > 59 || Number(time[4] ?? 0) > 59))) {
        const offsetSeconds = !time ? 0 : time[4] === undefined ? Number(time[2]) * 60 + Number(time[3])
          : Number(time[2]) * 3600 + Number(time[3]) * 60 + Number(time[4]);
        raw.push({ speakerName, offsetSeconds, body: colon ? [colon[2]] : [] });
      } else if (raw.length) raw.at(-1)!.body.push(line);
    }
    const turns = raw.map((turn) => ({ speakerName: turn.speakerName, offsetSeconds: turn.offsetSeconds, text: turn.body.join("\n").trim() }));
    const covered = raw.length * (style === "time" ? 2 : 1);
    if (raw.length < 2 || covered < nonEmpty * SPEAKER_COVERAGE) continue;
    if (turns.length > MAX_TRANSCRIPT_TURNS || turns.some((turn, index) => !turn.text || turn.text.length > MAX_TURN_TEXT_LENGTH
      || (index > 0 && turn.offsetSeconds < turns[index - 1].offsetSeconds))) continue;
    return turns;
  }
  return null;
}

/**
 * 认不出说话人的会议记录按纪要导入：空行分段，每段一个「会议纪要」发言、offset 都是 0；
 * 超过单段上限的段按上限切开，段数超过上限时把相邻段并到单段上限以内。
 */
export function splitMeetingNotes(text: string): TranscriptParseResult {
  const pieces = text.split(/\r?\n[ \t]*\r?\n/).map((part) => part.trim()).filter(Boolean)
    .flatMap((part) => Array.from({ length: Math.ceil(part.length / MAX_TURN_TEXT_LENGTH) }, (_, index) => part.slice(index * MAX_TURN_TEXT_LENGTH, (index + 1) * MAX_TURN_TEXT_LENGTH)));
  let paragraphs = pieces;
  if (paragraphs.length > MAX_TRANSCRIPT_TURNS) {
    paragraphs = [];
    for (const piece of pieces) {
      const last = paragraphs.at(-1);
      if (last !== undefined && last.length + piece.length + 2 <= MAX_TURN_TEXT_LENGTH) paragraphs[paragraphs.length - 1] = `${last}\n\n${piece}`;
      else paragraphs.push(piece);
    }
  }
  if (!paragraphs.length) return fail("EMPTY_TRANSCRIPT", "会议记录没有文字", null);
  if (paragraphs.length > MAX_TRANSCRIPT_TURNS) return fail("TOO_MANY_TURNS", `会议记录最多 ${MAX_TRANSCRIPT_TURNS} 段`, null);
  return { ok: true, transcript: { turns: paragraphs.map((paragraph) => ({ speakerName: MEETING_NOTES_SPEAKER, offsetSeconds: 0, text: paragraph })) } };
}
