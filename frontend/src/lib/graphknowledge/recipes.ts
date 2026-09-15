/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/recipes.py
 *
 * GraphKnowledge M7 的 S01/S02/S03 Agent 侧上下文装配。三配方的 P3 参数是**固定
 * 的**，不受思考深度影响：深度只驱动 harness 自己的研究规模，改 P3 的 k/budget
 * 会让「同一个议题、不同深度」拿到不同的公司上下文，两次结果就不可比了。
 */
import type { GkDynamic, GkEntity, GkVersion, GraphKnowledgeClient } from "./client";
import { AnchorNotFound, GraphKnowledgeNotFound } from "./errors";
import { clip } from "./limits";

export const MAX_CONTEXT_CHARS = 16_000;

export type Recipe = "S01" | "S02" | "S03";

/** 这次装配打了哪些端点。进 trace，是复现的一部分。 */
/*
 * `NARRATIVE` 不是这一层产生的 —— 它是本体叙述接口那一支（`src/lib/ontology/context.ts`）
 * 造 bundle 时填的那一条。放在这个联合里是因为 `ContextBundle` 是两支共用的形状，
 * 而快照、报告页、`store.ts` 都按它读。
 */
export type GkCall = {
  point: "P0" | "P1" | "P2" | "P3" | "NARRATIVE";
  path: string;
} & Record<string, unknown>;

export type ContextBundle = {
  query: string;
  recipe: Recipe;
  anchorCode: string;
  renderedMarkdown: string;
  /**
   * 这次装配摸到的所有实体编号。
   *
   * **今天只有 A1a 拿它当白名单**（`checks.ts` 的 `citedOk`：模型交上来的
   * `cited_member_ids` 逐个查在不在这一轮上下文里，不在就判「是编的」）。A3 预研和 A4
   * 深研都没接 —— 报告里引错内部编号，今天没有一处会拦。原来这行注释写的是「A3 的
   * 自检拿它当白名单」，那是过期的话。
   *
   * 它也是今天**唯一穿过这道边界的结构化数据**：别的（每条判断的 `status`、召回 seeds
   * 的分数）都被 `finish(parts)` 拼进了 `renderedMarkdown`。
   */
  memberIds: string[];
  calls: GkCall[];
  warnings: string[];
  viewer: string;
  asOf: string;
  sourceBaseUrl: string;
};

export function bundleSummary(b: ContextBundle) {
  return {
    recipe: b.recipe,
    anchorCode: b.anchorCode,
    members: b.memberIds.length,
    calls: b.calls.length,
    warnings: b.warnings.length,
    renderedChars: b.renderedMarkdown.length,
  };
}

class Builder {
  readonly members = new Set<string>();
  readonly calls: GkCall[] = [];
  readonly warnings: string[] = [];

  constructor(
    private readonly client: GraphKnowledgeClient,
    private readonly meta: {
      query: string;
      recipe: Recipe;
      anchorCode: string;
      viewer: string;
      asOf: string;
    }
  ) {}

  async p0(): Promise<string> {
    this.calls.push({
      point: "P0",
      path: "/api/v1/context/static",
      viewer: this.meta.viewer,
      as_of: this.meta.asOf,
    });
    return this.client.staticContext({ viewer: this.meta.viewer, asOf: this.meta.asOf });
  }

  async p1(code: string): Promise<GkEntity> {
    this.calls.push({ point: "P1", path: `/api/v1/entities/${code}`, view: "latest" });
    const card = await this.client.entity(code);
    this.addCard(card);
    return card;
  }

  async p2(code: string): Promise<GkEntity> {
    this.calls.push({ point: "P2", path: `/api/v1/entities/${code}`, view: "chain" });
    const chain = await this.client.chain(code);
    this.addCard(chain);
    return chain;
  }

  async p3(query: string, k: number, budget: number): Promise<GkDynamic> {
    const q = clip(query);
    this.calls.push({ point: "P3", path: "/api/v1/context/dynamic", q, k, budget });
    const result = await this.client.dynamic(q, { k, budget });
    if (result.warning) this.warnings.push(String(result.warning));
    for (const seed of result.seeds ?? []) if (seed.code) this.members.add(String(seed.code));
    return result;
  }

  /**
   * `anchorCode` 可以在这里改掉：按判断定锚点那一档，要等每个判断号都探过一次
   * 才知道图里到底有哪几条，而 Builder 是探之前就建好的。落库的
   * `contextAnchor` 必须只写**真装进去的**那些 —— 写上一条 404 的号，
   * 屏幕上就成了「以它为锚点」，而它压根没被取到。
   */
  bundle(parts: string[], anchorCode = this.meta.anchorCode): ContextBundle {
    const text = finish(parts);
    // finish() 之后还超说明预算逻辑本身坏了。这时候宁可炸，也不要把一份超预算
    // 的上下文发给模型 —— 那会撞上模型侧的截断，报错话术完全指错方向。
    if (text.length > MAX_CONTEXT_CHARS) throw new Error("上下文总预算失效");
    return {
      query: this.meta.query,
      recipe: this.meta.recipe,
      anchorCode,
      renderedMarkdown: text,
      memberIds: [...this.members].sort(),
      calls: this.calls,
      warnings: this.warnings,
      viewer: this.meta.viewer,
      asOf: this.meta.asOf,
      sourceBaseUrl: this.client.baseUrl,
    };
  }

  private addCard(card: GkEntity): void {
    if (card.code) this.members.add(String(card.code));
    for (const values of Object.values(card.relations ?? {})) {
      if (Array.isArray(values)) for (const v of values) if (v) this.members.add(String(v));
    }
  }
}

/** S01 Issue Framing：Signal → Issue → 被动摇判断。 */
export async function buildS01(
  client: GraphKnowledgeClient,
  signalCode: string,
  opts: { query: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, { ...opts, recipe: "S01", anchorCode: signalCode });
  const staticText = await b.p0();
  const signal = await b.p1(signalCode);

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【Signal 原文（照录，供「不复述」对照）】\n${signal.label ?? ""}\n` +
      textValue((signal.properties ?? {}).why, ""),
  ];

  const issues = (signal.relations ?? {}).spawns ?? [];
  const shaken: string[] = [];
  if (issues.length) {
    const issueLines: string[] = [];
    for (const issueCode of issues) {
      const issue = await b.p1(issueCode);
      const state = String((issue.properties ?? {}).state ?? "");
      issueLines.push(`${issueCode}「${issue.label ?? ""}」（${state}）`);
      for (const anchor of (issue.relations ?? {}).shakes ?? []) {
        const chain = await b.p2(anchor);
        const versions = chain.versions ?? [];
        const latest = versions[versions.length - 1];
        if (latest) {
          shaken.push(
            `${anchor} v${latest.index ?? "?"}（被 ${issueCode} 动摇）\n  ${latest.statement ?? ""}`
          );
        } else {
          shaken.push(`${anchor}（无版本链——首次形成）`);
        }
      }
    }
    parts.push(`【催生的议题】\n${issueLines.join("\n")}`);
  } else {
    parts.push("【催生的议题】\n（该信号尚未催生议题——本次调用即为此而来）");
  }

  parts.push(
    `【被动摇的在版判断】\n${shaken.length ? shaken.join("\n") : "（图内无被动摇的在版判断）"}`
  );
  parts.push(segSeeds(await b.p3(signal.label || opts.query, 5, 3000)));
  return b.bundle(parts);
}

/** S02 Pre-research：Issue → 当前判断/既有研究 → 轻量语义召回。 */
export async function buildS02(
  client: GraphKnowledgeClient,
  issueCode: string,
  opts: { query: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, { ...opts, recipe: "S02", anchorCode: issueCode });
  const staticText = await b.p0();
  const issue = await b.p1(issueCode);
  const props = issue.properties ?? {};

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【议题定义】\n${issueCode}「${issue.label ?? ""}」（${String(props.state ?? "")}）\n` +
      textValue(props.monitoringNote, ""),
  ];

  const anchors = (issue.relations ?? {}).hasJudgement ?? [];
  if (anchors.length) {
    const lines: string[] = [];
    for (const anchor of anchors) {
      const chain = await b.p2(anchor);
      const versions = chain.versions ?? [];
      const latest = versions[versions.length - 1];
      lines.push(
        latest
          ? `${anchor} v${latest.index ?? "?"}：${latest.statement ?? ""}`
          : `${anchor}（无版本链——首次形成）`
      );
      const card = await b.p1(anchor);
      const shakenBy = (card.relations ?? {}).shakenBy ?? [];
      if (shakenBy.length) lines.push(`  相邻动摇：${shakenBy.join("、")}`);
    }
    parts.push(`【当前在版判断】\n${lines.join("\n")}`);
  } else {
    parts.push("【当前在版判断】\n（尚无判断——首次形成）");
  }

  parts.push(await researchBlock(b, (issue.relations ?? {}).researchForOf ?? []));
  parts.push(segSeeds(await b.p3(issue.label || opts.query, 3, 1200)));
  return b.bundle(parts);
}

/**
 * S02 的第二条入口：**锚点是判断，不是议题。**
 *
 * 为什么要有这一条：图谱里没有前端这十条议题的 Issue 对象（前端的 ISS-001…009 是
 * `scripts/gen-seed-from-ontology.mjs` 生成种子时自己编的号），所以按 `ISS-` 前缀
 * 检索锚点一次都命中不了，每份预研都走纯外部。而**议题挂着的那些判断号在图里是
 * 真实存在的**（`01-J3` 这一类，实测 11 条全在），于是这条路不再靠检索猜议题，
 * 直接从前端已知的对应关系取判断的版本链。
 *
 * 代价写明白：这一档的「锚点」含义从议题变成判断。所以正文里**没有**
 * 【议题定义】那一段 —— 那段只有图里的 Issue 对象答得出来。这里如实写「议题在
 * 前端在办，图谱里还没有这个对象」，免得模型把它读成图内对这条议题的既有认识。
 *
 * 一条判断都不在图里时抛 `AnchorNotFound`：那是分支不是故障，由那扇门转纯外部。
 */
export async function buildS02FromJudgments(
  client: GraphKnowledgeClient,
  judgmentCodes: string[],
  opts: { query: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, {
    ...opts,
    recipe: "S02",
    anchorCode: judgmentCodes.join("+"),
  });
  const staticText = await b.p0();
  const { cards, missing } = await pickJudgments(b, judgmentCodes);

  const parts = [`【公司经营状态】\n${staticText}`, issueAbsentBlock(opts.query)];

  const lines: string[] = [];
  for (const card of cards) {
    const code = String(card.code ?? "");
    const standing = String((card.properties ?? {}).standing ?? "");
    lines.push(`${code}「${card.label ?? ""}」${standing ? `（${standing}）` : ""}`);
    lines.push(renderVersions(await b.p2(code)));
    const rel = card.relations ?? {};
    if ((rel.belongsTo ?? []).length) lines.push(`  所属：${rel.belongsTo.join("、")}`);
    if ((rel.shakenBy ?? []).length) lines.push(`  相邻动摇：${rel.shakenBy.join("、")}`);
  }
  parts.push(`【本次锚点 · 这条议题挂着的在版判断】\n${lines.join("\n")}`);

  pushMissing(b, parts, missing);

  const research = new Set<string>();
  for (const card of cards) {
    for (const code of (card.relations ?? {}).researchForOf ?? []) research.add(code);
  }
  parts.push(await researchBlock(b, [...research]));

  // P3 的 k/budget 跟 buildS02 一样，由配方固定：同一个议题换一条锚点路，
  // 语义段的厚度不该跟着变，否则两次预研不可比。
  parts.push(segSeeds(await b.p3(opts.query, 3, 1200)));
  return b.bundle(
    parts,
    cards.map((c) => String(c.code)).join("+")
  );
}

/** S03 Strategic Deep Research：完整判断史、共识边界与双路召回。 */
export async function buildS03(
  client: GraphKnowledgeClient,
  issueCode: string,
  opts: { coreQuestion: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, {
    query: opts.coreQuestion,
    recipe: "S03",
    anchorCode: issueCode,
    viewer: opts.viewer,
    asOf: opts.asOf,
  });
  const staticText = await b.p0();
  const issue = await b.p1(issueCode);
  const props = issue.properties ?? {};

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【议题】\n${issueCode}「${issue.label ?? ""}」（${String(props.state ?? "")}）`,
  ];

  const anchors = (issue.relations ?? {}).hasJudgement ?? [];
  if (anchors.length) {
    const chains: string[] = [];
    for (const anchor of anchors) chains.push(renderVersions(await b.p2(anchor)));
    parts.push(`【判断演进链】\n${chains.join("\n\n")}`);
  } else {
    parts.push("【判断演进链】\n（尚无判断——首次形成）");
  }

  const agreements = (issue.relations ?? {}).resolvedBy ?? [];
  if (agreements.length) {
    parts.push(`【既有共识与边界】\n${(await agreementLines(b, agreements)).join("\n\n")}`);
  } else {
    parts.push("【既有共识与边界】\n（议题未闭环）");
  }

  parts.push(await researchBlock(b, (issue.relations ?? {}).researchForOf ?? []));
  parts.push(
    mergedSemantic([
      ["core question", await b.p3(opts.coreQuestion, 10, 6000)],
      ["议题标题", await b.p3(issue.label || opts.coreQuestion, 5, 3000)],
    ])
  );
  return b.bundle(parts);
}

/**
 * S03 的第二条入口：**锚点是判断，不是议题。**
 *
 * 起因与 `buildS02FromJudgments` 是同一条：图谱里没有前端这些议题对象，按 `ISS-` 前缀
 * 检索一次都命中不了。原来只有预研和对谈开局绕过去了，深研照旧靠检索 —— 实测 ISS-225
 * 那一轮候选池拉不开（最低/最高 0.9098，闸落下）转纯外部，而它挂着的判断在图里是有的。
 *
 * **它不是 `buildS02FromJudgments` 换个 recipe 名。** 深研比预研多出来的那两样，在这一
 * 档也得有：
 *
 * · 【既有共识与边界】。共识挂在议题上（`resolvedBy`），而这一档手上没有议题对象，所以
 *   从判断的 `shakenBy` 往外走一跳 —— 图内那些正动摇同一条判断的议题，它们身上的共识就
 *   是公司已经在这条判断周围划过的边界。走这一跳的代价写在正文里：这些共识**不是这条
 *   前端议题自己的**。不写明来路，模型会把「别的议题定下的边界」读成「这件事公司已经
 *   定过了」，而深研恰恰要在这里做取舍。
 * · 两路语义召回。第二路按议题那一档发的是议题标题，这一档没有议题对象，改发锚点判断的
 *   标签 —— 那是这一档手上唯一一句来自图内的自然语言。
 *
 * P3 的 k/budget 照旧由配方固定（10/6000 与 5/3000）：同一个议题换一条锚点路，语义段的
 * 厚度不该跟着变，否则两次深研不可比。
 *
 * 一条判断都不在图里时抛 `AnchorNotFound`：那是分支不是故障，由那扇门转纯外部。
 */
export async function buildS03FromJudgments(
  client: GraphKnowledgeClient,
  judgmentCodes: string[],
  opts: { coreQuestion: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, {
    query: opts.coreQuestion,
    recipe: "S03",
    anchorCode: judgmentCodes.join("+"),
    viewer: opts.viewer,
    asOf: opts.asOf,
  });
  const staticText = await b.p0();
  const { cards, missing } = await pickJudgments(b, judgmentCodes);

  const parts = [`【公司经营状态】\n${staticText}`, issueAbsentBlock(opts.coreQuestion)];

  /*
   * 演进链渲染**全部版本**，跟按议题那一档同一个渲染函数。深研要在四节里做取舍，只给
   * 最新版的话，「这句话是怎么变成现在这样的」就没了 —— 而那正是取舍的依据。
   */
  const chains: string[] = [];
  for (const card of cards) {
    const code = String(card.code ?? "");
    const standing = String((card.properties ?? {}).standing ?? "");
    const rel = card.relations ?? {};
    const lines = [
      `${code}「${card.label ?? ""}」${standing ? `（${standing}）` : ""}`,
      renderVersions(await b.p2(code)),
    ];
    if ((rel.belongsTo ?? []).length) lines.push(`  所属：${rel.belongsTo.join("、")}`);
    if ((rel.shakenBy ?? []).length) lines.push(`  相邻动摇：${rel.shakenBy.join("、")}`);
    chains.push(lines.join("\n"));
  }
  parts.push(`【判断演进链 · 本次锚点】\n${chains.join("\n\n")}`);

  pushMissing(b, parts, missing);

  /*
   * 往外走一跳：图内正动摇同一条判断的那些议题。它们身上的 `resolvedBy` 是共识，
   * `researchForOf` 是既有研究 —— 这一跳只花一次 P1，两段都能凑齐。
   *
   * 这几个编号是图自己给出来的（`shakenBy`），所以不另接 404：跟另外三条配方顺着关系
   * 取下一层时一样，图给了一个取不回来的编号是图的问题，就地失败比装作没有强。
   */
  const research = new Set<string>();
  for (const card of cards) {
    for (const code of (card.relations ?? {}).researchForOf ?? []) research.add(code);
  }
  const shaking = new Set<string>();
  for (const card of cards) {
    for (const code of (card.relations ?? {}).shakenBy ?? []) shaking.add(code);
  }
  const agreements = new Set<string>();
  for (const code of shaking) {
    const rel = (await b.p1(code)).relations ?? {};
    for (const agreement of rel.resolvedBy ?? []) agreements.add(agreement);
    for (const doc of rel.researchForOf ?? []) research.add(doc);
  }

  if (agreements.size) {
    // 标题里就带上来路。这一段的每一条都是**别的议题**定下的边界，混着读会变成
    // 「这条议题公司已经定过了」——而它连图内对象都还没有。
    const lines = await agreementLines(b, [...agreements]);
    parts.push(`【既有共识与边界 · 来自图内正动摇同一条判断的议题】\n${lines.join("\n\n")}`);
  } else {
    // 不写「议题未闭环」：那是按议题那一档才答得出的话。这一档没有议题对象，答不出
    // 这条议题闭没闭环，只答得出「图内那几条相邻议题上没有共识挂载」。
    parts.push(
      "【既有共识与边界】\n（图内正动摇这几条判断的议题上没有共识挂载。这一档没有议题对象，" +
        "所以答不出这条议题自己闭没闭环。）"
    );
  }

  parts.push(await researchBlock(b, [...research]));

  /*
   * 第二路的 q 换成锚点判断的标签。空着回落到 core question：那样两路发同一句话，
   * 合并之后等于单路 —— 比发一句空串强，空串在服务端是另一种 422。
   * 长度不在这里管，`p3` 里统一 `clip`（超 100 字服务端直接 422）。
   */
  const anchorLabels = cards
    .map((c) => String(c.label ?? ""))
    .filter(Boolean)
    .join("、");
  parts.push(
    mergedSemantic([
      ["core question", await b.p3(opts.coreQuestion, 10, 6000)],
      ["锚点判断标签", await b.p3(anchorLabels || opts.coreQuestion, 5, 3000)],
    ])
  );

  return b.bundle(
    parts,
    cards.map((c) => String(c.code)).join("+")
  );
}

/**
 * 逐条探这些判断号，回来的是**真取到的那几张卡**和图内 404 的那几个号。
 *
 * 404 = 图里没有这条判断，**不是故障**：`judgmentRefs` 那层关系本来就是模型提案、待人
 * 确认的（见 `seed-tokenking.ts`），号还没进图是可能的。其它异常（连不上、被拒）照样往
 * 外抛 —— 就地失败。一条都取不到时抛 `AnchorNotFound`，那是分支不是故障，由那扇门转
 * 纯外部。
 *
 * 两条配方共用这一份：各写一份的话，某一天有人给其中一处放宽了 404 的口径，另一处照旧
 * 严着，而两条链路在同一个议题上会给出不一样的锚点，没有一处会报错。
 */
async function pickJudgments(
  b: Builder,
  codes: string[]
): Promise<{ cards: GkEntity[]; missing: string[] }> {
  const cards: GkEntity[] = [];
  const missing: string[] = [];
  for (const code of codes) {
    try {
      cards.push(await b.p1(code));
    } catch (e) {
      if (!(e instanceof GraphKnowledgeNotFound)) throw e;
      missing.push(code);
    }
  }
  if (!cards.length) {
    throw new AnchorNotFound(`图谱里没有这条议题挂着的任何判断（${codes.join("、")}）`, {
      why: "议题挂着的判断号在图谱里全都查不到",
      judgmentCodes: codes,
    });
  }
  return { cards, missing };
}

/**
 * 按判断定锚点那两档的【议题】段。
 *
 * 图里没有这条议题对象这件事必须由正文自己说出来，否则模型会把下面那串在版判断读成
 * 「图内对这条议题的既有认识」，也就是「公司已经研究过它」。两档逐字相同：措辞改了只
 * 改一处的话，同一个议题走预研和走深研会看到两种说法，而两条链路本来就是要拿同一个
 * 议题各跑一遍作对比的。
 */
const issueAbsentBlock = (title: string): string =>
  `【议题】\n${title}\n` +
  "（这条议题在前端在办，图谱里还没有对应的议题对象。所以下面是它挂着的在版判断，" +
  "不是图内对这条议题的既有认识 —— 不要当成公司已经研究过它。）";

/**
 * 图内查不到的那几条判断：正文里写一段，warnings 里记一条。
 *
 * 少了几条必须写进正文。少一条而不说，模型会把「图里只有这两条」读成「这个议题只动摇
 * 这两条判断」。两档共用一份的理由同 `issueAbsentBlock`。
 */
function pushMissing(b: Builder, parts: string[], missing: string[]): void {
  if (!missing.length) return;
  parts.push(
    `【图谱里查不到的判断】\n${missing.join("、")}（前端挂着，图内 404；本次上下文不含它们）`
  );
  b.warnings.push(`判断号图内查不到：${missing.join("、")}`);
}

/** 传共识的编号。按判断定锚点那一档要走一跳才凑得齐，所以这里收编号而不是收一张卡。 */
async function agreementLines(builder: Builder, codes: string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const code of codes) {
    const agreement = await builder.p1(code);
    const ap = agreement.properties ?? {};
    lines.push(
      `${code}「${agreement.label ?? ""}」status=${String(ap.agreementStatus ?? "")}\n` +
        `结论：${textValue(ap.text)}\n边界：${textValue(ap.boundary)}`
    );
  }
  return lines;
}

export function textValue(value: unknown, empty = "（无）"): string {
  if (Array.isArray(value)) return value.map((x) => String(x)).join("\n") || empty;
  return value === null || value === undefined || value === "" ? empty : String(value);
}

/** 传 `researchForOf` 那串编号。按判断定锚点那一档要把几条判断的挂载合起来，
 *  所以这里收编号而不是收一张卡。 */
async function researchBlock(builder: Builder, codes: string[]): Promise<string> {
  if (!codes.length) return "【既有研究】\n（图内无既有研究挂载）";
  const lines: string[] = [];
  for (const code of codes) {
    const doc = await builder.p1(code);
    lines.push(`${code}「${doc.label ?? ""}」\n${textValue((doc.properties ?? {}).text)}`);
  }
  return `【既有研究】\n${lines.join("\n\n")}`;
}

const seedLine = (s: { code?: string; type?: string; score?: number }): string =>
  `· ${s.code} [${s.type}] score=${(s.score ?? 0).toFixed(3)}`;

function segSeeds(result: GkDynamic): string {
  const query = result.query ?? "";
  const seeds = result.seeds ?? [];
  if (seeds.length) {
    return [`【语义召回】（q=${query}）`, ...seeds.map(seedLine), "", result.text ?? ""].join("\n");
  }
  // 语义段降级不是错误：P0/P1/P2 的确定性上下文照用。但必须写进正文 ——
  // 少一段而不说，模型会当成「图里没有相关材料」。
  const warning = result.warning || "无结果";
  return `【语义召回】（q=${query}）\n（语义段降级：${warning}，本次调用不含语义召回）`;
}

function mergedSemantic(routes: [string, GkDynamic][]): string {
  const best = new Map<string, { code?: string; type?: string; score?: number }>();
  for (const [, result] of routes) {
    for (const seed of result.seeds ?? []) {
      const code = seed.code;
      if (!code) continue;
      const prev = best.get(String(code));
      if (!prev || (seed.score ?? 0) > (prev.score ?? 0)) best.set(String(code), seed);
    }
  }
  const seeds = [...best.values()].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.code).localeCompare(String(b.code))
  );
  const successful = routes.filter(([, r]) => (r.seeds ?? []).length);
  const warnings = routes
    .filter(([, r]) => !(r.seeds ?? []).length)
    .map(([label, r]) => `${label}: ${r.warning || "无结果"}`);

  if (!seeds.length) {
    return `【语义召回】\n（语义段降级：${warnings.join("；")}，本次调用不含语义召回）`;
  }

  const [selectedLabel, selected] = successful.reduce((acc, cur) =>
    (cur[1].seeds?.[0]?.score ?? 0) > (acc[1].seeds?.[0]?.score ?? 0) ? cur : acc
  );
  const lines = ["【语义召回 · 双路合并】", ...seeds.map(seedLine)];
  if (warnings.length) lines.push("", `降级：${warnings.join("；")}`);
  lines.push(
    "",
    `正文采用得分最高路由：${selectedLabel}（q=${selected.query ?? ""}）`,
    selected.text ?? ""
  );
  return lines.join("\n");
}

function renderVersions(chain: GkEntity): string {
  const versions = chain.versions ?? [];
  if (!versions.length) return `（锚点 ${chain.code} 无版本链——首次形成）`;
  const lines: string[] = [];
  for (const v of versions as GkVersion[]) {
    let head = `v${v.index}[${v.status ?? ""}] ${String(v.at ?? "").slice(0, 10)}`;
    if (v.meetingLabel) head += `（${v.meetingLabel}）`;
    lines.push(head, `  ${v.statement ?? ""}`);
  }
  return lines.join("\n");
}

export function finish(parts: string[]): string {
  const text = parts.join("\n\n");
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const suffix = "\n\n（上下文超过总预算，末段已截断）";
  return text.slice(0, MAX_CONTEXT_CHARS - suffix.length).replace(/\s+$/, "") + suffix;
}
