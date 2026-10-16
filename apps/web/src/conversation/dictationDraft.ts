/**
 * 听写时输入框里的文字怎么合并（纯函数，可单测；调研 §5.2「固定插入点」）。
 *
 * 输入框 = 一串片段：用户自己的文字（user）和这次听写出来的句子（asr）。开始时按光标把原文切成
 * head（光标前）和 tail（光标后）两个 user 片段，插入点（anchor）在两者之间；之后每来一句新的识别结果，
 * 就插在 anchor 处、anchor 往后挪 —— 文字只在插入点长，不跳到别处。
 *
 * - 同一句（同一个 key）的识别结果原地替换，定稿（slice_type=2）以定稿为准。
 * - 用户改字：按前后差异找到改动碰到的片段。只改 user 片段 → 照改；碰到 asr 片段 → 这几段合并、冻结成
 *   user 文字，之后同一句再来的结果不再覆盖它（如果新结果是冻结时那段的延续，延续的部分接在后面）。
 * - asr 片段（不管定稿没有）都带下划线；整理好的句子换成 user 片段（polished 标记），下划线消失。
 * - 整段整理（停下后）：这次听写插入的范围（head 和插入点之间）里只有识别出的句子和整理替换过的句子、
 *   没有用户自己打的或改过的字时，才整段换成整理结果；用户在这段里动过字就不整段替换（不覆盖手改）。
 */

/** polished：整理替换进来的（不是用户打的）；用户一改这段，这个标记就没了。 */
export type UserPiece = { kind: "user"; text: string; polished?: true };
export type AsrPiece = { kind: "asr"; key: string; text: string; stable: boolean };
export type Piece = UserPiece | AsrPiece;

export type Draft = {
  pieces: Piece[];
  /** 新的句子插在 pieces[anchor] 之前。 */
  anchor: number;
  /** 被用户改过（或已整理替换）的句子：key → 冻结时那句识别出的样子。 */
  frozen: Record<string, string>;
  /** 听写开始前的原文（Esc / ✕ 恢复用）。 */
  original: string;
};

export type Mark = { start: number; end: number };

export function createDraft(value: string, caret = value.length): Draft {
  const at = Math.max(0, Math.min(caret, value.length));
  return { pieces: [{ kind: "user", text: value.slice(0, at) }, { kind: "user", text: value.slice(at) }], anchor: 1, frozen: {}, original: value };
}

export function renderDraft(draft: Draft): { value: string; marks: Mark[] } {
  let value = "";
  const marks: Mark[] = [];
  for (const piece of draft.pieces) {
    const start = value.length;
    value += piece.text;
    if (piece.kind !== "asr" || !piece.text) continue;
    const last = marks[marks.length - 1];
    if (last && last.end === start) last.end = value.length;
    else marks.push({ start, end: value.length });
  }
  return { value, marks };
}

/** 插入点在整段文字里的位置（这次听写最后一句的末尾）。 */
export function anchorOffset(draft: Draft): number {
  return draft.pieces.slice(0, draft.anchor).reduce((sum, piece) => sum + piece.text.length, 0);
}

/** 来了一句识别结果。 */
export function applySlice(draft: Draft, key: string, text: string, stable: boolean): Draft {
  if (key in draft.frozen) {
    // 用户改过这句：只把「冻结时那段之后新说的」接上去，前面的不再覆盖。
    const seen = draft.frozen[key];
    if (!text.startsWith(seen) || text.length === seen.length) return draft;
    return applySlice(draft, `${key}~`, text.slice(seen.length), stable);
  }
  const at = draft.pieces.findIndex((piece) => piece.kind === "asr" && piece.key === key);
  if (at >= 0) {
    const pieces = draft.pieces.slice();
    pieces[at] = { kind: "asr", key, text, stable };
    return { ...draft, pieces };
  }
  if (!text) return draft;
  const pieces = draft.pieces.slice();
  pieces.splice(draft.anchor, 0, { kind: "asr", key, text, stable });
  return { ...draft, pieces, anchor: draft.anchor + 1 };
}

/** 去掉还没定稿的句子（断线重连 / 后备补出文字时，这几句会被重新识别）。match 为空时去掉全部。 */
export function dropUnstable(draft: Draft, match: (key: string) => boolean = () => true): Draft {
  let anchor = draft.anchor;
  const pieces: Piece[] = [];
  draft.pieces.forEach((piece, index) => {
    if (piece.kind === "asr" && !piece.stable && match(piece.key)) {
      if (index < draft.anchor) anchor -= 1;
      return;
    }
    pieces.push(piece);
  });
  return { ...draft, pieces, anchor };
}

/** 停下了：还没定稿的句子按现在的样子收下。 */
export function finalizeDraft(draft: Draft): Draft {
  return { ...draft, pieces: draft.pieces.map((piece) => (piece.kind === "asr" && !piece.stable ? { ...piece, stable: true } : piece)) };
}

/** 两段文字的差异：prev[start, oldEnd) 换成 insert。 */
export function diffText(prev: string, next: string): { start: number; oldEnd: number; insert: string } {
  let start = 0;
  const limit = Math.min(prev.length, next.length);
  while (start < limit && prev[start] === next[start]) start++;
  let suffix = 0;
  while (suffix < limit - start && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return { start, oldEnd: prev.length - suffix, insert: next.slice(start, next.length - suffix) };
}

/** 用户在输入框里改了字（next 是改完的整段）。 */
export function applyEdit(draft: Draft, next: string): Draft {
  const prev = renderDraft(draft).value;
  if (prev === next) return draft;
  const { start, oldEnd, insert } = diffText(prev, next);
  const starts: number[] = [];
  let offset = 0;
  for (const piece of draft.pieces) {
    starts.push(offset);
    offset += piece.text.length;
  }
  const ends = draft.pieces.map((piece, index) => starts[index] + piece.text.length);
  let first: number;
  let last: number;
  if (start === oldEnd) {
    // 纯插入：落在左边那段里（接在一句的末尾 = 改的是那一句；接在 head 末尾 = 改的是原文）。
    first = ends.findIndex((end) => start <= end);
    if (first < 0) first = draft.pieces.length - 1;
    last = first;
  } else {
    first = ends.findIndex((end) => end > start);
    last = starts.reduce((found, begin, index) => (begin < oldEnd ? index : found), first);
  }
  const head = draft.pieces[first].text.slice(0, start - starts[first]);
  const rest = draft.pieces[last].text.slice(oldEnd - starts[last]);
  const merged: UserPiece = { kind: "user", text: `${head}${insert}${rest}` };
  const pieces = draft.pieces.slice();
  const frozen = { ...draft.frozen };
  for (const piece of pieces.slice(first, last + 1)) if (piece.kind === "asr") frozen[piece.key] = piece.text;
  if (first === last && pieces[first].kind === "user") {
    pieces[first] = merged;
    return { ...draft, pieces };
  }
  pieces.splice(first, last - first + 1, merged);
  let anchor = draft.anchor;
  if (anchor > last) anchor -= last - first;
  else if (anchor > first) anchor = first + 1;
  return { ...draft, pieces, anchor, frozen };
}

/** 送整理的一段：连续的几句定稿。以改口词开头的句子并进上一句一起整理（「两点。不对，三点」）。 */
export type PolishUnit = { keys: string[]; text: string };

const CORRECTION_LEAD = /^[\s，,。、]*(不对|说错|我是说|哦不|应该是|更正|不是)/;

export function polishUnits(draft: Draft): PolishUnit[] {
  const units: PolishUnit[] = [];
  let previous: PolishUnit | null = null;
  for (const piece of draft.pieces) {
    if (piece.kind !== "asr" || !piece.stable || !piece.text.trim()) {
      previous = null;
      continue;
    }
    if (previous && CORRECTION_LEAD.test(piece.text)) {
      previous.keys.push(piece.key);
      previous.text += piece.text;
      continue;
    }
    previous = { keys: [piece.key], text: piece.text };
    units.push(previous);
  }
  return units;
}

/** 整理好了：这几句还原样在（用户没动过）就原地换成整理后的文字（不再带下划线）；否则不动。 */
export function applyPolished(draft: Draft, unit: PolishUnit, polished: string): Draft {
  const first = draft.pieces.findIndex((piece) => piece.kind === "asr" && piece.key === unit.keys[0]);
  if (first < 0) return draft;
  const span = draft.pieces.slice(first, first + unit.keys.length);
  const intact = span.length === unit.keys.length && span.every((piece, index) => piece.kind === "asr" && piece.stable && piece.key === unit.keys[index]);
  if (!intact || span.map((piece) => piece.text).join("") !== unit.text) return draft;
  const pieces = draft.pieces.slice();
  const frozen = { ...draft.frozen };
  for (const piece of span) frozen[(piece as AsrPiece).key] = piece.text;
  const last = first + unit.keys.length - 1;
  pieces.splice(first, unit.keys.length, { kind: "user", text: polished, polished: true });
  let anchor = draft.anchor;
  if (anchor > last) anchor -= last - first;
  else if (anchor > first) anchor = first + 1;
  return { ...draft, pieces, anchor, frozen };
}

/** 这次听写插入的范围：pieces[from, to)，在 head（第 0 段）和插入点之间。 */
export type DictatedSpan = { from: number; to: number; text: string };

/**
 * 整段整理要送的范围。范围里有用户打的或改过的字（没有 polished 标记的 user 片段）、还没定稿的句子，
 * 或者什么都没说时返回 null（不整段整理）。
 */
export function dictatedSpan(draft: Draft): DictatedSpan | null {
  const from = 1;
  const to = draft.anchor;
  if (to <= from) return null;
  const span = draft.pieces.slice(from, to);
  const clean = span.every((piece) => (piece.kind === "asr" ? piece.stable : piece.polished === true || !piece.text));
  const text = span.map((piece) => piece.text).join("");
  return clean && text.trim() ? { from, to, text } : null;
}

/** 整段整理好了：范围还是送出去时的样子（用户没动过）就整段换成整理结果（不带下划线）；否则不动。 */
export function applyFullPolish(draft: Draft, sent: DictatedSpan, polished: string): Draft {
  const now = dictatedSpan(draft);
  if (!now || now.from !== sent.from || now.to !== sent.to || now.text !== sent.text || polished === sent.text) return draft;
  const frozen = { ...draft.frozen };
  for (const piece of draft.pieces.slice(sent.from, sent.to)) if (piece.kind === "asr") frozen[piece.key] = piece.text;
  const pieces = draft.pieces.slice();
  pieces.splice(sent.from, sent.to - sent.from, { kind: "user", text: polished, polished: true });
  return { ...draft, pieces, anchor: sent.from + 1, frozen };
}

/** 这次整理新换进来的文字在输入框里的范围（prev → next 里新出现的 polished 片段；淡入用）。没有返回 null。 */
export function freshRange(prev: Draft, next: Draft): Mark | null {
  const old = new Set<Piece>(prev.pieces);
  let offset = 0;
  let start = -1;
  let end = -1;
  for (const piece of next.pieces) {
    const at = offset;
    offset += piece.text.length;
    if (old.has(piece) || piece.kind !== "user" || !piece.polished || !piece.text) continue;
    if (start < 0) start = at;
    end = offset;
  }
  return start < 0 ? null : { start, end };
}

/** 这次听写有没有说出东西来（asr 片段，或已整理替换过的）。 */
export function hasDictated(draft: Draft): boolean {
  return draft.pieces.some((piece) => piece.kind === "asr" && piece.text.trim()) || Object.keys(draft.frozen).length > 0;
}

/** 输入框里的光标位置在文字变化后该挪到哪（prev → next）。 */
export function shiftCaret(position: number, prev: string, next: string): number {
  if (prev === next) return position;
  const { start, oldEnd, insert } = diffText(prev, next);
  if (position >= oldEnd) return position + insert.length - (oldEnd - start);
  if (position <= start) return position;
  return start + insert.length;
}
