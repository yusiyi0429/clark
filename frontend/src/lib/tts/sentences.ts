/**
 * 把模型正在写的那段话，切成一段一段送去合成。
 *
 * 这个文件决定「他说完话到听见第一声」那个数字。逻辑只有一条：**第一段要短，后面的段要整。**
 *
 * 第一段短，是因为模型写完第一个完整句子要两三秒，而验收标准是一秒半之内出声。攒到十几个
 * 字、遇到一个逗号就先送走 —— 参谋开口本来也不是一整句喷出来的。后面的段按整句切，是因为
 * 半句送进 TTS 会切坏语调：「这个月不下来，」单独合成出来的尾音是往上飘的，接不上下一段。
 *
 * 前后端共用这一份：前端拿它决定什么时候发下一个请求，服务端拿它把收到的一段再按句推给
 * 厂商。两处如果各写一套，会出现「前端以为发的是一句、服务端合成出两句」的错位，而字幕
 * 是按句对齐的 —— 那个错位会直接显示在投影上。
 */

/** 句末。中文标点为主，英文句号也收（编号里的点不会跟空格，不会误伤 `v2.1`）。 */
const SENTENCE_END = /[。！？；!?;\n]/;
/** 可以断开的次级位置。第一段来不及等句末时用它。 */
const CLAUSE_END = /[，、：,:]/;
/** 至少要有一个字或一个数字，才值得念。 */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * 洗掉念不出来的东西。
 *
 * 提示词里写了「不要 markdown」，模型还是会在段落之间甩一条 `---`、在重点上套 `**`。
 * 那些符号进了 TTS 就是一段杂音或者一次莫名的停顿。这里只洗**标记**，不改任何一个会被
 * 念到的字 —— 洗过头会把「04-J2」洗成「04 J2」，而编号念错在这场会上是要被当场指出来的。
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** 这一段有没有值得念的东西。空的、只有符号的，一律不送 —— 白花一次请求还占一个播放位。 */
export const hasSpeech = (text: string): boolean => SPEAKABLE.test(text);

/**
 * 按整句切。超长的硬切，不然厂商那边会拒。
 *
 * 服务端用它：收到的一段可能是模型一口气写的一整段，按句推给厂商比整段塞进去更稳，
 * 而且句边界报回来的时候和这里切的是同一套。
 */
export function splitSentences(text: string, maxChars = 120): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (SENTENCE_END.test(ch) || buf.length >= maxChars) {
      if (hasSpeech(buf)) out.push(buf.trim());
      buf = "";
    }
  }
  if (hasSpeech(buf)) out.push(buf.trim());
  return out;
}

/**
 * 流式切段器。
 *
 * 前端一边收模型的字一边喂它，它在该发请求的时候吐出一段。`first` 只在这一轮的第一段
 * 上放松到「逗号也算」——第二段开始就必须等句末，语调才连得上。
 */
export class SegmentFlusher {
  private buf = "";
  private first = true;

  constructor(
    private readonly firstClauseChars: number,
    private readonly maxChars: number,
  ) {}

  /** 喂一小段新到的文字，返回这一下攒够了的那些段（通常是 0 或 1 段）。 */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      const at = this.cut();
      if (at < 0) break;
      const seg = this.buf.slice(0, at + 1);
      this.buf = this.buf.slice(at + 1);
      const clean = speakable(seg);
      if (hasSpeech(clean)) {
        out.push(clean);
        this.first = false;
      }
    }
    return out;
  }

  /** 这一轮说完了：把剩下的半句也送走。半句总比丢掉好 —— 丢掉的是他要听的最后一句。 */
  end(): string[] {
    const clean = speakable(this.buf);
    this.buf = "";
    this.first = true;
    return hasSpeech(clean) ? [clean] : [];
  }

  /** 缓冲区里第一个该断的位置，没有就 `-1`。 */
  private cut(): number {
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (SENTENCE_END.test(ch)) return i;
      if (this.first && i + 1 >= this.firstClauseChars && CLAUSE_END.test(ch)) return i;
      if (i + 1 >= this.maxChars) return i;
    }
    return -1;
  }
}
