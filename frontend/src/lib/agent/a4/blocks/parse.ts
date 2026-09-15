/**
 * JSONL → 块。**一行坏掉只丢一行。**
 *
 * 整篇 JSON 的失败模式是全有或全无：两千多字中文里任何一处裸引号，整份 parse 不出来，
 * 屏幕上是一片空白。一行一个块之后，坏掉的那一行进 `bad`、别的块照旧读得出来，重写
 * 那一轮也只需要重发那一个块。
 *
 * ## 没写完的最后一行不算坏
 *
 * 流式的时候最后一行必然是半截的（`{"type":"pro`）。把它当坏行会让屏幕上每隔一瞬
 * 闪一条「有一行坏了」，而它下一秒就完整了。所以：**文本没有以换行收尾时，最后一行
 * 是 `pending`，不解析、不算错**。这一条就是「截断的 JSONL 前缀可渲染、不白屏」的
 * 全部机制 —— 前面的块照渲染，最后一格显示骨架屏。
 *
 * 收尾那一次调用要传 `complete: true`：这时最后一行必须站得住，站不住就是真坏了。
 *
 * ## 两处容错，各有理由
 *
 * 一是代码块围栏（``` 那三个字符）：提示词里写着不要，但模型加围栏是最常见的一种
 * 违纪，而它不损失任何信息 —— 静默跳过比为它报一条违规有用。
 *
 * 二是「整篇是一个 JSON 数组」：模型偶尔会把所有块裹进 `[...]` 交上来。这一种只在
 * 收尾时兜（流式的半截数组永远 parse 不出来），兜住之后照常出块，`bad` 里记一条 ——
 * 收下但记账：不记的话，提示词里那句「一行一个」到底有没有被听懂就没人知道了。
 */

import {
  isCommandBriefLine,
  isMetaLine,
  readBlock,
  readCommandBrief,
  readMeta,
  type BadLine,
  type Block,
  type CommandBrief,
  type ReportMeta,
} from "./schema";

export interface ParseResult {
  meta?: ReportMeta;
  blocks: Block[];
  /**
   * 决断包那一行（决策题的收口才交，ISS-238）。
   *
   * 和 `meta` 一样**不进 `blocks`**：它是报告之上的一层，不是报告的一节（理由在
   * `schema.ts` 的 `CommandBrief` 上）。收在这里而不是收进块序列，还顺手保住了这个文件
   * 头上那条约定 —— `blocks` 和 `sources` 同序同长：摘一个块出去要动两个数组，而
   * `lint.ts` 报的「第 N 个块」和 `spliceRepair` 对齐用的下标都是按它们数的。
   */
  commandBrief?: CommandBrief;
  /**
   * 决断包**原样的那一行**。`commandBrief` 有值时非空。
   *
   * 留着它的理由和 `sources` 一样，但更硬：返修那一轮是拿上一稿的原文行重拼整份 JSONL 的
   * （`spliceRepair`），这一行不在任何一个数组里的话，**一次返修就会把整个决断包丢掉** ——
   * 而返修的起因往往是别的块上的一条 p0，一号位那一屏就这么没了。
   */
  commandBriefLine: string;
  bad: BadLine[];
  /** 还没写完的那一行，原样留着。`complete: true` 时永远是空串。 */
  pending: string;
  /**
   * 每个块**原样的那一行**，和 `blocks` 同序同长。
   *
   * 返修那一轮要把被拒的块原文贴回给模型看（`lint.ts` 的 `rejectedFrom`）。贴回去的
   * 必须是它自己写的那一行，不是我们 `JSON.stringify` 再拼一遍的 —— 字段顺序、数字
   * 写法（`0.42` 还是 `.42`）都会变，而它要改的是自己写过的东西。
   */
  sources: string[];
}

/** 代码块围栏。``` 或 ```json / ```jsonl 都算。 */
const FENCE = /^```[a-zA-Z]*$/;

const clip = (line: string): string => (line.length > 120 ? `${line.slice(0, 120)}…` : line);

/**
 * 解析一整段（累积的）JSONL。
 *
 * 每次都从头解析：一份报告十几个块，重解析的成本远低于维护一个增量游标 ——
 * 游标的失败模式是「上一段结尾多了半个字符」，而那种错只在特定长度的输入上出现。
 */
export function parseBlocks(text: string, opts?: { complete?: boolean }): ParseResult {
  const complete = opts?.complete === true;
  const body = text ?? "";
  const lines = body.split(/\r?\n/);

  // 没有以换行收尾 = 最后一行还在写。收尾那一次不留 pending。
  let pending = "";
  if (!complete && lines.length && !/\n$/.test(body)) {
    pending = lines.pop() ?? "";
  }

  const blocks: Block[] = [];
  const sources: string[] = [];
  const bad: BadLine[] = [];
  let meta: ReportMeta | undefined;
  let commandBrief: CommandBrief | undefined;
  let commandBriefLine = "";

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || FENCE.test(line)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad.push({ line: i + 1, text: clip(line), why: "这一行不是合法 JSON" });
      return;
    }

    if (isMetaLine(parsed)) {
      const m = readMeta(parsed);
      if (m.ok) {
        // 交了两行元数据时以第一行为准：后一行不知道是修正还是复制粘贴的残留。
        if (!meta) meta = m.value;
        else bad.push({ line: i + 1, text: clip(line), why: "第二行 report_meta，已按第一行为准" });
      } else {
        bad.push({ line: i + 1, text: clip(line), why: m.why });
      }
      return;
    }

    if (isCommandBriefLine(parsed)) {
      const cb = readCommandBrief(parsed);
      if (!cb.ok) {
        bad.push({ line: i + 1, text: clip(line), why: cb.why });
      } else if (commandBrief) {
        // 交了两个决断包时以第一个为准，同 report_meta：后一个不知道是修正还是残留，
        // 而「哪一个是他要拍的板」这件事没人猜得出来。
        bad.push({ line: i + 1, text: clip(line), why: "第二个 command_brief，已按第一个为准" });
      } else {
        commandBrief = cb.value;
        commandBriefLine = line;
      }
      return;
    }

    const b = readBlock(parsed);
    if (b.ok) {
      blocks.push(b.value);
      sources.push(line);
    } else bad.push({ line: i + 1, text: clip(line), why: b.why });
  });

  // 整篇裹成一个数组交上来的那一种，只在收尾时兜。
  if (complete && !blocks.length && !meta && !commandBrief) {
    const whole = body.trim();
    if (whole.startsWith("[")) {
      try {
        const arr: unknown = JSON.parse(whole);
        if (Array.isArray(arr)) {
          const salvaged: Block[] = [];
          const salvagedSources: string[] = [];
          for (const one of arr) {
            if (isMetaLine(one)) {
              const m = readMeta(one);
              if (m.ok && !meta) meta = m.value;
              continue;
            }
            if (isCommandBriefLine(one)) {
              const cb = readCommandBrief(one);
              if (cb.ok && !commandBrief) {
                commandBrief = cb.value;
                // 这一支里没有「原样的那一行」可取（它本来就不是一行一个），重新序列化是
                // 这条路径上唯一拿得出的原文 —— 同下面 `salvagedSources` 那一处。
                commandBriefLine = JSON.stringify(one);
              }
              continue;
            }
            const b = readBlock(one);
            if (b.ok) {
              salvaged.push(b.value);
              // 这一支里没有「原样的那一行」可取 —— 它本来就不是一行一个。重新序列化
              // 是这条路径上唯一拿得出的原文。
              salvagedSources.push(JSON.stringify(one));
            }
          }
          if (salvaged.length || meta || commandBrief) {
            return {
              ...(meta ? { meta } : {}),
              ...(commandBrief ? { commandBrief } : {}),
              commandBriefLine,
              blocks: salvaged,
              bad: [{ line: 1, text: clip(whole), why: "整篇是一个 JSON 数组，不是一行一个块。已收下" }],
              pending: "",
              sources: salvagedSources,
            };
          }
        }
      } catch {
        // 连数组都不是，照旧按逐行的结果返回。
      }
    }
  }

  return {
    ...(meta ? { meta } : {}),
    ...(commandBrief ? { commandBrief } : {}),
    commandBriefLine,
    blocks,
    bad,
    pending,
    sources,
  };
}
