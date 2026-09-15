import type { Block } from "./blocks/schema";

/**
 * 内部锚点的相关性检查（§2.4）。
 *
 * 上一版的一份面板行业报告里出现了「AIDC 域在算力与基础设施资产经营中形成的上游元器件
 * 价格观察，可用于判断这一轮物料涨价是否仍在延续」—— 那是上下文污染：内部判断链里的一条
 * 锚点被塞进了一个跟它没有交集的行业结论下面。它读起来像一条可执行的裁决路径，而顺着它
 * 去调的材料回答不了这个问题。
 *
 * 检查放在报告写完之后、出口对账里，而不是放在装上下文的时候：能不能裁决，取决于**这份
 * 报告最后落到哪几条命题上**，那件事在装上下文时还不知道。没过检查的锚点由 `stripHooks`
 * 摘掉并记在案 —— 摘掉不留痕的话，「这条判断没有内部裁决路径」和「有一条但被摘了」
 * 长得一样。
 */

export const ANCHOR_GATE_SYSTEM = `判断一条内部锚点和这次研究有没有直接交集。

**只答两种话**：
· 能 + 命题编号（例：能 + D2-P1）
· 不能

指不出具体命题编号的一律答「不能」。差一点点、间接相关、也许有帮助 —— 这几种都是「不能」。`;

export function buildAnchorGateUser(o: {
  industry: string;
  anchor: string;
  propositions: readonly string[];
}): string {
  return [
    `研究主体所处行业：${o.industry}`,
    `候选内部锚点：${o.anchor}`,
    "本研究的命题：",
    ...o.propositions.map((p) => `- ${p}`),
    "",
    "问：该锚点产生的数据能否直接裁决本研究中的某个具体命题？",
  ].join("\n");
}

/** 读那句回答。答「能」但指不出命题号的当不通过 —— 指不出来就是没有对应物。 */
export function readAnchorVerdict(text: string): { pass: boolean; propositionId: string } {
  const flat = text.replace(/\s/g, "");
  if (!flat.startsWith("能")) return { pass: false, propositionId: "" };
  const m = /(D[1-8]-[PC]\d+)/.exec(flat);
  return m ? { pass: true, propositionId: m[1] } : { pass: false, propositionId: "" };
}

/*
 * ---- 合批：一次调用判全部锚点（2026-09-04）----
 *
 * 逐条各发一次的写法在 ISS-223 上是 22 次调用、ISS-226 上 26 次，排在链的最末端 —— 上游
 * 一超时它就一次都发不出（223 那轮 22 条 0 通过，全部被摘）。每条各判的理由（几条之间没有
 * 依赖）在合批里照样成立：模型一行答一条，行与行之间互不影响；差别只是等待从 N 次变成 1 次，
 * 而这一步要的回答每条只有几个字。上面逐条那三个函数留着给回放与测试用。
 */

export const ANCHOR_GATE_BATCH_SYSTEM = `下面给你几条内部锚点，逐条判断它和这次研究有没有直接交集。

每条锚点答一行，行首写它的序号，然后只写两种话之一：
· 序号 能 命题编号（例：3 能 D2-P1）
· 序号 不能（例：4 不能）

指不出具体命题编号的一律答「不能」。差一点点、间接相关、也许有帮助 —— 这几种都是「不能」。
有几条锚点就答几行，不要多写一个字。`;

export function buildAnchorGateBatchUser(o: {
  industry: string;
  anchors: readonly string[];
  propositions: readonly string[];
}): string {
  return [
    `研究主体所处行业：${o.industry}`,
    "本研究的命题：",
    ...o.propositions.map((p) => `- ${p}`),
    "",
    `候选内部锚点（共 ${o.anchors.length} 条）：`,
    ...o.anchors.map((a, i) => `${i + 1}. ${a}`),
    "",
    "问：每条锚点产生的数据能否直接裁决本研究中的某个具体命题？按序号逐行作答。",
  ].join("\n");
}

/**
 * 读合批的回答：按行首序号归位，没答到的、答不出序号的、答「能」却没命题号的，一律不通过。
 * 返回长度恒等于 `n`，位置对应送检顺序 —— `stripHooks` 按名单判，顺序稳定才好在 trace 上对。
 */
export function readAnchorBatchVerdicts(text: string, n: number): { pass: boolean; propositionId: string }[] {
  const out = Array.from({ length: n }, () => ({ pass: false, propositionId: "" }));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s/g, "");
    const m = /^(\d+)[.、:：)）]?/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= n) continue;
    // 先看有没有「不能」再看「能」：「能否裁决：不能」这种句子里「能」字在前。
    const rest = line.slice(m[0].length);
    if (/不能/.test(rest) || !/^能/.test(rest)) continue;
    const p = /(D[1-8]-[PC]\d+)/.exec(line);
    if (p) out[idx] = { pass: true, propositionId: p[1] };
  }
  return out;
}

/** 扫 `judgment` 块的 `internalValidationHooks` 去重。 */
export function hooksOf(blocks: Block[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const block of blocks) {
    if (block.type === "judgment") {
      for (const hook of block.internalValidationHooks) {
        if (!seen.has(hook)) {
          seen.add(hook);
          result.push(hook);
        }
      }
    }
  }

  return result;
}

/**
 * 只重建 `judgment` 块的 `internalValidationHooks`，留下 `keep` 中的那些。
 * 别的块**原样返回同一个引用**（测试里 `toEqual` 也能过，但保持引用能让上游少一次无谓的重渲染）。
 */
export function stripHooks(
  blocks: Block[],
  keep: string[]
): { blocks: Block[]; removed: string[] } {
  const keepSet = new Set(keep);
  const allHooks = hooksOf(blocks);
  const removed = allHooks.filter((h) => !keepSet.has(h));

  const newBlocks = blocks.map((block) => {
    if (block.type === "judgment") {
      return {
        ...block,
        internalValidationHooks: block.internalValidationHooks.filter((h) => keepSet.has(h)),
      };
    }
    // Non-judgment blocks return the same reference
    return block;
  });

  return { blocks: newBlocks, removed };
}
