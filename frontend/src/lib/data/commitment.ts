import { ApiError } from "./shared";
import type { Commitment, CommitmentItem } from "./types";

/**
 * Commitment 的状态机与派生量。**纯函数：不碰 store、不读时钟、不抄引用。**
 *
 * 分出这个文件的理由是它是这一版唯一有状态机的东西，而状态机的每一条边都值得
 * 一个用例（spec §10）。时间与操作人由调用方传进来，于是测试里的时间线是确定的。
 */

type Stamp = { actor: string; at: string };

/** 生效之后只读。**一号位签过的东西不能被谁再改一笔。** */
export function assertWritable(c: Commitment): void {
  if (c.status === "effective") {
    throw new ApiError("这份承诺已经生效，改不了了。要改就开下一期。");
  }
}

/**
 * DRI 提交回传。`drafted`（第一次）或 `adjudicated`（按裁决修订）才能提交。
 *
 * 从 `adjudicated` 提交时 version+1 —— 一次「提交 + 裁决」就是复盘里说的一轮，
 * 8 月实测两轮。
 */
export function submitDraft(c: Commitment, opts: Stamp & { note: string }): Commitment {
  assertWritable(c);
  if (c.status === "submitted") {
    throw new ApiError("这份回传已经交出去了，等他裁完再改。");
  }

  const bad = c.items.find((i) => i.verdict !== "accept" && !i.reason?.trim());
  if (bad) {
    throw new ApiError(`「${bad.proposed}」标成了${verdictWord(bad.verdict)}，得写一句理由。`);
  }

  const version = c.status === "adjudicated" ? c.version + 1 : c.version;
  return {
    ...c,
    status: "submitted",
    version,
    revisions: [
      ...c.revisions,
      { version, at: opts.at, actor: opts.actor, note: opts.note.trim() },
    ],
  };
}

/**
 * 一号位逐条裁决。裁决落在条目上（各带 `at`/`by`），不另存一份裁决记录 ——
 * 「这一条是谁什么时候怎么裁的」必须跟着那一条走。
 *
 * 只裁一部分是允许的：没裁的那几条 `ruling` 保持原样，DRI 那侧照实显示「他还没裁」。
 */
export function adjudicate(
  c: Commitment,
  rulings: Record<string, { verdict: "endorse" | "revise" | "reject"; note: string }>,
  opts: Stamp
): Commitment {
  assertWritable(c);
  if (c.status !== "submitted") {
    throw new ApiError("这个域还没有回传，没有东西可裁。");
  }

  const known = new Set(c.items.map((i) => i.id));
  const unknown = Object.keys(rulings).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    // 静默忽略等于「他点了裁决，屏幕上什么也没变」——那会被读成系统坏了。
    throw new ApiError(`裁决里有不存在的条目：${unknown.join("、")}。`);
  }

  return {
    ...c,
    status: "adjudicated",
    items: c.items.map((item) => {
      const r = rulings[item.id];
      return r ? { ...item, ruling: { ...r, note: r.note.trim(), at: opts.at, by: opts.actor } } : item;
    }),
  };
}

/** 一号位签一次，生效。此后只读。 */
export function makeEffective(c: Commitment, opts: Stamp): Commitment {
  assertWritable(c);
  if (c.status === "drafted") {
    throw new ApiError("这个域还没有回传，签不了。");
  }
  return {
    ...c,
    status: "effective",
    revisions: [
      ...c.revisions,
      { version: c.version, at: opts.at, actor: opts.actor, note: "签发生效" },
    ],
  };
}

/** 收敛轮次 = 提交过几次。**算出来的，不存字段。** */
export function convergenceRounds(c: Commitment): number {
  return c.revisions.filter((r) => r.note !== "签发生效").length;
}

/**
 * 「修改」超过两条时的那句话。
 *
 * **不拦提交。** 这是复盘 G3 的经验 —— 分歧超过两处通常是结构性的，先约谈比再写
 * 一版便宜。把经验做成硬校验就变成官僚：他有可能真的就是要改五条。
 */
export function disagreementNote(c: Commitment): string | null {
  const n = c.items.filter((i) => i.verdict === "modify" || i.verdict === "rewrite").length;
  if (n <= 2) return null;
  return `这一份里有 ${n} 条改了提案。分歧超过两处通常是结构性的 —— 先约一次谈比再回传一版便宜。`;
}

const verdictWord = (v: CommitmentItem["verdict"]): string =>
  v === "modify" ? "修改" : v === "rewrite" ? "重写" : "拒绝";
