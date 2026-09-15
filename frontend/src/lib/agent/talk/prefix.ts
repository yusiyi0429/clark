/**
 * 议事对话的静态前缀。**只带正文层，不带机械校验。**
 *
 * 深研 v2 的报告是分层的：正文里是论点与机制，附录里是七项机检的全部产物（承重索引、
 * 反证应答表、口径演算、指标锚点、证伪条件清单）。这些东西对审计和对账不可少，但对
 * 对谈模型是干扰——30 秒读不完的机械表会把注意力从论点上拽走。
 *
 * ## 为什么 appendixFrom 和 partition 两条路都要有
 *
 * `appendixFrom` 是装配时写的下标（stage-write.ts 的 assembleOrdered），告诉渲染器「第几个块之后就是附录」。
 * `partition` 是按块类型判的——凡是 APPENDIX_TYPES 里的块都归附录。两者没有任何代码
 * 强制它们对齐；相反，机检出口那一关（`audit.ts:auditExit` 的 A4-N07）只在 `appendixFrom`
 * 存在时，才检查 `appendixFrom` 之前有无附录类型块；`appendixFrom` 缺失时直接跳过这一检查。
 *
 * 这意味着：
 * - `appendixFrom` 存在 = 跑过装配，且过了 A4-N07。这时按下标切是最准的。
 * - `appendixFrom` 缺失 = 跑过 v1 路径，或者 v2 跑到一半中断。这时按类型切是唯一的退路。
 *
 * 对话上下文这一侧宁可两道都过，也不能把附录塞进前缀——那会把一份 2000 字的正文
 * 扩张成 8000 字的全文，其中 6000 字是审计清单，而对谈根本不需要读那些。
 *
 * ## `buildBoard` 与 `assemblePrefix` 目前生产没有调用方
 *
 * 真正发给模型的那份参谋前缀仍然在 `store.ts` 的 `buildAdvisorContext` 里装配 ——
 * 那是个**交错**构建器（报告正文 → 台账索引 → 建议分流 → 引用文档全文 → 公司口径 →
 * 判断板 → 决策记忆 → 命中提示 → 用户卡），而 `assemblePrefix` 是七块固定顺序的装配器，
 * 结构上复现不了它。链路是 `route.ts` → `runTalkTurn(prefix: string)`，那一层拼的是
 * `[companyBlock, wrapContext(...)]`；给 `assemblePrefix` 一个生产席位是 `route.ts`
 * 那一层的改造，会动真实发给模型的提示词，不在这一任务范围内。
 *
 * **将来谁要把生产切过来，先看这一条陷阱**：`buildAdvisorContext` 的判断板那一块比
 * `buildBoard` 厚得多 —— 除了两段判断，它还带着每条的依据 / 边界 / 重开条件 / 他确认时
 * 给的理由，以及「关于这块板，四条规矩」那一段。那四条里有「**确认只能由他按下**」
 * 这条硬原则的提示词落点。不把那两段一起搬进来就直接切，前缀会**静默**少掉它们：
 * 测试全绿、类型全过，只是模型不再知道自己不许代他确认。
 *
 * 连带的后果一并记在这里：规格 §7 验收要的 `PrefixManifest`（每块占多少字）**在生产上
 * 暂时取不到** —— 它只在 `assemblePrefix` 里产出，而生产不走那条路。
 *
 * **表头那两句措辞已经和生产那份分家了**，切过去时要一并对齐：这边是「待确认」/「已确认」，
 * 生产那份是「待他确认」/「他已经确认过」（`store.ts` 的 `buildAdvisorContext`）。条目行仍逐字
 * 相同。今天 `buildBoard` 生产零调用方，所以这处分家在屏幕上没有后果 —— 但正因为一份有测试
 * 无生产、一份有生产无测试，谁真把生产切过来，先对齐的就是这两句。
 *
 * 唯一那份逐字重复（决策记忆那一段的渲染）已经提成 `renderDecisionMemories`，两边都调它；
 * 那一段里的两个标签又提成了 `BASIS_LABEL` / `REOPEN_LABEL`（见下），判断板那一块的同名两栏
 * 引的是同一对常量。判断板那一段的**渲染**刻意没有合并，理由就是上面那条：生产那份更厚，
 * 硬合会动提示词。
 */

import { partition, textOf } from "@/lib/agent/a4/layer";
import { buildRegistry } from "@/lib/agent/a4/blocks/registry";
import type { BlockEvidence, ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import type { Evidence } from "@/lib/research/ledger";
import type { DecisionMemory, UserCard } from "./memory";
import { packUserCard } from "./memory";
import type { BoardRef } from "@/lib/agent/a6/extract";

/**
 * 静态前缀的块类型。判断板、用户卡片、决策记忆三块已经有构造函数；
 * `history` 还只是 `assemblePrefix` 的一个入参（原样带上，没有自己的构造函数）。
 */
export type PrefixBlockName =
  | "system"
  | "reportBody"
  | "board"
  | "ledgerIndex"
  | "userCard"
  | "decisionMemory"
  | "history";

/**
 * 前缀清单。每个块的名字 + 字符数，供调试和日志用。
 */
export type PrefixManifest = { block: PrefixBlockName; chars: number }[];

/**
 * 提取报告的正文层。**不带附录。**
 *
 * `appendixFrom` 存在时按下标切；不存在时按块类型切。两条路都是为了确保附录不进前缀。
 */
export function buildReportBody(blocks: ReportBlocks): string {
  // 有装配下标就用下标切（最准）
  if (typeof blocks.appendixFrom === "number") {
    const bodyBlocks = blocks.blocks.slice(0, blocks.appendixFrom);
    return bodyBlocks.map(textOf).join("\n\n");
  }

  // 没有装配下标就按类型切（退路）
  const { body } = partition(blocks.blocks);
  return body.map(textOf).join("\n\n");
}

/**
 * 台账索引。**只给 ID、一句话、来源、档次，索引到此为止。**
 *
 * 格式：`E{n}｜{claim}｜{sourceName}｜{grade} 档`
 *
 * 这一份是落库那份证据表（`BlockEvidence`）——原文引句（`exactQuote`）与口径详情
 * （`value`/`unit`/`precision`/`period`）不在落库那份里。需要全文时走 `evidence_lookup`
 * 工具（Task 7）。
 */
/**
 * 索引要带上对谈里追加的那几条。`Evidence` → `BlockEvidence` 用既有的
 * `buildRegistry(entries, [])` —— `blocks` 传空数组时它把全部条目走 `fromLedger`
 * 映射出来（`registry.ts:157`），不需要在这里再写一份字段映射。
 *
 * 为什么这个口非接不可：取证追加的那几条**只落在 `doc.ledger` 上**（`land.ts`），而索引
 * 读的是落库那份速查表。两条路都往那里落：轮内当场查回来的那一次，和答不完转成异步之后
 * 补回来的那一次（两头都过 `api.landTalkEvidence`）。不接的话「查证结果稍后补上」许诺的
 * 下一轮，他问那个编号会被告知没有这一条 —— 东西在库里，只是索引上没写。
 */
export function indexEntries(
  slim: readonly BlockEvidence[],
  ledger: readonly Evidence[] | undefined,
): BlockEvidence[] {
  const taken = new Set(slim.map((e) => e.id));
  const extra = (ledger ?? []).filter((e) => !taken.has(e.id));
  if (extra.length === 0) return [...slim];
  return [...slim, ...buildRegistry(extra, [])];
}

export function buildLedgerIndex(entries: readonly BlockEvidence[]): string {
  return entries
    .map((e) => {
      return `${e.id}｜${e.claim}｜${e.sourceName}｜${e.grade} 档`;
    })
    .join("\n");
}

/**
 * 判断板递给模型的那一块。
 *
 * `BoardRef.ref` 就是他嘴里的「那一条」（全系统一处出：`boardRefsFor`），**这里不许另编号**。
 * `confirmed` 为假的那几条不许出现确认字样 —— 屏幕上没确认的，前缀里也不能像已确认那样写。
 */
export function buildBoard(refs: readonly BoardRef[]): string {
  if (refs.length === 0) return "";

  const lines: string[] = [];
  const draft = refs.filter((r) => !r.confirmed);
  const done = refs.filter((r) => r.confirmed);

  if (draft.length > 0) {
    lines.push(`待确认（还只是候选，不是公司口径）—— ${draft.length} 条：`);
    for (const r of draft) {
      lines.push(`  ${r.ref}｜${r.label ? `${r.label}：` : ""}${r.statement}`);
    }
  }

  if (done.length > 0) {
    lines.push(`已确认（已经是公司口径）—— ${done.length} 条：`);
    for (const r of done) {
      lines.push(`  ${r.ref}｜${r.label ? `${r.label}：` : ""}${r.statement}`);
    }
  }

  return lines.join("\n");
}

/**
 * 「凭什么」与「什么新证据会把它重新打开」这两个标签。**同一份前缀里同一件事只能有一个说法。**
 *
 * 提成常量的理由不是省字：判断板那一块（`store.ts` 的 `buildAdvisorContext`）和决策记忆
 * 那一段（下面的 `renderDecisionMemories`）**进的是同一次模型调用** —— 先 push 板、再 push
 * 记忆。这两段各写一份措辞时，维持一致的唯一装置是一行注释，而这一支已经因为它栽过一次
 * （`changelog.ts` 里那条「记忆那一段的『什么会把它推翻』改成判断板上一直在用的『什么新证据
 * 会把它重新打开』」记的就是那一次手抄对齐）。
 *
 * 测试那一侧的偏斜是同一件事的另一半：记忆那一侧被逐字断过两处，板那一侧一条都没有 ——
 * 于是「改板不改记忆」全绿、「改记忆不改板」两条红。提成一处之后，改哪一头都是同一个改动。
 */
export const BASIS_LABEL = "凭什么：";
export const REOPEN_LABEL = "什么新证据会把它重新打开：";

/**
 * 决策记忆那一段的渲染。**两个调用方共用这一份**：`assemblePrefix`（这个文件）和
 * `buildAdvisorContext`（`store.ts`，真发给模型的那一份）。
 *
 * 提出来是因为上一版这段文案在两个文件里逐字抄了两遍。抄两份的表现不是重复代码
 * 难看，而是改词只改了一头：他在屏幕上读到的措辞和测试断言的措辞会各走各的，
 * 而两边都绿。
 *
 * 返回的是**行数组**不是整段字符串 —— `buildAdvisorContext` 那一侧是往一个 `lines`
 * 里 push，拿到整段还得再拆一次。没有记忆时返回空数组（不是一行空表头）。
 */
export function renderDecisionMemories(memories: readonly DecisionMemory[]): string[] {
  if (memories.length === 0) return [];
  const lines: string[] = [`相关决策记忆 —— ${memories.length} 条：`];
  for (const m of memories) {
    lines.push(`  ${m.judgment}`);
    lines.push(`  ${BASIS_LABEL}${m.rationale}`);
    if (m.overturnConditions.length > 0) {
      // 措辞与判断板那一块的 `basis` / `reopenIf` 同源（见两个常量上面那段）
      lines.push(`  ${REOPEN_LABEL}${m.overturnConditions.join("；")}`);
    }
  }
  return lines;
}

/**
 * 七块按固定顺序装成一份前缀，并交出每块占多少字。
 *
 * `system` 收的是**已经换过名字**的那一份 —— `buildTalkSystem(viewer().name)` 的产物
 * （`system.ts`）。`runTalkTurn` 一个字都不碰 `{user}`：它收到的 `system` 已经是成品，
 * 换名发生在两个调用方各自那一格（`route.ts` 与 `fixtures/pressure.ts`）。
 * `history` 来自 Task 2，`reportBody` / `ledgerIndex` 是本文件已有的两个，
 * `board` / `userCard` / `decisionMemory` 三块由本任务补齐。
 *
 * 传 `null` / 空数组的块**不进 manifest**（不是进一条 `chars: 0`）—— 「这一块这次没带」和
 * 「这一块带了但是空的」在调试时是两件事。
 */
export function assemblePrefix(o: {
  system: string;
  blocks: ReportBlocks;
  ledger: readonly BlockEvidence[];
  board: readonly BoardRef[];
  card: UserCard | null;
  memories: readonly DecisionMemory[];
  history: string;
}): { text: string; manifest: PrefixManifest } {
  const parts: string[] = [];
  const manifest: PrefixManifest = [];

  // System prompt
  if (o.system) {
    parts.push(o.system);
    manifest.push({ block: "system", chars: o.system.length });
  }

  // Report body
  const reportText = buildReportBody(o.blocks);
  if (reportText) {
    parts.push(reportText);
    manifest.push({ block: "reportBody", chars: reportText.length });
  }

  // Ledger index
  const ledgerText = buildLedgerIndex(o.ledger);
  if (ledgerText) {
    parts.push(ledgerText);
    manifest.push({ block: "ledgerIndex", chars: ledgerText.length });
  }

  // Board
  if (o.board && o.board.length > 0) {
    const boardText = buildBoard(o.board);
    if (boardText) {
      parts.push(boardText);
      manifest.push({ block: "board", chars: boardText.length });
    }
  }

  // User card
  if (o.card) {
    const cardText = packUserCard(o.card);
    if (cardText) {
      parts.push(cardText);
      manifest.push({ block: "userCard", chars: cardText.length });
    }
  }

  // Decision memories
  const memLines = renderDecisionMemories(o.memories ?? []);
  if (memLines.length > 0) {
    const memText = memLines.join("\n");
    parts.push(memText);
    manifest.push({ block: "decisionMemory", chars: memText.length });
  }

  // History
  if (o.history) {
    parts.push(o.history);
    manifest.push({ block: "history", chars: o.history.length });
  }

  return {
    text: parts.join("\n\n"),
    manifest,
  };
}
