/**
 * 对谈里长出来的东西怎么落库 —— 两件事，都是纯函数：
 *
 * 1. `landMicroEvidence`：轮内取证结果追加台账、重新编号、不改报告正文。
 * 2. `armsOf` / `planLanding`：聊定的候选判断摆成「板上一条 + 图上一条」。
 *
 * 为什么都是纯函数：这两步唯一的难点都是形状与编号，跟库无关，能不碰 store 就测。
 * 写库那一半在 `store.ts` 上（`landTalkEvidence` / `landTalkCandidate`），因为
 * `boardPush` 与 `store.probeNodes` 都是私有的。
 */

import type { Evidence } from "@/lib/research/ledger";
import type { BoardJudgement, ProbeNode, ResearchDoc, Trace } from "@/lib/data/types";
import type { TalkPoint } from "./point";

/**
 * 把轮内取证回来的条目追加到报告台账上，重新编号以避免撞号。
 *
 * **编号必须重新分配。** `Ledger` 的计数器是 `private n = 0`，没法从外面播种，所以
 * `runMicroResearch` 那一轮回来的条目永远从 `E1` 起 —— 和报告里已有的 `E1` 撞号。
 * 撞号的后果不是显示难看：`evidence_lookup` 按 `E1` 取会拿到两条不同的证据，而他看到
 * 模型引 `[E1]` 时以为说的是报告里那一条。
 *
 * **从「现有最大号 + 1」起编**：扫 `doc.ledger` **和** `doc.blocks?.evidence` 两处所有
 * 形如 `E{数字}` 的 `id` 取最大的那个数字。为什么两处都要扫：老报告（分层之前跑出来的、
 * 或者 `TKOS_DR_V2=0` 那条对照链）只有速查那一份，光看台账会算出 0 然后从 `E1` 起编，
 * 正好撞在速查那一份的 `E1` 上。不像 `E{数字}` 的 id 直接跳过，不报错。
 *
 * **返回一份新的 `doc`**，不原地改入参 —— 调用方是 store，那边的写法是「组好一份新的
 * 再赋回去」。`added` 是新分配的那几个编号，给留痕和告知用。
 */
export function landMicroEvidence(
  doc: ResearchDoc,
  entries: readonly Evidence[],
): { doc: ResearchDoc; added: string[] } {
  if (entries.length === 0) {
    // 一条都没有就原样回，不留空编号
    return { doc, added: [] };
  }

  // 扫两处找最大编号：台账与速查那一份
  let maxN = 0;
  const extractNum = (id: string): number | null => {
    const m = /^E(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : null;
  };

  // 扫台账
  if (doc.ledger) {
    for (const e of doc.ledger) {
      const n = extractNum(e.id);
      if (n !== null && n > maxN) maxN = n;
    }
  }

  // 扫速查那一份
  if (doc.blocks?.evidence) {
    for (const e of doc.blocks.evidence) {
      const n = extractNum(e.id);
      if (n !== null && n > maxN) maxN = n;
    }
  }

  // 重新编号：从 maxN + 1 起
  const renumbered: Evidence[] = [];
  const added: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const newId = `E${maxN + 1 + i}`;
    renumbered.push({ ...entries[i], id: newId });
    added.push(newId);
  }

  // 返回新的 doc
  const newLedger = [...(doc.ledger ?? []), ...renumbered];
  return {
    doc: { ...doc, ledger: newLedger },
    added,
  };
}

/* -------------------------------------------------------------------------- */
/* 聊定的候选判断上板、落图                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 板上那一条和图上那一条共用的溯源。
 *
 * 板上每一条都要说得出它是打哪来的，而这一条不是深研读出来的，也不是会上定的。
 */
const TALK_TRACE: Trace = { kind: "agent", source: "议事对话" };

/**
 * 要布控的那几条重开条件，按顺序。
 *
 * `candidate.reopenIf` 在前，`extraArms` 在后。空串与重复项去掉 —— 一条空的
 * `ReopenTrigger` 落到判断上，屏幕上就是一行「出现什么就重开：」后面没话。
 *
 * **`extraArms` 目前没有生产调用方。** 它原本是留给「把 `DecisionMemory.overturnConditions`
 * 一起布控」那一档的，而那件事后来判定做不了：决策记忆是**他按下确认那一下**才写的
 * （`confirmCandidate`），比落地晚一步 —— 落地的时候还没有记忆可读，反向转交是空转。
 *
 * 留着不删，是因为它今天有一个真作用：**它是唯一能让图上那条的 `arms` 与
 * `candidate.reopenIf` 不相等的杠杆**。决策记忆那一栏的重开条件取的是图上那条排着的
 * （不是候选那一栏），两者相等时那条断言分辨不出取的是哪一头 ——
 * `memory.test.ts` 里「条件等于 ProbeNode.arms」那一条正是靠传一条额外的进来才立得住。
 */
export function armsOf(
  candidate: { reopenIf?: string },
  extraArms?: readonly string[],
): string[] {
  const out: string[] = [];
  for (const raw of [candidate.reopenIf, ...(extraArms ?? [])]) {
    const text = (raw ?? "").trim();
    // 只留空白的那一条等于没写，去掉它比让屏幕上出现一行空条件好
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

/** 落地方案。两块都是**不带 id** 的形状：编号由板和图各自给，不由这一层编。 */
export type LandPlan = {
  board: Omit<BoardJudgement, "id" | "issueId">;
  /**
   * 图上那一条。`null` = 这件议题现在没有在版判断可翻（`Issue.judgmentRefs` 是空的），
   * 于是只上板不落图 —— `route: "ontology"` 但 `revisesJudgmentId` 为空时
   * `confirmCandidate` 会静默跳过翻版与布控那一整段，落一个那样的节点等于给他一个
   * **按下去既不布控也不翻任何判断**的按钮。
   *
   * 不是「按下去什么都不会发生」：那一支照旧会把节点标成 confirmed、发一个决定号、
   * 记一条快捷决定。少掉的正是他按那一下要的东西。
   */
  node: Omit<ProbeNode, "id"> | null;
};

/**
 * 把一条已经过了复核的候选，摆成「板上一条 + 图上一条」。
 *
 * **纯函数，不碰库、不发模型调用。** 写库那一半在 `store.ts` 的 `api.landTalkCandidate`，
 * 因为 `boardPush` 与 `store.probeNodes` 都是私有的。
 *
 * 四栏原样抬过去、不做字段映射（`TalkPoint.candidate` 的注释就是这么承诺的）：
 * `statement` / `basis` / `boundary` / `reopenIf` 在板上同名同义。
 *
 * **这里一个确认字段都不写。** 板上那一条落在上半层（没有 `confirmed`），图上那一条是
 * `direction`（没有 `confirmedAt` / `decisionId`），`arms` 排好队但一条都没布控 ——
 * 布控只发生在他按下确认那一下（`confirmCandidate`）。
 */
export function planLanding(o: {
  issueId: string;
  candidate: NonNullable<TalkPoint["candidate"]>;
  /** 这件议题在动摇的那条在版判断（`Issue.judgmentRefs[0]`）；一条都没有就传 null。 */
  revisesJudgmentId: string | null;
  /** 见 `armsOf`（目前没有生产调用方，那一段写清了为什么留着）。 */
  extraArms?: readonly string[];
  /** 第几轮对谈（进 `ProbeAnchor` 的 `{ kind: "talk", round }`）。 */
  round: number;
  at: string;
}): LandPlan {
  const { candidate } = o;
  const arms = armsOf(candidate, o.extraArms);

  const board: Omit<BoardJudgement, "id" | "issueId"> = {
    statement: candidate.statement,
    origin: "dialogue",
    at: o.at,
    notes: [TALK_TRACE],
    basis: candidate.basis,
    ...(candidate.boundary ? { boundary: candidate.boundary } : {}),
    ...(candidate.reopenIf ? { reopenIf: candidate.reopenIf } : {}),
  };

  if (!o.revisesJudgmentId) return { board, node: null };

  return {
    board,
    node: {
      issueId: o.issueId,
      /*
       * `text` 直接用候选那句判断：`ProbeNode.text` 要求「单独摘出来发给一个没读过前七轮
       * 的人也读得懂」，而候选的 `statement` 本来就是按同一条标准写的（`BoardJudgement`
       * 那一栏的注释）。重写一遍只会得到一句同源的近义句。
       */
      text: candidate.statement,
      whyOnTopic: "这一条是在这件议题的对谈里收敛出来的",
      by: "agent",
      at: o.at,
      standing: "direction",
      anchor: { kind: "talk", round: o.round },
      knowledge: [TALK_TRACE],
      route: "ontology",
      revisesJudgmentId: o.revisesJudgmentId,
      // `confirmCandidate` 翻版时读的是 `nextStatement`，不是 `text`
      nextStatement: candidate.statement,
      ...(candidate.boundary ? { boundaryNote: candidate.boundary } : {}),
      arms,
      // 落了就该看得见 —— 分幕是给报告一起投影出来的那批用的
      revealAfterRound: 0,
    },
  };
}

/** 落完之后的回执。屏幕上要说得出「落在哪了、接下来等谁」。 */
export type Landing = {
  /**
   * 板上那一条的 id。同一句再落一次时返回既有那一条（`boardPush` 自己去重）。
   *
   * **撞车那一档指的是板上原有的那一条**（开头 30 字相同、结尾不同的前一句）——
   * 这一次要落的那一句一个字都没进板。回执里的编号必须指得到板上真有的一条，指不到
   * 的话屏幕上那句话点开是空的；至于这一次落没落成，`why` 那一栏说得清清楚楚。
   */
  boardId: string;
  /** 板上那一条的短编号（`D2` 这种，`refCodeOf` 出的，不是列表下标）。 */
  ref: string;
  /**
   * 图上那一条待确认项；`null` 有三路：没有在版判断可翻（只上了板）、这一句他
   * **已经确认过**（那时候图上那条是 confirmed，交回去等于给他一个按不动的按钮），
   * 以及**撞上了板上开头相同的那一条**（那一次板上留的是前一句，落图等于让他按一下
   * 就把一句他没在板上读过的话写进在版判断）。
   */
  nodeId: string | null;
  /**
   * 等他按下确认时会被布控的那几条 —— 读的是图上那条待确认项上排着的。
   *
   * **落图那一路上它们一条都还没布控**（布控发生在 `confirmCandidate`）。`nodeId` 为
   * null 的那三路上它是空数组：一路上根本没有图上那一条，一路上该布控的早在他确认
   * 那一下布控完了，撞车那一路上这一次什么都没落。
   */
  queuedArms: string[];
  /**
   * **这一次一个字都没落上去**：板上已经有一句开头 30 字相同、结尾不同的判断。
   *
   * 只有那一档才有这一栏，别的路一律不带（不是 `false`）—— 「这次撞了」和「这次没撞」
   * 在读账的人眼里是两件事，而一个恒在的 `false` 会让「撞车」这件事在台账上和别的路
   * 长得一样。
   *
   * 为什么需要一栏而不是让调用方读 `why`：撞车与「他已经确认过」两路的 `nodeId` 都是
   * null，靠 `why` 的措辞去分辨等于把一句会改的屏幕文案当成判据。
   */
  collided?: true;
  /**
   * 一句写给人读的话：落在哪了、接下来等谁。措辞照上屏的标准写（不出现内部字段名），
   * 但**今天它还没有屏幕上的入口**：唯一的消费方是轮外结算，它把这句话记进这一轮的
   * 运营台账（`settle.ts` 里那条「候选落地回执」）。所以写错的后果今天是回头翻账的人
   * 读到一句假话 —— 那和屏幕上一句假话同一档，只是看见的人少。
   *
   * 五档各说各的，一档都不许套另一档的措辞：落了图且有重开条件排队、落了图但候选没写
   * 重开条件、没有在版判断可翻、他已经确认过、以及撞上板上开头相同的那一条。最后那一档
   * 尤其不许说「已落到判断板」—— 那一次那一句一个字都没进板。
   */
  why: string;
};
