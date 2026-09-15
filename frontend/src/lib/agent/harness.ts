/**
 * Harness 基类。对齐自 `tkos-lab/src/tkos_lab/agents/base.py`。
 *
 * 每一步都进 trace，每一次模型调用都累计 token —— 这两件事在这里做掉，
 * 各条链路不需要也不应该自己记。
 *
 * ## 为什么是「被组合」而不是「被继承」
 *
 * 实验台的基类是模板方法：`STEPS` + `advance()` + 从 state 还原现场，为的是把
 * 一次运行拆成若干次独立函数调用（Vercel 的函数一返回就被回收）。正式版有
 * `tasks.ts` 在后台整体跑，不需要单步重放（见 spec §8①）。砍掉步进机制之后
 * 模板方法就只剩「谁先谁后」这一点约束，而各条链路的步序本来就不一样。
 * 所以这里是一个具体类，各链路 `new Harness({agent})` 自己按顺序调。
 */
import {
  PREFIX,
  type ContextBundle,
  type OpenedContext,
  type Recipe,
} from "@/lib/graphknowledge";
import { openOntologyContext } from "@/lib/ontology/context";
import { callModelJson, parseJson, SpentError, type CallOpts, type Msg } from "@/lib/agent/json";
import {
  addUsage,
  callFloorMs,
  emptyUsage,
  type CallResult,
  type Effort,
  type Usage,
} from "@/lib/models/complete";
import type { Slot } from "@/lib/models/slots";
import { anchorChecks, summarize, type Check } from "@/lib/agent/checks";
import {
  assemble,
  NO_COMPANY_CONTEXT,
  wrapCompanyNarrative,
  wrapCompanyStateOnly,
} from "@/lib/agent/prompts";
import { taskReports, taskStep } from "@/lib/agent/tasks";
import type { AgentRunRecord, AgentTraceNode, DraftReport } from "@/lib/data/types";

/*
 * NO_COMPANY_CONTEXT 住在 `prompts.ts`（那边 `FILL.context` 的兜底串就是它，两处
 * 措辞分家过一次，见那边的注释）。这里原样再导出：「上下文段」的入口是 harness，
 * 各条链路和测试都从这儿取。
 */
export { NO_COMPANY_CONTEXT };

/*
 * 思考深度。档位名直接用官方的 effort 词表（low / medium / high / xhigh / max），
 * 不另起中文名 —— 多一层翻译只会让「界面上选的」和「实际发出去的」对不上。
 *
 * 同一个档位也决定 harness 自己的研究规模：一次运行只有一个「用多大力」的旋钮，
 * 模型想得更久时材料也该更厚。M7 P3 的 k/budget **不在这里**，由配方固定。
 *
 * 火山三个模型 `acceptsEffort` 都是 false，所以在正式版这个值只驱动下面这张表，
 * 从不发给模型（发过去是 400，不是被忽略）。
 */
export const DEPTH: Record<Effort, { searchK: number; maxProps: number; maxRounds: number }> = {
  low: { searchK: 3, maxProps: 3, maxRounds: 1 },
  medium: { searchK: 4, maxProps: 3, maxRounds: 1 },
  high: { searchK: 5, maxProps: 4, maxRounds: 2 },
  xhigh: { searchK: 6, maxProps: 5, maxRounds: 2 },
  max: { searchK: 8, maxProps: 6, maxRounds: 3 },
};

export const DEFAULT_DEPTH: Effort = "high";

/** 历史上存过中文档位。折成新档位，**不交给 `DEPTH[v] ?? 兜底`** —— 兜底会把
 *  旧的「最重」悄悄降成 high，而产出看不出任何异常。 */
const LEGACY_DEPTH: Record<string, Effort> = { 轻: "low", 标准: "high", 最重: "max" };

export function normalizeDepth(value: string | undefined): Effort {
  const v = (value ?? "").trim();
  if (v in DEPTH) return v as Effort;
  return LEGACY_DEPTH[v] ?? DEFAULT_DEPTH;
}

/*
 * 上了 harness 的链路。这个联合**必须是 `Channel` 的子集** —— `openContext` 拿
 * `PREFIX[this.agent]` 取前缀、把 `this.agent` 当频道传下去。加一条链路就要在
 * `graphknowledge/lookup.ts` 的 `PREFIX` 上给它一个前缀，否则这里过不了编译。
 */
export type HarnessAgent = "A1a" | "A3" | "A4" | "A5" | "A10" | "A6" | "A7";

/**
 * 哪几条链路吃本体叙述的**未压缩原文**（`include_raw`）。**2026-09-03 起一条都没有。**
 *
 * 原来是预研、深研、写回三条吃原文（`["A3", "A4", "A10"]`），理由是那一份带着
 * 「CEO 刘明华 2026-08-24 内部会议原话」「该 PDF 已向管理层汇报且未被推翻」这类
 * **来源和确认状态**，而压缩版把它们磨掉了。这个理由本身没错，放弃的就是这些。
 *
 * 关掉的理由是那一份里同时还带着**入库审计**：「仅创建 pending，不 confirm」
 * 「以 target_proposal_id 引用 shadow generation 内 CompanyVision 提案（d35744f7-…）」
 * 「来源：chunk0 文件定位」。这些是本体自己怎么存的，不是公司经营上的事实，而它们随原文
 * 一起进了 N2 排检索计划和 N5 成稿两处的上下文。ISS-222 那一轮实测 1506 → 609 字，
 * 多出来的九百字里相当一块是这类。一号位 2026-09-03 拍板：深研和对话都只用压缩后的。
 *
 * **留着这个空集合而不是把它删掉**：要让某一条链路重新吃原文，改的是这一行，不是散在
 * `openContext` 里的两处调用。（对话那条不走 harness，它在 `company-context.ts` 里
 * 另有一处，本来就是压缩版 —— 现在两处口径一致了。）
 */
const RAW_NARRATIVE_AGENTS = new Set<HarnessAgent>([]);

export type HarnessInit = {
  agent: HarnessAgent;
  slot?: Slot;
  temperature?: number;
  depth?: string;
  viewer?: string;
  /** 复现旧运行时钉回去。**没有环境变量** —— 给它一个变量意味着有人会设成某个
   *  日期然后忘掉，之后每次运行都在读一份过期视图，而产出看不出任何异常。 */
  asOf?: string;
  maxTokens?: number;
  /**
   * 这一轮**整个**最多跑多久（毫秒），从 `new Harness` 那一刻算起。**不给 = 不限**。
   *
   * 给了之后 harness 做两件事：每次调用都按剩余时间压那一次的等待上限（`timeoutMs`），
   * 以及余量低于一次调用的下限时**拒发**并在 trace 上留一条。它不做的是「到点掐断」——
   * 该少跑哪一步是链路自己的取舍（`a4/pipeline.ts` 按 `msLeft` 决定），一个不认识业务
   * 的基类只能一刀切在半截报告上。
   */
  deadlineMs?: number;
  /** prompt key → 第 ③ 段。只在这一次跑要临时换认知段时给；不给就走
   *  `prompts/cognitive/<key>.md`，见 `prompts/cognitive/README.md`。 */
  cognitive?: Record<string, string>;
  /**
   * 往任务表上报「走到第几步了」。**不给就不上报** —— 屏幕照旧只说「在跑」。
   *
   * `kind`/`id` 必须和调用方那句 `runTask(kind, id, …)` 一模一样，否则上报落在一个
   * 不存在的任务上，静默什么也不发生。所以这两个值由**开任务的那一方**传进来
   * （`store.ts` 里两处 `runTask` 紧挨着的那一行），不在链路里另写一份 —— 两处各写
   * 一份字符串，改名时只会改到一处。
   *
   * `total` 相反，是**链路自己的**性质（预研 2 步、深研 4 步），所以由链路填。
   */
  progress?: { kind: string; id: string; total: number };
};

/**
 * 就地失败时那条 Run 记录的**载体**。
 *
 * 图服务连不上这次运行必须停，这一点不变。但台账上不能什么都没有 —— 之前
 * 这条路只在服务器日志里留一行，屏幕上表现成「点了没反应」，运营台里也数不到
 * 这次失败，于是「今天有几次运行因为图服务挂了没跑成」这个问题没人答得出来。
 *
 * 所以 harness 先落一条 `status:"failed"` 的记录，挂在这个异常上抛出；调用方
 * `agentRunPut(e.run)` 之后**原样再抛**。接住它继续跑就是本文件反复在防的那件事。
 */
export class AgentRunFailed extends Error {
  constructor(
    readonly run: AgentRunRecord,
    readonly cause: unknown
  ) {
    super(run.error || "运行失败");
    this.name = "AgentRunFailed";
  }
}

let seq = 0;

export function newRunId(agent: string): string {
  seq += 1;
  return `RUN-${agent}-${Date.now().toString(36)}-${seq}`;
}

export class Harness {
  readonly agent: HarnessAgent;
  readonly slot: Slot;
  readonly temperature: number;
  readonly depth: Effort;
  readonly cognitive: Record<string, string>;
  private readonly viewer?: string;
  private readonly asOf?: string;
  private readonly maxTokens: number;
  private readonly startedAt = new Date().toISOString();
  private readonly t0 = Date.now();
  /** 到点的那个时刻。`null` = 这一轮不限时（测试和还没接上这条线的链路）。 */
  private readonly deadlineAt: number | null;
  private readonly trace: AgentTraceNode[] = [];
  private acc: Usage = emptyUsage();
  private opened: OpenedContext | null = null;
  private lastCall: CallResult | null = null;
  private readonly progress: HarnessInit["progress"];
  /** 上报到第几步了。`substep` 不动它 —— 重修不是下一步。 */
  private stepNo = 0;
  /** 当前这一步的原话，`substep` 要往它后面接轮次。 */
  private stepLabel = "";
  /**
   * 这次**试的**是哪个配方。跟锚没锚上无关 —— 配方是调用方写死的。
   * 纯外部路没有 bundle，只有这个字段还能回答「这次试的是哪个配方」。
   */
  private attemptedRecipe: Recipe | null = null;

  constructor(init: HarnessInit) {
    this.agent = init.agent;
    this.slot = init.slot ?? "pro";
    this.temperature = init.temperature ?? 0.3;
    this.depth = normalizeDepth(init.depth);
    this.cognitive = init.cognitive ?? {};
    this.viewer = init.viewer;
    this.asOf = init.asOf;
    this.maxTokens = init.maxTokens ?? 8192;
    this.deadlineAt =
      init.deadlineMs !== undefined && Number.isFinite(init.deadlineMs) && init.deadlineMs > 0
        ? this.t0 + init.deadlineMs
        : null;
    this.progress = init.progress;
  }

  /**
   * 这一轮还剩多少毫秒。**不限时的时候是 `Infinity`** —— 于是 `msLeft > 需要多少` 这种判断
   * 在两种情况下都成立，各处不用先问一句「有没有上限」。到点之后是 0，不是负数。
   */
  get msLeft(): number {
    if (this.deadlineAt === null) return Infinity;
    return Math.max(0, this.deadlineAt - Date.now());
  }

  /**
   * 进入下一步。序号 +1，原话写进任务表，屏幕上那行会动的小字读的就是它。
   *
   * 在**这一步真正开始之前**调（下一句就是那次模型调用或那次装配）。调完再报等于
   * 屏幕永远落后一步：装配上下文的那一分半里，它写着「还没开始」。
   *
   * 没配 `progress` 时是空转 —— 测试和还没接上这条线的链路照旧能跑。
   */
  step(label: string): void {
    this.stepNo += 1;
    this.stepLabel = label;
    this.report(label);
  }

  /**
   * 同一步里再跑一遍（质量门打回的重修）。**序号不动**，原话后面接一句轮次。
   *
   * 让它进序号的后果不是多一个数，是分母失效：「共 4 步」跑出「第 5 步」。而分母是
   * 这个序号唯一的价值 —— 没有它，一号位读到的只是一个会变的数字。
   */
  substep(suffix: string): void {
    this.report(`${this.stepLabel} · ${suffix}`);
  }

  private report(label: string): void {
    const p = this.progress;
    if (!p) return;
    taskStep(p.kind, p.id, { label, no: this.stepNo, total: p.total, at: new Date().toISOString() });
  }

  /**
   * 「这几份原件已经写完了」—— 这一轮还在跑的时候先摆到屏幕上（见 `DraftReport`）。
   *
   * 走的是 `step` 那同一条线（同一张任务表、同一个 kind/id），所以没配 `progress` 时同样
   * 是空转。每次给整份清单，不是追加。
   */
  reports(list: DraftReport[]): void {
    const p = this.progress;
    if (!p) return;
    taskReports(p.kind, p.id, list);
  }

  get budget(): { searchK: number; maxProps: number; maxRounds: number } {
    return DEPTH[this.depth];
  }

  get usage(): Usage {
    return this.acc;
  }

  get bundle(): ContextBundle | null {
    return this.opened?.bundle ?? null;
  }

  /**
   * 这次是不是纯外部。**没开过上下文也算** —— 那时候手上确实没有公司材料。
   *
   * **本体叙述那一支也算**（`mode:"narrative"`），而且是对的：它一个可引编号都没有，
   * 所以 A1a 该走 `a1aExternal` 那一套检查，其中「引用为空」正是这一支的硬约束。
   * 要区分「有没有公司材料」用 `narrative` 那个 getter —— 屏幕上那行溯源就靠它分档，
   * 光看 `externalOnly` 会把一段真实的经营脉络写成「本次无公司上下文」。
   */
  get externalOnly(): boolean {
    return this.opened?.mode !== "anchored";
  }

  /** 这次的公司上下文是不是本体叙述接口给的。屏幕上那行溯源按它分档。 */
  get narrative(): boolean {
    return this.opened?.mode === "narrative";
  }

  /** 为什么没锚上。屏幕上写「本次无公司上下文」时要带上它 —— 「图里没这条议题」
   *  和「议题挂着的判断图里也没有」是两回事，笼统写一句就等于查不出是哪一回事。 */
  get noAnchorReason(): string {
    return this.opened?.noAnchorReason ?? "";
  }

  get memberIds(): Set<string> {
    return new Set(this.bundle?.memberIds ?? []);
  }

  /**
   * 【公司经营状态】那一段的原文，**只在纯外部这条路上有值**。锚定时它已经在
   * `bundle.renderedMarkdown` 里，见门那边 `staticContext` 的注释。
   *
   * 屏幕上那行溯源要靠它分档：有它写「只有公司经营状态」，没有才写「本次无公司上下文」。
   */
  get companyStateOnly(): string {
    return this.opened?.staticContext ?? "";
  }

  /**
   * 该往 Prompt 第 ② 段填的东西。装 prompt 一律用这个，不要直接用
   * `bundle.renderedMarkdown` —— 纯外部时那是 undefined，落进 prompt 是空洞。
   *
   * **三档，不是两档。** 中间那一档是「锚点没命中，但公司经营状态取到了」：那 4000
   * 字跟锚点无关，一次调用就能拿到，扔掉它等于让深研在零公司上下文下写报告。它有
   * 自己的说法（`wrapCompanyStateOnly`），不能复用另外两档任何一句 —— 说成完整上下文，
   * 模型会写「公司现有判断是……」；说成什么都没有，就是手里有真材料却谎称没有。
   */
  get contextBlock(): string {
    if (!this.externalOnly) return this.bundle?.renderedMarkdown ?? NO_COMPANY_CONTEXT;
    /*
     * 叙述那一支自己一档。它跟另外两档都不能合：合进完整上下文那档，就是把一段没有任何
     * 可引编号的话按「短码可以照原样引用」去教模型；合进只有经营状态那档，就是把手上
     * 真有的、跟这条输入相关的材料判成不相关。两句话的差别见 `wrapCompanyNarrative`。
     */
    if (this.narrative) {
      const text = this.bundle?.renderedMarkdown ?? "";
      return text ? wrapCompanyNarrative(text) : NO_COMPANY_CONTEXT;
    }
    const p0 = this.companyStateOnly;
    return p0 ? wrapCompanyStateOnly(p0) : NO_COMPANY_CONTEXT;
  }

  note(label: string, detail: Record<string, unknown> = {}, kind = "local"): void {
    this.trace.push({ at: new Date().toISOString(), label, kind, detail });
  }

  /**
   * 选锚点 + 装上下文。返回**这次有没有公司上下文**。
   *
   * 各条链路的第一步都是这一句。三态在上半的 `openContext()` 里就分开了：
   * 命中 → 装配并冻结；`AnchorNotFound` → 那扇门自己吃掉，这里拿到
   * `mode:"external_only"`；`GraphKnowledgeUnavailable` → 原样抛出，就地失败。
   *
   * 这里的 catch **不改变控制流**：它落一条 `status:"failed"` 的 Run 记录，
   * 然后把记录挂在 `AgentRunFailed` 上原样抛出去（见那个类的注释）。真正危险的
   * 是把异常吞掉当纯外部继续跑 —— 那会让图服务一停机所有运行都自动降级，还照样
   * 产出一份格式完整的报告。**不要在这里加 `return` 或 `this.note` 之后往下走。**
   */
  async openContext(
    recipe: Recipe,
    q: string,
    /** `anchorCode` 复现旧运行；`judgmentCodes` 是这条议题挂着的判断号（S02 与 S03 认）。 */
    opts: { anchorCode?: string; judgmentCodes?: string[] } = {}
  ): Promise<boolean> {
    this.attemptedRecipe = recipe;
    let opened: OpenedContext;
    try {
      opened = await openOntologyContext({
        recipe,
        prefix: PREFIX[this.agent],
        channel: this.agent,
        q,
        anchorCode: opts.anchorCode,
        judgmentCodes: opts.judgmentCodes,
        viewer: this.viewer,
        asOf: this.asOf,
        includeRaw: RAW_NARRATIVE_AGENTS.has(this.agent),
      });
    } catch (e) {
      throw new AgentRunFailed(
        this.finish({ status: "failed", error: e instanceof Error ? e.message : String(e) }),
        e
      );
    }
    this.opened = opened;
    for (const n of opened.trace) this.trace.push({ ...n });
    if (opened.mode === "narrative") {
      /*
       * 这一档也要记，理由和下面那档一样：两种情况下这条链路手上的材料不一样厚。
       * 这里多记一样东西 —— **吃的是原文还是压缩版**。两份差的不是长度是来源和确认
       * 状态，事后比对两份报告时，「为什么这一份引得出处、那一份引不出」的答案就在这行。
       */
      this.note("公司上下文来自本体叙述接口", {
        chars: opened.bundle?.renderedMarkdown.length ?? 0,
        includeRaw: RAW_NARRATIVE_AGENTS.has(this.agent),
        note:
          "只有公司层的语义记忆（愿景 / Outcome / Mission / 经营原则）；" +
          "本体的工作记忆（议题+判断+共识）还没建起来，所以这一轮没有这条议题的既有判断。" +
          "没有锚点、没有可引编号，引用必须为空",
      });
    }
    if (opened.mode === "external_only") {
      // 有没有装上 P0 要记进 trace：两种情况下这条链路手上的材料不一样厚，事后
      // 比对两次运行的产出时，这一行是唯一看得出差别在哪的地方。
      this.note("转纯外部", {
        why: opened.noAnchorReason,
        companyStateChars: opened.staticContext.length,
        note: opened.staticContext
          ? "这不是故障。只有【公司经营状态】，没有这条议题的既有认识；引用必须为空"
          : "这不是故障。没有公司上下文，本次全程只用输入原文与外部材料；引用必须为空",
      });
    }
    // 叙述那一支手上有一整段真实的经营脉络，所以这里是 true —— 这个返回值答的是
    // 「这次有没有公司上下文」，不是「有没有锚点」（有没有锚点看 `externalOnly`）。
    return opened.mode !== "external_only";
  }

  /**
   * 调一次模型，prompt 由 `prompts/engineering/<key>.md` 五段装配。
   *
   * 返回的是**对象**：下游（自检、路由、写卡）全都按对象取字段，光检查「能不能
   * parse」放它过去，就会在几帧之外炸成 `undefined is not an object` —— 堆栈指向
   * 自检代码，真正的原因（模型输出的形状不对）反而看不见。所以在边界上判形状。
   */
  async callPrompt(
    key: string,
    parts: { input?: string; context?: string; evidence?: string; challenges?: string },
    opts: { slot?: Slot; maxTokens?: number; temperature?: number } = {}
  ): Promise<Record<string, unknown>> {
    const p = await assemble(key, { ...parts, cognitive: this.cognitive[key] });
    const r = await this.callMessages(
      `模型调用 · ${key}`,
      [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
      opts,
      { promptKey: key, cognitiveSource: p.cognitiveSource, promptChars: p.chars },
      key
    );
    /*
     * 取的是上面那句 `callMessages` **刚 push 进去的那个节点** —— 顺序耦合，靠的是
     * 「callMessages 的最后一句是 push」。中间不许再插 `note()`：插了之后
     * `shapeFixed` / `error` 会写到那条 note 上，而结果页只会显示一条没有报错的模型
     * 调用和一条挂着报错的本地记事，从屏幕上完全看不出是记错了地方。
     */
    const node = this.trace[this.trace.length - 1];
    let parsed: unknown;
    try {
      parsed = parseJson<unknown>(r.text);
    } catch (e) {
      node.error = `输出不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    }
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
      // 单元素数组是同一个对象套了层壳，拆开就是要的东西。拆了要留痕：不然
      // 「这个模型需要更强的格式约束」这件事在结果页上无从得知。
      node.detail.shapeFixed = "模型把对象包在单元素数组里返回，已拆开";
      return parsed[0] as Record<string, unknown>;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const got = Array.isArray(parsed) ? `数组（${parsed.length} 个元素）` : typeof parsed;
      node.error = `输出不是 JSON 对象，是 ${got}`;
      throw new Error(node.error);
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * 调一次模型，messages 由调用方自己拼。A3/A4 走这条 —— 它们的 prompt 是 TS
   * builder，本轮不搬成 md（spec §3 决策 4：输出形状与 validate 循环不动）。
   */
  async callMessages(
    label: string,
    messages: Msg[],
    /** `json:false` = 这一次要的是自由文本（A4 报告那一层），不套 json_object。 */
    opts: {
      slot?: Slot;
      maxTokens?: number;
      temperature?: number;
      json?: boolean;
      /**
       * 这一次的思考深度，盖掉整轮那一档（`this.depth`）。
       *
       * 分节出稿那一支要它（补遗 §3）：大纲和收口是全局取舍，值得高档；逐节写作手上只有
       * 自己那几条证据，同一档跑十次是把钱花在同一件已经想清楚的事上。
       */
      effort?: Effort;
      /**
       * 话说到多细。**只有出稿那几次给 `high`**（补遗 §3）—— 抽命题、抽证据那几次要的是
       * 一份紧凑的 JSON。只有认这个字段的模型收得到，见 `callModel` 那个同名参数。
       */
      verbosity?: "low" | "medium" | "high";
      /** JSONL 被截断时接着写几次。见 `CallOpts.jsonlContinue`。 */
      jsonlContinue?: number;
      /** 截断又不续写时留整行还是抛。见 `CallOpts.onLength`。 */
      onLength?: "throw" | "keep";
      /**
       * 这一次**最多等多久**（毫秒），比整轮剩余时间更紧的那个上限。不给 = 就用剩余时间。
       *
       * 2026-09-07 加（§3.E）。在这之前每一次调用递下去的都是 `this.msLeft` —— 整轮剩下的
       * 全部时间。于是一次卡住的分节调用可以把收口那一次的位置一并等掉：发之前
       * `room()` 判「够一节加收口」，等它超时回来剩余已经是 0，而收口拿着核心判断横幅。
       * ISS-239 那一轮 S1/S2 各等满 420 秒就是这个形状。
       *
       * 该给多少由链路算（`a4/deadline.ts` 的 `callBudget`：剩余总时长减去收口保留）——
       * 一个不认识业务的基类不知道后面还有哪几步必须做。这里只做两件事：**取更紧的那个**，
       * 以及**用它去判这一次值不值得发**（预算低于这个槽位的下限就别发了）。
       *
       * 它一路递进 `complete.ts` 的 `AbortSignal.timeout`，**真的中止那次 HTTP**，不是
       * `Promise.race` 之后留一个后台请求接着烧钱。
       */
      wallMs?: number;
    } = {},
    extraDetail: Record<string, unknown> = {},
    hint?: string
  ): Promise<CallResult> {
    const at = new Date().toISOString();
    const t = Date.now();
    /*
     * 到点了就不发。**这是兜底，不是主闸** —— 该少跑哪一步由链路按 `msLeft` 自己取舍
     * （那边才知道少跑哪一步损失最小，并且会把少跑的那一句记进缺口清单）。这里挡的是
     * 漏判的那几处：与其等一个注定超时的回复再记一句「调用超时」，不如现在就说清楚是
     * 时间到了。
     *
     * 抛而不是返回一个空结果：空正文在下游会被当成「模型没写」，而那是另一回事。
     */
    /*
     * **取更紧的那个。** `msLeft` 是整轮还剩多少，`opts.wallMs` 是链路给这一次划的预算
     * （剩余总时长减去后面必须做的那几步）。两个都在的时候，后者永远该赢 —— 前者放行的
     * 那一段里有一部分是收口的位置。
     */
    const left = Math.min(this.msLeft, opts.wallMs ?? Number.POSITIVE_INFINITY);
    // 下限按槽位分档：首包 80 秒的那条出口，剩 60 秒时发出去必死（见 `callFloorMs`）。
    const floor = callFloorMs(opts.slot ?? this.slot);
    if (left < floor) {
      const error =
        `这一轮的时间上限到了：只剩 ${Math.round(left / 1000)}s，` +
        `不够发一次调用（这个槽位至少要 ${floor / 1000}s），这一次没发出去。`;
      this.trace.push({ at, label, kind: "model", ms: 0, detail: { ...extraDetail }, error });
      throw new Error(error);
    }
    const callOpts: CallOpts = {
      slot: opts.slot ?? this.slot,
      maxTokens: opts.maxTokens ?? this.maxTokens,
      temperature: opts.temperature ?? this.temperature,
      json: opts.json,
      // 只有认这个字段的模型会收到它（`complete.ts` 判 `acceptsEffort`）。
      effort: opts.effort ?? this.depth,
      ...(opts.verbosity ? { verbosity: opts.verbosity } : {}),
      ...(opts.jsonlContinue ? { jsonlContinue: opts.jsonlContinue } : {}),
      ...(opts.onLength ? { onLength: opts.onLength } : {}),
      // 不限时的时候整个不带这个键，而不是把 `Infinity` 递下去：那边认得出无穷（会退回
      // 自己的 180s），但一个「超时上限 = 无穷」的字段读起来像「永不超时」，那是错的。
      ...(Number.isFinite(left) ? { timeoutMs: left } : {}),
      hint,
    };
    let r: CallResult;
    try {
      r = await callModelJson(messages, callOpts);
    } catch (e) {
      /*
       * **失败也可能是花过钱的。** 额度用完在思考上、被 `max_tokens` 截断的那几种，模型
       * 已经算完了，`usage` 就在异常上（`SpentError`）—— 不加进来的话，一轮里失败越多、
       * 账看起来越便宜（`RUN-A4-mth5jkf0-6` 两次 8000 token 的计划调用在账上是 0）。
       *
       * 这一条同时进 `this.acc` 和 trace：`cost:report` 读的是 trace 那一份，运营台上的
       * 合计读的是 `acc`，两处漏一处都会让同一轮出现两个价钱。
       */
      const spent = e instanceof SpentError ? e.spent : null;
      if (spent) this.acc = addUsage(this.acc, spent.usage);
      this.trace.push({
        at,
        label,
        kind: "model",
        ms: Date.now() - t,
        detail: {
          ...extraDetail,
          slot: spent?.slot ?? callOpts.slot,
          ...(spent
            ? {
                alias: spent.alias,
                providerModelId: spent.providerModelId,
                effortSent: spent.effortSent,
                stopReason: spent.stopReason,
                ...(spent.queuedMs ? { queuedMs: spent.queuedMs } : {}),
              }
            : {}),
        },
        ...(spent ? { usage: spent.usage } : {}),
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    this.acc = addUsage(this.acc, r.usage);
    this.lastCall = r;
    this.trace.push({
      at,
      label,
      kind: "model",
      ms: r.ms,
      detail: {
        ...extraDetail,
        slot: r.slot,
        alias: r.alias,
        providerModelId: r.providerModelId,
        // 实际发出去的推理档。**空 = 这个模型不吃这个字段，不是「没选」。**
        effortSent: r.effortSent,
        stopReason: r.stopReason,
        /*
         * 在出口限速器门口排了多久（`models/gate.ts`）。**和 `ms` 分开，而且只在真排过队时
         * 才出现** —— 没排队的那一次多一个 `queuedMs: 0`，读 trace 的人得先把每一条都看一遍
         * 才知道哪几条是真等过。
         *
         * 分开记的理由：并进 `ms` 的话，限速器一生效，trace 上每一条都会变慢，而那件事只能
         * 被读成「这个模型今天慢」，于是去查出口、去调超时 —— 查的是一件没发生的事。
         */
        ...(r.queuedMs ? { queuedMs: r.queuedMs } : {}),
      },
      usage: r.usage,
    });
    return r;
  }

  /** 收尾：拼出可复现的 Run 记录。锚点自检在这里自动补上（和实验台一致）。 */
  finish(res: {
    status: AgentRunRecord["status"];
    input?: string;
    output?: Record<string, unknown> | null;
    route?: AgentRunRecord["route"];
    checks?: Check[];
    violations?: string[];
    degraded?: boolean;
    /** 第一轮被挡下来的违规。重修成功也传 —— 理由写在 `AgentRunRecord` 那个字段上。 */
    firstRoundViolations?: string[];
    /** 一条外部证据都没入账时那句声明的标题。有证据就不传。 */
    noExternalEvidence?: string;
    error?: string;
  }): AgentRunRecord {
    const checks = [...(res.checks ?? []), ...(this.opened ? anchorChecks(this.opened) : [])];
    const b = this.bundle;
    return {
      id: newRunId(this.agent),
      agent: this.agent,
      status: res.status,
      input: res.input ?? "",
      output: res.output ?? null,
      ...(res.route ? { route: res.route } : {}),
      contextMode: this.opened ? this.opened.mode : "",
      ...(this.opened?.noAnchorReason ? { noAnchorReason: this.opened.noAnchorReason } : {}),
      trace: this.trace.map((n) => ({ ...n })),
      checks,
      checkSummary: summarize(checks),
      usage: this.acc,
      ...(res.violations?.length ? { violations: res.violations } : {}),
      ...(res.firstRoundViolations?.length
        ? { firstRoundViolations: res.firstRoundViolations }
        : {}),
      ...(res.degraded ? { degraded: true } : {}),
      ...(res.noExternalEvidence ? { noExternalEvidence: res.noExternalEvidence } : {}),
      slot: this.slot,
      modelAlias: this.lastCall?.alias ?? "",
      providerModelId: this.lastCall?.providerModelId ?? "",
      depth: this.depth,
      snapshotId: this.opened?.snapshotId ?? "",
      // 配方取「这次试的那个」而不是 bundle 上的：纯外部路没有 bundle，从 bundle
      // 取的话台账上看不出这次试的是哪个配方，而它跟锚没锚上无关。
      contextRecipe: this.attemptedRecipe ?? b?.recipe ?? "",
      contextAnchor: b?.anchorCode ?? "",
      contextViewer: b?.viewer ?? "",
      contextAsOf: b?.asOf ?? "",
      graphknowledgeBaseUrl: b?.sourceBaseUrl ?? "",
      warnings: this.opened?.warnings ?? [],
      ...(res.error ? { error: res.error } : {}),
      createdAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - this.t0,
    };
  }
}
