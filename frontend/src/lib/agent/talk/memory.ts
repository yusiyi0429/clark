/**
 * 议事对话的两类记忆与红线机检。
 *
 * **决策记忆**：确认时沉淀判断、凭什么、以及推翻条件。装配时按标签重合取 top-k，
 * 命中推翻条件时把提示注进前缀。
 *
 * **用户卡**：一号位本人的长期偏好。**只用来预判挑战和适配表达，不做结论的引力方向** ——
 * 这条红线两侧都要（抽取器 + system prompt §3 第 7 条）：提示词那侧管的是模型自己怎么用
 * 这张卡，抽取器这一侧管的是**这张卡里根本不该存在那种条目** —— 只靠提示词，等于把一把
 * 上了膛的枪放在桌上再贴张纸条说别拿。
 *
 * 抽取时机：**确认时写决策记忆，session 结束时批量抽取用户卡**。「session 结束批量抽取
 * 用户卡」连同「怎么从对话里抽出卡条目」留成欠账：红线机检（`checkCardItem`）先落地，
 * 抽取器等 session 身份有了再接。逐轮写是噪音（规格 §7.2）。
 */

import type { Evidence } from "@/lib/research/ledger";

/** 决策记忆。字段名按 Global Constraints 转 camelCase，语义与规格 §7.1 一一对应。 */
export type DecisionMemory = {
  id: string;
  judgment: string;
  rationale: string;
  /**
   * 推翻条件。规格 overturn_conditions。
   *
   * **本模块只负责落库，不自己布控。** 布控的路径是：
   * 1. `planLanding` 排队 → `ProbeNode.arms`（Task 15 在 `land.ts` 里实现）
   * 2. `confirmCandidate` 把 `arms` 布控成 `ReopenTrigger`（`store.ts`）
   * 3. `DecisionMemory.overturnConditions` 在确认时原样读 `ProbeNode.arms` 存进来
   *
   * **第 2 步只覆盖两条路线**：`ontology`（带 `revisesJudgmentId` 与 `nextStatement`）
   * 和 `evidence`（找得到目标判断）。`mission` / `strategy` 那两条**一条都不布控**，
   * 但第 3 步照样把 arms 存进记忆 —— 也就是说这两档的记忆里写着重开条件，库里却
   * 没有任何一条 `ReopenTrigger` 守着它。种子里还没有这两档的候选节点，所以现在
   * 看不见；真出现时这里就是要补的地方。
   *
   * 不存在反向转交：arms 是落地时排的队，记忆是确认时照抄那一份。**只有一处两头不同**：
   * `evidence` 路线上 `arms` 为空时，布控的是节点原文 `[ir.text]`（`store.ts` 那一句
   * `ir.arms && ir.arms.length > 0 ? ir.arms : [ir.text]`），而记忆里存的是空数组。
   */
  overturnConditions: string[];
  /**
   * 议题标签。装的是域 id 加判断 id，不是自由文本。
   *
   * 由议题现成的两栏推出来：`[domainId, ...judgmentRefs]` 摘掉空值（裁定 2b）。
   * 落库时存的是**确认那一刻**这个推导结果（存下来，不是每次现推 ——
   * 议题后来改了域不该让历史记忆跟着漂）。
   *
   * **与报告正文那套证据强度标签（`E*` / `P` / `P!` / `X`）无关。**
   */
  issueTags: string[];
  /**
   * Session 身份。**这个产品还没有独立的 session 身份**，一份深研报告加一件议题就是
   * 一次 session（`TALK_SYSTEM` 开头那句「当前 session 围绕一份深研报告展开」说的就是这个），
   * 所以这里存的是 `issueId`；将来真有了 session 身份，这里是唯一要改的地方。
   */
  sessionId: string;
  confirmedAt: string;
  status: "active" | "overturned";
  overturnedBy?: string;
};

/** 用户模型卡。规格 §7.2 的中文键按 Global Constraints 转 camelCase：
 *  常挑战维度→challengeDimensions，长期论点→longTermViews，偏好→preferences，
 *  已确认判断引用习惯→revisitHabit。一条不丢。 */
export type UserCard = {
  challengeDimensions: { dimension: string; count: number; sessions: string[] }[];
  longTermViews: { view: string; firstSeen: string; recentChange: string }[];
  preferences: { granularity?: string; riskStance?: string; expression?: string };
  revisitHabit?: string;
};

/**
 * 立场关键词表。**挑战维度与长期论点共用这一张。**
 *
 * 为什么共用：两类条目要挡的是同一件事 —— 一句写着「他想要什么结论」的话被存进卡里。
 * 分成两张表的唯一后果是它们会漂（上一版一张有「要顺着」、另一张有「结论是」，于是
 * 同一句话写进 `dimension` 挡得住、写进 `view` 就漏），而「哪一类该多挡一个词」这件事
 * 没有任何产品理由说得出来。
 */
const STANCE_KEYWORDS = [
  "倾向于",
  "希望",
  "看空",
  "看多",
  "认为应该",
  "建议",
  "要顺着",
  "结论是",
];

/**
 * 红线机检：**命中这几个词的一律拒**（`STANCE_KEYWORDS`）。
 *
 * 用户卡不许成为结论的引力方向 —— 它的用途只有两个：预判挑战和适配表达。
 *
 * **这是个廉价前置过滤器，不是语义判断器。** 它挡的是明写立场的那种条目
 * （「他倾向于看空面板」）；措辞绕开关键词的漏得掉 —— `{ view: "面板价格明年见底" }`
 * 从这里直接放行，而它同样是一句立场。另一半由 system prompt §3 第 7 条兜：那一侧
 * 管的是模型自己怎么用这张卡，这一侧管的是卡里根本不该存在那种条目。两侧都要，
 * 但都不许假装自己一个人管得住。
 */
export function checkCardItem(item: unknown): { ok: true } | { ok: false; why: string } {
  if (!item || typeof item !== "object") {
    return { ok: false, why: "不是对象" };
  }

  const obj = item as Record<string, unknown>;

  // 挑战维度：必须是「他容易挑战什么」，不是「他倾向于什么结论」
  if ("dimension" in obj && typeof obj.dimension === "string") {
    const dimension = obj.dimension as string;
    if (STANCE_KEYWORDS.some((kw) => dimension.includes(kw))) {
      return { ok: false, why: "挑战维度不许含立场关键词" };
    }
    return { ok: true };
  }

  // 长期论点：必须是「他长期关注什么」，不是「他希望结论是什么」
  if ("view" in obj && typeof obj.view === "string") {
    const view = obj.view as string;
    if (STANCE_KEYWORDS.some((kw) => view.includes(kw))) {
      return { ok: false, why: "长期论点不许含立场关键词" };
    }
    return { ok: true };
  }

  // 表达偏好：这一块是合法的用途
  if ("granularity" in obj || "riskStance" in obj || "expression" in obj) {
    return { ok: true };
  }

  return { ok: false, why: "不认识的卡条目类型" };
}

/**
 * 压缩版用户卡。≤500 token 的压缩版，砍掉最不常出现的那些。
 *
 * 砍的口径：
 * - **按 `count` 降序留挑战维度**
 * - **`preferences` 三栏与 `revisitHabit` 一律不砍**（总共不到一百字，正是「适配表达」那一半的全部内容）
 * - **`longTermViews` 排在挑战维度之后，字数不够就整块不带** —— 长期论点是最容易被读成「他想要的结论」的一块，宁可不带
 */
export function packUserCard(card: UserCard): string {
  const MAX_CHARS = 400; // ≈500 token 的中文字符代理（保守估计，确保能砍掉低频项）
  const parts: string[] = [];

  // 偏好三栏一律带上
  const prefParts: string[] = [];
  if (card.preferences.granularity) prefParts.push(`粒度偏好：${card.preferences.granularity}`);
  if (card.preferences.riskStance) prefParts.push(`风险立场偏好：${card.preferences.riskStance}`);
  if (card.preferences.expression) prefParts.push(`表达偏好：${card.preferences.expression}`);
  if (card.revisitHabit) prefParts.push(`引用习惯：${card.revisitHabit}`);
  parts.push(...prefParts);

  /*
   * 挑战维度按 count 降序。
   *
   * **表头要等到真有一行装得下才 push。** 偏好三栏不参与砍且排在前面，所以偏好文字
   * 一长就会把预算吃光，一条维度都装不进 —— 那时前缀末尾留下的是一个「常挑战维度：」
   * 加底下什么都没有。给模型一个空标题不如不给：它只能理解成「他没有常挑的维度」，
   * 而真相是这一块被字数砍掉了。
   */
  const sorted = [...card.challengeDimensions].sort((a, b) => b.count - a.count);
  if (sorted.length > 0) {
    const header = "常挑战维度：";
    const dimLines: string[] = [];
    for (const d of sorted) {
      const line = `${d.dimension}（出现 ${d.count} 次）`;
      const joined = [...parts, header, ...dimLines, line].join("\n");
      if (joined.length > MAX_CHARS) break;
      dimLines.push(line);
    }
    if (dimLines.length > 0) parts.push(header, ...dimLines);
  }

  // 长期论点排在最后，字数不够就整块不带
  if (card.longTermViews.length > 0) {
    const viewParts: string[] = ["长期论点："];
    let allFit = true;
    for (const v of card.longTermViews) {
      const line = `${v.view}（首次出现：${v.firstSeen}，最近变化：${v.recentChange}）`;
      const joined = [...parts, ...viewParts, line].join("\n");
      if (joined.length > MAX_CHARS) {
        allFit = false;
        break;
      }
      viewParts.push(line);
    }
    /*
     * 只有全部长期论点都装得下才真的带上。
     *
     * 上一版这里是 `allFit && viewParts.length === card.longTermViews.length + 1` ——
     * 后半在 `allFit` 为真时必然成立（循环没 break 就等于每一条都 push 过），是一个
     * 恒真的合取。摘掉它，读的人不必再去想「这两个条件什么时候会不一致」。
     */
    if (allFit) {
      parts.push(...viewParts);
    }
  }

  return parts.join("\n");
}

/**
 * 按议题相似度取 top-k。
 *
 * 口径写死四条：
 * 1. 相似度就是 `issueTags` 与入参的**重合标签个数**
 * 2. **零重合的一条不进，即便 k 还有余量** —— 前缀里塞不相干的判断比少塞几条更坏
 * 3. 个数相同按输入原序（夹具里四条 `confirmedAt` 相同，靠原序才有确定结果）
 * 4. 只取 `status: "active"` —— 被推翻的记忆留在库里是为了回答「当初为什么那么判」，不是继续当当前判断递给模型
 */
export function pickDecisionMemories(
  all: readonly DecisionMemory[],
  issueTags: readonly string[],
  k: number,
): DecisionMemory[] {
  const active = all.filter((m) => m.status === "active");
  const tagSet = new Set(issueTags);

  // 算重合度
  const scored = active.map((m) => {
    const overlap = m.issueTags.filter((t) => tagSet.has(t)).length;
    return { m, overlap };
  });

  // 零重合的不进
  const nonZero = scored.filter((x) => x.overlap > 0);

  // 按重合度降序，个数相同按原序
  nonZero.sort((a, b) => b.overlap - a.overlap);

  return nonZero.slice(0, k).map((x) => x.m);
}

/**
 * 新证据命中了哪几条推翻条件。
 *
 * **只吃 `id` 与 `claim` 两栏。** 命中判断比的是证据那句话与推翻条件的文字，用不到口径、
 * 引句、独立性那些栏；把参数收窄到这两栏，夹具才照实写得出来（`Evidence` 全字段十七栏，
 * 为了两栏去伪造另外十五栏，写出来的夹具反而没人看得懂它在测什么）。
 *
 * **命中判断是文字包含**（推翻条件那句话出现在证据的 `claim` 里）。这跟 `NOT_A_TRIGGER` 一样
 * 是个**廉价前置过滤器，不是语义判断器** —— 它漏得掉「48.3%」这种只有数字对得上、文字对不上
 * 的写法。命中了就把提示注进前缀让模型和人自己看，漏了由人读板兜住，不假装它是判定。
 *
 * **同一条（记忆 + 条件）只回一次。** 台账上两条证据说的常常是同一件事，两条都含着
 * 同一句推翻条件时，不去重就等于让前缀里同一行警告印两遍 —— 而重复的警告读起来像
 * 两件事，会被当成「这条判断被推翻了两次」。返回值里没有证据编号那一栏（签名只有
 * `memoryId` 与 `condition`），所以「是哪几条证据命中的」本来就答不出，去重不丢信息。
 */
export function hitOverturn(
  all: readonly DecisionMemory[],
  evidence: readonly Pick<Evidence, "id" | "claim">[],
): { memoryId: string; condition: string }[] {
  const hits: { memoryId: string; condition: string }[] = [];
  const seen = new Set<string>();

  for (const m of all) {
    if (m.status !== "active") continue;
    for (const cond of m.overturnConditions) {
      for (const ev of evidence) {
        if (!ev.claim.includes(cond)) continue;
        const key = `${m.id}｜${cond}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ memoryId: m.id, condition: cond });
      }
    }
  }

  return hits;
}

/**
 * 把一条记忆标成被推翻，并链到推翻它的那一条。**不删** —— 删了就答不出「当初为什么那么判」。
 *
 * 返回新的一整份，不原地改（测试要能断言原数组没被动过）。这个函数存在是因为「被推翻的
 * 记忆链到推翻它的那条」这件事必须有一段真代码跑到：断言两个夹具字段等于夹具自己写的值，
 * 证明的只是夹具照断言写的。
 */
export function overturn(
  all: readonly DecisionMemory[],
  memoryId: string,
  by: string,
): DecisionMemory[] {
  return all.map((m) => {
    if (m.id === memoryId) {
      return { ...m, status: "overturned" as const, overturnedBy: by };
    }
    return m;
  });
}
