/**
 * 一次对谈往返：一次上游调用 + 按需工具 + 收尾出一段回应。
 *
 * 这一层把前九个任务串成一条链：`TALK_TOOLS` 发下去，模型要工具就过一遍 `admit`，
 * 放行的执行、拦下的转异步，最后收掉工具逼它开口说话。
 *
 * ## 三条只在这一层做得到的事
 *
 * 1. **`propose_point_update` 的 `point_id` 要剥掉。** schema 上它是必填的
 *    （`tools.ts:109`），而 `checkProposal` 的白名单里没有它、多出来的键整份拒
 *    （`point.ts:41`）。带着它递下去 = 每一份提议都被整份拒，而屏幕上看起来像模型不听话。
 * 2. **`escalate` 的参数是平的，落库那一侧要嵌套的。** schema 是
 *    `{ type, question?, owner?, due?, why? }`（`tools.ts:119`），`Escalation` 是
 *    `{ type, payload: { …, issueId } }`，而 `issueId` 三种都必填、又不在 schema 里
 *    （模型不知道它）。不做这一步重整，模型主动发起的升级全被 `checkEscalation` 拒掉。
 * 3. **必须当面说的那几句要拼进这一轮回应。** 每一条本轮登记的升级带一句 `tellHim`，
 *    取证查不到时还有一句「我的先验，未验证」。模型的正文里没有这些话 —— 静默升级等于
 *    这一轮撒了个谎，所以由本文件拼上去：模型正文在前，告知在后。
 *
 * ## 为什么模型正文与告知是拼起来的、而不是两次输出
 *
 * 生产那一侧的正文是流式吐出去的（`route.ts` 的 `pump`），告知只有等这一轮的工具都跑完
 * 才知道有几句。所以 `reply` 是「这一轮全部正文 + 全部告知」的完整体：调用方拿它去落库、
 * 去做质量观测，而屏幕上差的那一段由调用方补发（那一侧的注释写在 `route.ts`）。
 */

import type { ChatLookup } from "@/lib/agent/company-context";

import { renderCalculation, toolResultText, type CalcOutcome } from "./calc";
import { unknownCodes } from "./cite";
import { describeFound as describe, toFound, type Found } from "./lookup";
import type { MicroResult } from "./micro";
import type { PointProposal } from "./point";
import {
  admit,
  checkEscalation,
  tellHim,
  TALK_TOOLS,
  type Escalation,
  type Spend,
  type TalkTool,
} from "./tools";

/**
 * 发给上游的一条消息。与 `route.ts` 的 `UpMessage`（:76）同形 —— 那个 interface 没有
 * export，而这一层不该为了一个类型去改路由的导出面。同形不同源的理由同 Task 6 的
 * `TalkTool` vs `ToolDef`。
 */
export type TurnMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/**
 * 一次上游往返：发一组消息，拿回这一轮的正文与工具调用。
 *
 * **为什么是注入的，而不是走 `Harness.callMessages`**：那条路拿不到工具调用 ——
 * `CallResult`（`src/lib/models/complete.ts:54`）只有 `text`，假模型 `mockText`
 * （`src/lib/models/mock.ts`）也只会返回字符串。原生 `tool_calls` 现在只有
 * `route.ts` 的 `pump`（:306）攒得出来。所以这一层不自己去连上游：生产环境由
 * `route.ts` 用它现成的 `callUpstream` + `pump` 实现这个函数（**流式那一段一个字不改**），
 * 单测注入一个按脚本走的实现。这就是「只有模型是假的」那条边界落在本任务的位置。
 */
export type TurnRound = (
  messages: TurnMsg[],
  tools: readonly TalkTool[] | null, // null = 这一轮收掉工具，逼它开口说话
) => Promise<{ text: string; calls: { id: string; name: string; args: string }[] }>;

export type TurnDeps = {
  round: TurnRound;
  /**
   * 取证据。**同步或异步都收** —— 生产那一侧要懒取报告（第一次真被问到证据时才读库，
   * 摆在轮首等于每发一句话都先等一次读），而单测那几个桩是同步的。放宽而不是换成
   * `Promise` 是为了让既有的同步桩一个都不用改。
   */
  lookup(q: { id?: string; text?: string }): Found[] | Promise<Found[]>;
  micro(q: { question: string }): Promise<MicroResult>;
  /**
   * 从本体取几条。生产那一侧接 `ontologyLookupForChat`（`company-context.ts` 那扇门）——
   * 这一层不自己 import 图谱，理由和 route 一样：三态只有懂它的调用方才接得对。
   */
  ontology(q: { query: string }): Promise<ChatLookup>;
  /**
   * 程序复算报告里的算式（2026-09-05，`talk/calc.ts`）。同步、只读、不花外部时间；
   * 结果里的数字段会被 `say` 原样拼进这一轮的回应 —— 数值来自代码，模型只解释。
   */
  calculate(ask: { ref?: string; overrides?: Record<string, unknown>; overrideSource?: string }): CalcOutcome | Promise<CalcOutcome>;
  propose(p: PointProposal): void;
  escalate(e: Escalation): void;
};

export type TurnTrace = {
  /** 真跑掉的那几次。`at` 是从这一轮开始算的毫秒数。被预算拦下的不在这里 —— 它进 `escalated`。 */
  toolCalls: { name: string; at: number }[];
  escalated: Escalation[];
  /**
   * 回应里引了、但这一轮没载入过的图谱短码。
   *
   * **这一版只报不拦。** 拦下一条已经生成好的回应是产品动作（他会看到参谋话说到一半被吞
   * 掉），而这一层此刻连「这一轮载入了哪些编号」都是刚有的。先让它可观测：调用方打日志，
   * 拦不拦是下一步的事。空数组有两种含义 —— 一个都没编，或者这一轮压根没载入任何编号。
   */
  unknownCodes: string[];
  /** 规格 §8-1 的两个数（轮首 token / 整轮）。数值好不好由真模型那一轮判，这里只保证记下来。 */
  timing: { firstTokenMs: number; totalMs: number };
};

/**
 * 一轮里最多跟上游往返几次。
 *
 * 3 次是预算给的工具额度（`BUDGET.calls`），后面两次留给「被拦下之后模型改口再试」——
 * 拦下来不是硬中断，它有权再发一次别的工具。转满就把 `tools` 收成 `null` 逼它开口：
 * 一轮里工具转个没完而一句话不说，比它答错更难看（同理由见 `route.ts` 的 `MAX_TOOL_ROUNDS`）。
 */
const MAX_ROUNDS = 5;

/**
 * 一轮里最多收几份迁移提议、最多转手几个不同的缺口。
 *
 * **不写进 `BUDGET`**：那一份记的是「这一轮花掉多少外部时间」，几处共用；提议和转手都不发
 * 外部请求，算进那 3 次会把账记在不花钱的动作头上（理由写在 `tools.ts`）。而 `MAX_ROUNDS`
 * 管的是往返几次，管不了一轮里发几个 call —— 一次回复里可以带任意多个工具调用。
 *
 * 提议只收一份：一轮改的是同一条判断状态，第二份改的是同一个东西，收下两份等于后一份
 * 悄悄盖掉前一份，而屏幕上只会看到「我改了」。
 * 转手只收三条不同的缺口：出口只有三种，一轮里同一种走两次说明它在原地打转；而每一条
 * 转手都会在回应尾巴上多一句告知、在后台多起一个任务。
 */
const MAX_PROPOSALS = 1;
const MAX_ESCALATIONS = 3;

/** 只认这四个名字。上游偶尔会发一个不存在的工具名，那时候如实回它、不动预算。 */
const KNOWN = new Set([
  "micro_research",
  "evidence_lookup",
  "ontology_lookup",
  "report_calculate",
  "propose_point_update",
  "escalate",
]);

/**
 * 会真发外部请求的那几个。`BUDGET.calls` 记的是它们，不是提议和登记（口径见 `tools.ts`）。
 *
 * `ontology_lookup` 在这里面：它发的是真 HTTP（图服务），和 `evidence_lookup` 那种纯读
 * 本进程里的台账不是一回事 —— 后者留在这张表里是历史口径，改它是另一件事。
 */
const SPENDS = new Set(["micro_research", "evidence_lookup", "ontology_lookup"]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 把本体取回来的几条摆给模型看。
 *
 * 三处不许省：
 *
 * · **状态空着要明写「图未给」。** 省掉那一栏，模型读到的是一条没有状态的判断，而这一层
 *   到处在教它「已确认的是公司口径」—— 一条没标状态的会被顺理成章地当成确认过的。
 * · **语义那一路要说清「这只是有哪几条」。** P3 给不出正文（见 `lookupMembers`），不说清
 *   的话模型会拿编号和分数当内容，编出那几条说了什么。
 * · **叙述那一路要说清它是公司层的、不含这条议题的既有判断。** 本体有两层：公司层的语义
 *   记忆（愿景 / Outcome / Mission / 经营原则）和工作记忆（议题 + 判断 + 共识），而后者
 *   还没建起来。不写这句，模型手里拿着一整段真材料，最顺手的写法就是从里面推想出一句
 *   「公司之前判断……」—— 这一条比另外两条更要紧，因为另外两条错了他看得出来（一条没状态
 *   的判断、一串光秃秃的编号），这一条错了产出是一段语气笃定、格式完整的话。
 */
function renderMembers(got: Extract<ChatLookup, { kind: "found" }>): string {
  if (got.mode === "narrative") {
    return [
      "公司层的经营脉络（愿景 / 本期 Outcome / Domain 与 Mission / 经营原则，",
      "以及本体算出来的：你问的这件事挂在其中哪一条下面）：",
      "",
      "**读它之前先看清三件事**：",
      "· 这一段里**没有任何具体议题的既有判断与共识** —— 本体那一层还没建起来。所以不要说",
      "  「公司之前判断……」「我们已经达成共识……」，那种句子只可能是从下面这段推想出来的。",
      "  他问到既有判断时，照实说这一层现在还调不出来。",
      "· 下面若写着「与当前问题直接相关的节点是……」，那是**挂靠关系**不是既有结论。能说的是",
      "  「这件事落在哪条 Mission 上」，不是「公司已经想过这件事」。",
      "· 这一段**没有可引用的短码**（正文里是对象的名字），也是**转写不是原话** ——",
      "  复述时按意思写，不要把名字当编号引给他，也不要说成「公司原话是」。",
      // 空串会被下面那句 join 当成一行空行 —— 这一条没有时不该留一行空的项目符号。
      ...(got.warning ? [`· ${got.warning}`] : []),
      "",
      got.recall,
    ].join("\n");
  }
  if (got.mode === "code") {
    return got.items
      .map((m) =>
        [
          `${m.code} ${m.label}［状态：${m.status || "图未给，不等于已确认"}］`,
          m.text || "（这一条图里没有正文）",
        ].join("\n")
      )
      .join("\n\n");
  }
  const lines = got.items.map(
    (m) =>
      `· ${m.code}${m.type ? ` [${m.type}]` : ""}${
        typeof m.score === "number" ? ` ${m.score.toFixed(3)}` : ""
      }`
  );
  return [
    "图里有这几条可以再问 —— **这一路只回编号，不回正文**，要正文就拿短码再取一次：",
    ...lines,
    got.recall ? `\n召回正文：\n${got.recall}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 像 `E1` 这种编号。语义查和按号查在 `lookupEvidence` 那边是两条路。 */
const E_ID = /^E\d+$/;

/**
 * `evidence_lookup` 的参数 → `lookupEvidence` 收的那个查询。
 *
 * schema 上这个工具只有 `query` 一栏（`tools.ts:65`），而 `deps.lookup` 收的是
 * `{ id?, text? }` —— 所以像 E 编号的走按号查，其余走语义查。直接给了 `id` / `text`
 * 的也收：模型偶尔照着回应正文里的字段名发，两种形状都收比按一种猜要稳。
 */
function lookupQuery(args: Record<string, unknown>): { id?: string; text?: string } {
  const id = str(args.id);
  if (id) return { id };
  const text = str(args.text);
  if (text) return { text };
  const query = str(args.query);
  if (!query) return {};
  return E_ID.test(query) ? { id: query } : { text: query };
}

/**
 * 被拦下来那一下要转异步的是哪个缺口。
 *
 * `admit` 造 `Escalation` 时要一个问句，而问句只有调用点知道：`micro_research` 是
 * `question`，`evidence_lookup` **只有语义查那一支算**。取不出就是空串 —— 那时 `admit` 回
 * `escalate: null`，`why` 照实说，这一轮不登记升级（宁可少一条也不许转到一个说不清的缺口上）。
 *
 * 按号查那一支返回空串是有意的：`E1` 是一个内部编号，不是他的问题。拿它当问句的后果是
 * 后台真拿「E1」和「E1 反例」去搜，而屏幕上还当面说「关于「E1」这个点，我需要查证」。
 */
function questionOf(name: string, args: Record<string, unknown>): string {
  if (name === "micro_research") return str(args.question);
  if (name === "evidence_lookup") return lookupQuery(args).text ?? "";
  return "";
}

/*
 * 一条证据喂回模型的样子由 `lookup.ts` 的 `describeFound` 出（本文件按 `describe`
 * 用它）。它原来住在这里，2026-08-30 挪过去了：他按下「查一下」那一次的作答
 * （`check.ts`）是第三个要拼同一份形状的地方，而那一处 import 一整个对谈轮只为了
 * 拼一行字说不过去。为什么三处必须同源，写在那一侧。
 */

/**
 * 跑一轮对谈。
 *
 * **不碰模型账。** 上游那一次由 `deps.round` 发（route 那一侧有自己的 SSE 路），取证那一次
 * 由 `deps.micro` 的实现自己开 harness、自己记 —— 记账单位是「这一次取证」。本函数因此不收
 * harness：收下来只会让人以为这一层记着什么账。
 */
export async function runTalkTurn(
  deps: TurnDeps,
  o: {
    system: string;
    prefix: string;
    history: string;
    ask: string;
    /** 每一次升级的 payload 都要它（Task 6 的 `admit` 收的就是这个 ctx）。 */
    issueId: string;
    /**
     * 这条议题手上有没有深研报告。**只有交接深研那一支的告知读它** —— 已有报告时要如实说
     * 这个工具不会作废现有报告，而不是许诺「我需要回到深研重新梳理」（那句话在已有报告时
     * 做不到，落库那一侧本来就不会作废现有报告）。
     */
    hasReport: boolean;
    /**
     * 开局那次预取载入的图谱编号（`companyContextForChat` 的 `members`）。
     *
     * 轮内 `ontology_lookup` 取回来的会接着往这个集合里加 —— 两者合起来就是「这一轮他能
     * 引的短码」。**空数组是合法的**：图挂了、或者纯外部那一档，这一轮一个可引的短码都没有，
     * 那时下面的机检整个不报（全是误报的清单等于没有清单）。
     */
    loadedCodes?: readonly string[];
    /**
     * 读表。**注入而不是直接 `Date.now()`** —— 超时那一档（`BUDGET.syncTimeoutMs`）
     * 是这一层唯一按时间分叉的地方，不注入就只能靠真等 30 秒来测它。
     */
    nowMs(): number;
  },
): Promise<{ reply: string; trace: TurnTrace }> {
  const startedAt = o.nowMs();
  const spend: Spend = { calls: 0, micro: 0, ontology: 0, startedAt };
  const trace: TurnTrace = {
    toolCalls: [],
    escalated: [],
    unknownCodes: [],
    timing: { firstTokenMs: 0, totalMs: 0 },
  };

  /** 这一轮他能引的短码：开局预取那批，加上轮内取回来的。 */
  const loaded = new Set<string>(o.loadedCodes ?? []);

  /** 必须当面说的那几句。同一句只说一次。 */
  const mustSay: string[] = [];
  const say = (line: string) => {
    if (line && !mustSay.includes(line)) mustSay.push(line);
  };

  /** 记录动作的失败不许把这一轮的回应吞掉 —— 咽掉但留痕。 */
  const record = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[对谈] ${what}没记下来`, e);
    }
  };

  /** 这一轮已经转过的那几个缺口。同 `type` + 同问句（交接深研是同理由）算同一条。 */
  const gaps = new Set<string>();
  const gapOf = (e: Escalation): string =>
    e.type === "deep_research_handoff" ? `${e.type}｜${e.payload.why}` : `${e.type}｜${e.payload.question}`;

  /** 一次转手的四种结果。四种各说一种话，不许含糊成一句通用的。 */
  type Landed =
    | { kind: "landed" }
    | { kind: "again" }
    | { kind: "capped" }
    | { kind: "bad"; why: string[] };

  /**
   * 登记一条升级。**自己造的那几条也走这里** —— `checkEscalation` 是这一层和落库那一层之间
   * 唯一的一根线，绕过去就等于两头各认一种形状；而这一轮的条数上限也只有摆在这个出口上才
   * 管得住 `land()` 内部自己造的那几条（查不到那条、被预算拦下那条），光在模型那一侧设限
   * 等于没设。
   */
  const land = (e: unknown): Landed => {
    const checked = checkEscalation(e);
    if (!checked.ok) return { kind: "bad", why: checked.why };
    const gap = gapOf(checked.value);
    if (gaps.has(gap)) return { kind: "again" };
    if (gaps.size >= MAX_ESCALATIONS) return { kind: "capped" };
    gaps.add(gap);
    trace.escalated.push(checked.value);
    record("这次转手", () => deps.escalate(checked.value));
    say(tellHim(checked.value, { reportAlreadyThere: o.hasReport }));
    return { kind: "landed" };
  };

  /** 一次转手的结果 → 喂回模型的那半句。 */
  const noteOf = (r: Landed): string => {
    if (r.kind === "landed") return "这个缺口已经转成异步查证，也在这一轮当面说了。";
    if (r.kind === "again") return "这个缺口这一轮已经转过一次，不再重复登记。";
    if (r.kind === "capped") return `这一轮的转手已经收满 ${MAX_ESCALATIONS} 条，剩下的留到下一轮再说。`;
    return `这个缺口没能登记下来：${r.why.join("；")}。`;
  };

  const messages: TurnMsg[] = [
    { role: "system", content: o.system },
    { role: "system", content: o.prefix },
  ];
  if (o.history.trim()) {
    messages.push({ role: "system", content: `到这一刻你们说过的话：\n\n${o.history}` });
  }
  messages.push({ role: "user", content: o.ask });

  /** 这一轮已经收下几份迁移提议。 */
  let proposals = 0;

  /** 一次工具调用 → 喂回模型的那段返回值。 */
  const runOne = async (c: { id: string; name: string; args: string }): Promise<string> => {
    if (!KNOWN.has(c.name)) return `没有「${c.name}」这个工具。`;

    let args: Record<string, unknown> = {};
    const raw = c.args.trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return "这次调用的参数拼不成 JSON，照参数表重发一次。";
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "参数得是一个对象。";
      }
      args = parsed as Record<string, unknown>;
    }

    const at = o.nowMs();
    const verdict = admit(spend, c.name, at, { issueId: o.issueId, question: questionOf(c.name, args) });
    if (!verdict.allow) {
      // 拦下来要告诉模型「这个缺口转异步了」，不是假装工具返回空。
      if (!verdict.escalate) return verdict.why;
      return `${verdict.why}。${noteOf(land(verdict.escalate))}`;
    }

    if (SPENDS.has(c.name)) spend.calls += 1;
    if (c.name === "micro_research") spend.micro += 1;
    if (c.name === "ontology_lookup") spend.ontology += 1;
    trace.toolCalls.push({ name: c.name, at: at - startedAt });

    if (c.name === "evidence_lookup") {
      const found = await deps.lookup(lookupQuery(args));
      if (found.length === 0) return "台账里没有对上的条目。说不知道，或者把它当成一个缺口去取证。";
      return found.map(describe).join("\n\n");
    }

    if (c.name === "micro_research") {
      const question = str(args.question);
      if (!question) return "取证要一个问句。";
      const res = await deps.micro({ question });
      if (res.kind === "found") {
        if (res.entries.length === 0) return "这次取证没带回条目。";
        /*
         * **形状走 `describe`，一个字都不在这里另拼。** 上一版这里内联拼了一份自称「形状与
         * `describe` 一致」的字符串，实际三处不一致：来源与原文两行顺序颠倒、缺「未标注」
         * 兜底、**整条「口径」行没了**。后果是同一条证据，这一轮刚取回来时模型看不到它的
         * 口径，下一轮按编号查回来时才看得到 —— 而口径正是这一层反复强调的东西
         * （`TALK_SYSTEM` 第 7 条「他常挑口径就先把口径写清」）。
         *
         * `Evidence → Found` 也不在这里写第二份字段映射，走 `lookup.ts` 的 `toFound` ——
         * 按编号查回来那一路用的是同一份。
         *
         * 编号是落库那一步重排过的（`landTalkEvidence`），所以他下一轮问「E8」时模型引得出、
         * 按号查也查得到 —— 没有编号的那一版，这一轮查到的东西出了这一轮就没法指认。
         */
        const lines = res.entries.map((e) => describe(toFound(e)));
        return `取到了，独立来源 ${res.independentGroups} 组：\n\n${lines.join("\n\n")}`;
      }
      /*
       * 查不到是两个终态之一（HP-5），不是异常。这一轮照先验回答，但**必须当面说清它是先验**
       * —— 这句话由本文件写死，不是等模型自己想起来。同时挂一条异步补证：许诺的下一轮要真能补上。
       */
      const line = `关于「${question}」我没查到可引的材料，下面这一句是我的先验，未验证。`;
      say(line);
      const gap = land({ type: "async_research", payload: { question, issueId: o.issueId } });
      return `${res.why}。这一轮照你的先验回答，并且把这一句原样说出来：「${line}」。${noteOf(gap)}`;
    }

    if (c.name === "report_calculate") {
      // explain 只按报告默认值算：解释含义时模型不许顺手塞一组"合理"的覆盖值进来。
      const explain = str(args.mode) !== "compute";
      const overridesRaw = explain ? undefined : args.overrides;
      const overrides =
        overridesRaw && typeof overridesRaw === "object" && !Array.isArray(overridesRaw)
          ? (overridesRaw as Record<string, unknown>)
          : undefined;
      const r = await deps.calculate({
        ref: str(args.ref) || undefined,
        overrides,
        overrideSource: str(args.override_source) || undefined,
      });
      if (r.ok) {
        // 数字段原样上屏：模型的正文在前、这一段在后，屏幕上分得清哪句是算的、哪句是解释。
        say(renderCalculation(r));
      }
      return toolResultText(r);
    }

    if (c.name === "ontology_lookup") {
      const query = str(args.query);
      if (!query) return "取本体要一个短码或者一句话。";
      const got = await deps.ontology({ query });
      if (got.kind === "unavailable") {
        /*
         * **这一句是这个分支存在的全部理由。** 图服务这一轮取不到，和「公司没记过这条」在
         * 屏幕上长得一模一样 —— 而后者会被他当成结论。所以不许只回一句空，要把「这是取不到，
         * 不是没有」写死在返回值里，不等模型自己想起来。
         */
        return `${got.note}。这一轮取不到本体，**不许说成公司没有这条** —— 照实告诉他本体这一次没取上。`;
      }
      if (got.kind === "not_found") {
        return `${got.note}。公司本体里确实没有对应的条目 —— 这是正常结果，不是故障。要么说不知道，要么把它当成一个缺口去取证。`;
      }
      for (const m of got.items) loaded.add(m.code);
      return `${got.note}

${renderMembers(got)}`;
    }

    if (c.name === "propose_point_update") {
      if (proposals >= MAX_PROPOSALS) {
        return "这一轮的迁移提议已经收下一份，要改下一轮再说。";
      }
      proposals += 1;
      // point_id 是路由参数，不是提议内容。
      // 这一轮改的是哪条判断状态，循环自己知道（o.issueId），不需要模型告诉它 ——
      // 收下这个参数只是因为规格 §4.3 这么定的，schema 也这么写着。
      const proposal = { ...args };
      delete proposal.point_id;
      record("这份提议", () => deps.propose(proposal as PointProposal));
      return "提议递下去了。它要过一遍校验才落到判断状态上，这一轮别说成已经改好了。";
    }

    // escalate：平的参数重整成嵌套形状，并把 issueId 填进去。
    const { type, ...rest } = args;
    /*
     * 模型给了的每一个键原样搬进 payload，**不按类型挑键**。多出来的那个键正是
     * 「它把两种出口搞混了」的证据（比如在转检索上带了转深研的理由）—— 静默丢掉，
     * 屏幕上就会显示成一次正常的转异步，而它其实想说的是别的事。
     */
    const landed = land({ type, payload: { ...rest, issueId: o.issueId } });
    if (landed.kind === "landed") return "已经登记，也在这一轮当面说了。";
    if (landed.kind === "bad") return `这次转手没被收下：${landed.why.join("；")}。改完再发一次。`;
    return noteOf(landed);
  };

  const texts: string[] = [];
  let sawText = false;

  for (let round = 0; ; round++) {
    const last = round >= MAX_ROUNDS;
    const r = await deps.round(messages, last ? null : TALK_TOOLS);

    if (r.text) {
      if (!sawText) {
        sawText = true;
        trace.timing.firstTokenMs = o.nowMs() - startedAt;
      }
      texts.push(r.text);
    }

    if (r.calls.length === 0 || last) break;

    messages.push({
      role: "assistant",
      content: r.text || null,
      tool_calls: r.calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    });
    for (const c of r.calls) {
      messages.push({ role: "tool", tool_call_id: c.id, content: await runOne(c) });
    }
  }

  trace.timing.totalMs = o.nowMs() - startedAt;

  /*
   * 模型正文在前、告知在后。模型自己已经说了的那一句就不再重复一遍 —— 取证查不到时
   * 那句「我的先验，未验证」是既要求它说、又由这里兜底的，两边都说会变成同一句话说两遍。
   */
  const head = texts.join("\n\n");
  const tail = mustSay.filter((line) => !head.includes(line));
  /*
   * 只查**模型自己写的那部分**（`head`），不查 `tail`：告知那几句是本文件生成的固定话术，
   * 里面的编号是我们自己填进去的，把它算进「模型编的」是自己报自己。
   */
  trace.unknownCodes = unknownCodes(head, loaded);
  return { reply: [head, ...tail].filter(Boolean).join("\n\n"), trace };
}
