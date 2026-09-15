/**
 * 对谈轮内的四个工具与预算拦截器。
 *
 * 这一层管的是「这一轮花掉多少外部时间」。触及预算不是硬中断 —— 规格写着「预算是
 * 升级触发器」：轮内答不完的缺口要转异步，不许静默丢掉。所以 `admit` 拦下来时带的
 * 是一个装配好的 `Escalation`，不是一个字符串标签 —— 三种 payload 每一种都要
 * `issueId`，`async_research` 还要那个问句，而这两样只有 `admit` 的调用点知道。
 */

/**
 * 对谈工具的类型。
 *
 * 与 `src/lib/agent/stage-tools.ts:ToolDef` 同形，但不去把那个 interface 导出来 ——
 * 那个文件是会话工具的，两处工具集各自演化，共用一个类型会把它们绑死。
 */
import { ontologySource } from "@/lib/ontology/source";

export type TalkTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

const s = (description: string) => ({ type: "string", description });

/**
 * `ontology_lookup` 的说明，**按当前的本体源分两份**（`TKOS_ONTOLOGY_SOURCE`）。
 *
 * 不合成一份的理由：两个源**取得到的东西不是一回事**，而这句话决定了模型什么时候会来调它。
 *
 * · 图谱那一支：两层都在。给短码取那一条的正文与状态，给一句话回「有哪几条可以再问」；
 *   **取不到是常态**。
 * · 叙述那一支：**只有公司层的语义记忆**（愿景 / Outcome / Mission / 经营原则），
 *   本体的工作记忆（议题 + 它挂着的判断 + 已有共识）还没建起来。所以「我们对 X 有过什么
 *   判断」这类问题它**答不了** —— 不写清的话模型会拿它去问那种问题，白花一次预算，而回来
 *   的是一段公司脉络，读起来又像是答上了。
 *
 * 说明里要写清它**能**答什么（这件事挂在哪条 Mission 下、公司这一期在追什么），比写清它
 * 不能答什么更管用：光说「没有判断」，模型会干脆不调它，而挂靠关系正是这一路唯一的价值。
 *
 * 两份都保留「不联网」和「取不到不是故障」这两句：前者防它把这个工具当第二个检索口用，
 * 后者防它把一次正常的空说成系统故障。
 */
const ontologyLookupDescription = (): string =>
  ontologySource() === "graph"
    ? "从公司本体里取一条既有认识：给短码（如 01-J2、ISS-D6、DOC-05）取那一条的正文与状态，" +
      "给一句话则按语义找出有哪几条可以再问。取的是公司内部已经记过的东西，不联网、不查行业数据。" +
      "图里没有对应条目是正常结果，不是故障。"
    : "取公司层的经营脉络：公司愿景、本期 Outcome、各个 Domain 与 Mission、经营原则，" +
      "以及这句话挂在其中哪一条下面。用它来回答「这件事在公司的战略路径上处在哪儿」" +
      "「本期我们在追什么」。不联网、不查行业数据。" +
      "**它没有具体议题的既有判断与共识** —— 那一层本体还没建起来，所以「我们之前对 X 下过" +
      "什么判断」「这条议题讨论到哪一步了」它答不了，别拿这类问题来问它。" +
      "这一路不回可引用的短码。取不到（服务不可达）是正常结果，不是故障。"

/**
 * 对谈轮内的四个工具。
 *
 * 工具名、参数名（`thesis`、`candidate`、`reopenIf`）、`[E{n}]` 这类标识符是模型
 * 必须照着发出来的 —— schema 里的键藏不掉，可以出现在 `description` 里。
 *
 * 真正不许进 `description` 的是模型永远不会发、也不需要知道的仓库内部名字：
 * `TalkPoint`、`PointProposal`、`checkProposal`、`Escalation`、`store.talkPoints`、
 * 任务 key 这一类。
 *
 * **「内部标识符不进回应正文」由 `TALK_SYSTEM`（Task 3）管**，上屏那一侧的机检在
 * Task 14 —— 模型看见了参数名不等于它会说出来。
 */
export const TALK_TOOLS: readonly TalkTool[] = [
  {
    type: "function",
    function: {
      name: "micro_research",
      description: "针对当前对话中的单个关键缺口做快速取证。仅当上下文与已挂证据答不了、且缺口会改变判断时调用。",
      parameters: {
        type: "object",
        properties: {
          question: s("单个问句"),
          point_id: s("结果挂回的判断状态 id"),
        },
        required: ["question", "point_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evidence_lookup",
      description: "按 E-ID 或语义检索取证据全文、原始引句、口径详情。只读。",
      parameters: {
        type: "object",
        properties: {
          query: s("E-ID（如 E1）或语义查询"),
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ontology_lookup",
      /*
       * 说明里要写清**这一路取的是公司自己记过的东西**，跟 `micro_research` 去外面查是
       * 两件事。不写清的话模型会拿它当第二个检索工具用：问一句行业数据，它先来这儿试一次，
       * 白花一次预算 —— 而回来的空结果长得像「公司没有这条」。
       *
       * 「取不到不是故障」也要写：不写的话模型会把一次正常的空结果说成系统出了问题。
       *
       * 两个源两句话，见 `ontologyLookupDescription`。
       */
      description: ontologyLookupDescription(),
      parameters: {
        type: "object",
        properties: {
          /*
           * 参数说明也跟着源走：叙述那一支没有短码可给，写着「短码（如 01-J2）」会让模型
           * 先去编一个编号发过来，而那一次往返必然白花 —— 上游只按自然语言检索。
           */
          query: s(ontologySource() === "graph" ? "短码（如 01-J2）或一句话" : "一句话"),
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_point_update",
      description:
        "对判断状态的 thesis、statements、openQuestions、candidate 提出变更提议。轮内可调用。注意：不能把判断标成已确认 —— 确认只能由人完成。",
      parameters: {
        type: "object",
        properties: {
          // point_id 是路由参数 —— Task 10 的 turn.ts 必须在转给 checkProposal 之前把它剥掉，
          // 因为 checkProposal 白名单里没有它，多出来的键整份拒（point.ts:41）。
          point_id: s("要更新的判断状态 id"),
          thesis: s("争点，可省"),
          statements: {
            type: "array",
            items: { type: "string" },
            description: "陈述列表，可省",
          },
          openQuestions: {
            type: "array",
            items: { type: "string" },
            description: "未决问题列表，可省",
          },
          candidate: {
            type: "object",
            description: "候选判断，可省或为 null",
            properties: {
              statement: s("判断陈述"),
              basis: s("依据"),
              boundary: s("边界，可省"),
              reopenIf: s("重开条件，可省"),
            },
            required: ["statement", "basis"],
          },
        },
        required: ["point_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_calculate",
      description:
        "报告里的算式（param_model）由程序复算：读该版报告的真实参数与算式，返回默认值、采用值、算式、结果、单位与边界。" +
        "只要涉及报告里的数值、算式、「这个数怎么来的」「改一个参数会怎样」，一律调它，不自己心算或誊写。只读，不发外部请求。",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["explain", "compute"],
            description: "explain = 解释含义/这个数怎么来的，只按报告默认值算，不接受覆盖；compute = 用户明确改了参数之后重算",
          },
          ref: s("算式引用（轮首目录里的 <版本>#<下标>）。报告里只有一套时可省；多套时必填，不默认拿第一套"),
          overrides: {
            type: "object",
            description: "只在用户明确改了某个参数时传：{参数id: 数值}。解释含义时不传，按报告默认算。",
            additionalProperties: { type: "number" },
          },
          override_source: s("用户改参数的原话，只写他说的那句（有 overrides 时必填，写进屏幕上的「改动来源」；这段是给他本人看的，不写「某某问」这种第三人称前缀）"),
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description:
        "显式转异步：async_research（转检索）、evidence_action（转待办）、deep_research_handoff（转深研）。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["async_research", "evidence_action", "deep_research_handoff"],
            description: "升级类型",
          },
          question: s("要回答的问题（async_research 和 evidence_action 需要）"),
          owner: s("建议责任人（evidence_action 可选）"),
          due: s("建议期限（evidence_action 可选）"),
          why: s("转手理由（deep_research_handoff 需要）"),
        },
        required: ["type"],
      },
    },
  },
] as const;

/**
 * 轮内预算：三次调用、一次取证、30 秒同步超时。
 *
 * `calls` 管的是「调了几次会发外部请求的工具」。`propose_point_update` 写本地状态、
 * `escalate` 只登记一件事，两个都不发外部请求；把它们算进那 3 次里，结果是模型查完
 * 两条证据就没法把结论落进状态 —— 账记在了不花钱的动作头上。
 *
 * `micro: 1` 是因为 micro_research 最贵：一次取证会发 5 条检索请求、读 5 篇原文、
 * 跑一轮批评。同步超时那 30 秒来自规格 §4.1 的 `sync_timeout_s: 30`。
 */
/**
 * `ontology` 那一格 2 是这么定的：他在对谈里追问一件事，典型路径是**先按语义问一次有哪
 * 几条、再按短码取其中一条**（P3 只回编号和分数，给不出正文 —— 见 `lookupMembers`）。
 * 给 1 的话那条路走不完；给 3 的话它能把整轮预算花在翻本体上，而本体是公司自己记过的
 * 东西，翻完第二遍不会多出新的。
 */
export const BUDGET = { calls: 3, micro: 1, ontology: 2, syncTimeoutMs: 30_000 } as const;

export type Spend = { calls: number; micro: number; ontology: number; startedAt: number };

/**
 * 轮内答不完时的三个出口。
 *
 * **类型定在本任务**（Task 9 只往这个文件里加 `checkEscalation` / `tellHim` 与三个
 * 落点的接线），因为 `Verdict` 直接引用它：分两处声明的话，`admit` 造出来的那个对象
 * 和 `checkEscalation` 认的那个形状会各自演化。
 */
export type Escalation =
  | { type: "async_research"; payload: { question: string; issueId: string } }
  | { type: "evidence_action"; payload: { question: string; issueId: string; owner?: string; due?: string } }
  | { type: "deep_research_handoff"; payload: { issueId: string; why: string } };

/**
 * 拦下来之后带的是一个**装配好的** `Escalation`，不是一个字符串标签。
 *
 * 裸字符串（上一版写的 `escalate: "async_research" | "none"`）在调用点造不出 payload：
 * 三种 payload 每一种都要 `issueId`，`async_research` 还要那个问句 —— 而 `issueId` 与
 * 问句只有 `admit` 的调用点知道。所以让 `admit` 收下它们并把对象造好；`"none"` 这一档
 * 去掉，它在 `Escalation` 里没有对应项，留着就是逼 turn.ts 去 switch 一个假分支。
 *
 * `escalate: null` 只有一种情况：调用点说不出这个缺口是什么（`ctx.question` 是空串）。
 * 没有问句就转不了异步 —— 那时候 `why` 里要写清「拦下了但没缺口可转」，turn.ts 照 `why`
 * 如实告诉他，不登记升级。
 */
export type Verdict = { allow: true } | { allow: false; escalate: Escalation | null; why: string };

/**
 * 判断一次工具调用是否通过预算。
 *
 * 触及预算就转异步，不是硬中断 —— 这是规格写的「预算是升级触发器，不是硬中断」。
 * 拦下来时装一个 `async_research` 出来（`ctx.question` 不为空时），将来 turn.ts
 * 照它转异步。
 *
 * 三档拦截：
 * - 第四次调用（`spend.calls >= BUDGET.calls`）
 * - 第二次 micro_research（`spend.micro >= BUDGET.micro`）
 * - 超时之后的 micro_research（`nowMs - spend.startedAt > BUDGET.syncTimeoutMs`）
 *
 * `propose_point_update` 与 `escalate` 不占检索预算 —— 它们不发外部请求。
 * 超时之后 `evidence_lookup` 照放 —— 只读那个不花外部时间。
 */
export function admit(
  spend: Spend,
  tool: string,
  nowMs: number,
  ctx: { issueId: string; question: string },
): Verdict {
  const elapsed = nowMs - spend.startedAt;
  const timedOut = elapsed > BUDGET.syncTimeoutMs;

  // propose_point_update 和 escalate 不占检索预算
  if (tool === "propose_point_update" || tool === "escalate") {
    return { allow: true };
  }

  // 第四次调用
  if (spend.calls >= BUDGET.calls) {
    const question = ctx.question.trim();
    if (!question) {
      return { allow: false, escalate: null, why: "已达调用次数上限，但没有明确的缺口可转异步" };
    }
    return {
      allow: false,
      escalate: { type: "async_research", payload: { question, issueId: ctx.issueId } },
      why: "已达调用次数上限（3 次），将缺口转为异步检索",
    };
  }

  // micro_research 的特殊限制
  if (tool === "micro_research") {
    // 第二次 micro_research
    if (spend.micro >= BUDGET.micro) {
      const question = ctx.question.trim();
      if (!question) {
        return { allow: false, escalate: null, why: "micro_research 次数已达上限，但没有明确的缺口可转异步" };
      }
      return {
        allow: false,
        escalate: { type: "async_research", payload: { question, issueId: ctx.issueId } },
        why: "micro_research 次数已达上限（1 次），将缺口转为异步检索",
      };
    }
    // 超时之后的 micro_research
    if (timedOut) {
      const question = ctx.question.trim();
      if (!question) {
        return { allow: false, escalate: null, why: "同步时间已超时，但没有明确的缺口可转异步" };
      }
      return {
        allow: false,
        escalate: { type: "async_research", payload: { question, issueId: ctx.issueId } },
        why: "同步时间已超时（30 秒），将缺口转为异步检索",
      };
    }
  }

  /*
   * ontology_lookup 的两道闸。
   *
   * **拦下来一律不转异步**（`escalate: null`），这是它和 micro_research 唯一的形态差别：
   * 三种出口里最接近的那个 `async_research` 转的是**去外面查**，而这一次问的是「公司自己
   * 记过没有」。把它转过去，后台会起一轮外部检索去回答一个只有内部才答得了的问题，而屏幕上
   * 看起来是正常转了异步 —— 他会等一个永远不会对的答案。所以照实说「这一轮本体取够了」。
   */
  if (tool === "ontology_lookup") {
    if (spend.ontology >= BUDGET.ontology) {
      return {
        allow: false,
        escalate: null,
        why: `本轮取本体已达上限（${BUDGET.ontology} 次），不再取；本体是公司自己记过的东西，再翻不会多出新的`,
      };
    }
    // 超时之后照拦：它发的是真 HTTP，和 evidence_lookup 那种纯读库不是一回事。
    if (timedOut) {
      return { allow: false, escalate: null, why: "同步时间已超时（30 秒），本轮不再取本体" };
    }
  }

  // evidence_lookup 在超时后照放 —— 只读不花外部时间
  // 其他情况：通过
  return { allow: true };
}

/**
 * 校验一个 `escalate` 工具调用的 payload。
 *
 * 按 `type` 分别校验，并且照 `checkProposal` 那条已落地的规矩：多出来的键整份拒。
 * 为什么分开校验不是洁癖：模型交上来的 payload 里多一个 `why` 而这一种不认它，那就是
 * 模型把两种出口搞混了 —— 静默丢掉那个键，屏幕上会显示成一次正常的转异步，而它其实
 * 想说的是「这题该回深研」。
 */
export function checkEscalation(e: unknown): { ok: true; value: Escalation } | { ok: false; why: string[] } {
  const why: string[] = [];

  if (typeof e !== "object" || e === null) {
    why.push("escalation 必须是对象");
    return { ok: false, why };
  }

  const obj = e as Record<string, unknown>;

  // 顶层白名单：只认 type 和 payload
  const allowedTop = new Set(["type", "payload"]);
  for (const key of Object.keys(obj)) {
    if (!allowedTop.has(key)) {
      why.push(`escalation 不认字段：${key}`);
    }
  }
  if (why.length > 0) return { ok: false, why };

  // 必须有 type 和 payload
  if (!("type" in obj) || typeof obj.type !== "string") {
    why.push("缺少 type 字段或 type 不是字符串");
    return { ok: false, why };
  }

  if (!("payload" in obj) || typeof obj.payload !== "object" || obj.payload === null) {
    why.push("缺少 payload 字段或 payload 不是对象");
    return { ok: false, why };
  }

  const type = obj.type;
  const payload = obj.payload as Record<string, unknown>;

  // 按 type 分别校验
  if (type === "async_research") {
    // 白名单：question, issueId
    const allowed = new Set(["question", "issueId"]);
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        why.push(`async_research 不认字段：${key}`);
      }
    }
    if (why.length > 0) return { ok: false, why };

    // 必填校验
    if (typeof payload.question !== "string" || payload.question.trim() === "") {
      why.push("async_research 的 question 必须是非空字符串");
    }
    if (typeof payload.issueId !== "string" || payload.issueId.trim() === "") {
      why.push("async_research 的 issueId 必须是非空字符串");
    }
    if (why.length > 0) return { ok: false, why };

    return {
      ok: true,
      value: { type: "async_research", payload: { question: payload.question as string, issueId: payload.issueId as string } },
    };
  } else if (type === "evidence_action") {
    // 白名单：question, issueId, owner?, due?
    const allowed = new Set(["question", "issueId", "owner", "due"]);
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        why.push(`evidence_action 不认字段：${key}`);
      }
    }
    if (why.length > 0) return { ok: false, why };

    // 必填校验
    if (typeof payload.question !== "string" || payload.question.trim() === "") {
      why.push("evidence_action 的 question 必须是非空字符串");
    }
    if (typeof payload.issueId !== "string" || payload.issueId.trim() === "") {
      why.push("evidence_action 的 issueId 必须是非空字符串");
    }
    if (why.length > 0) return { ok: false, why };

    // 可选字段：在但不是非空字符串时整份拒
    const result: { question: string; issueId: string; owner?: string; due?: string } = {
      question: payload.question as string,
      issueId: payload.issueId as string,
    };
    if ("owner" in payload) {
      if (typeof payload.owner !== "string" || payload.owner.trim() === "") {
        why.push("evidence_action 的 owner 必须是非空字符串（如果提供）");
      } else {
        result.owner = payload.owner;
      }
    }
    if ("due" in payload) {
      if (typeof payload.due !== "string" || payload.due.trim() === "") {
        why.push("evidence_action 的 due 必须是非空字符串（如果提供）");
      } else {
        result.due = payload.due;
      }
    }
    if (why.length > 0) return { ok: false, why };

    return { ok: true, value: { type: "evidence_action", payload: result } };
  } else if (type === "deep_research_handoff") {
    // 白名单：issueId, why
    const allowed = new Set(["issueId", "why"]);
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        why.push(`deep_research_handoff 不认字段：${key}`);
      }
    }
    if (why.length > 0) return { ok: false, why };

    // 必填校验
    if (typeof payload.issueId !== "string" || payload.issueId.trim() === "") {
      why.push("deep_research_handoff 的 issueId 必须是非空字符串");
    }
    if (typeof payload.why !== "string" || payload.why.trim() === "") {
      why.push("deep_research_handoff 的 why 必须是非空字符串");
    }
    if (why.length > 0) return { ok: false, why };

    return {
      ok: true,
      value: { type: "deep_research_handoff", payload: { issueId: payload.issueId as string, why: payload.why as string } },
    };
  } else {
    why.push(`不认识的 escalation 类型：${type}`);
    return { ok: false, why };
  }
}

/**
 * 交给模型带回这一轮回应里的那句告知。空串是缺陷 —— 升级了必须让他知道。
 *
 * 规格 §4.1 的升级阶梯要求「本轮先答『这个点我需要查证，先给你我的先验判断：……，
 * 查证结果稍后补上』」—— 升级是对他可见的事，**静默升级等于这一轮撒了个谎**。
 * 所以 `async_research` 那一句里「查证结果稍后补上」**逐字出现**（测试钉住了它）。
 *
 * 三句都只说人话：`type` 值、`issueId`、任务 key 一个都不许出现在里面（全局约束：
 * 内部字段名与内部代号不上屏）。
 *
 * `ctx.reportAlreadyThere` 只有交接深研这一支读它：已有报告时如实说这个工具不会把现有
 * 报告作废，而不是许诺一句它做不到的「我回深研重新梳理」。
 */
export function tellHim(e: Escalation, ctx?: { reportAlreadyThere?: boolean }): string {
  if (e.type === "async_research") {
    return `关于「${e.payload.question}」这个点，我需要查证，查证结果稍后补上。`;
  } else if (e.type === "evidence_action") {
    const ownerPart = e.payload.owner ? `（建议责任人：${e.payload.owner}）` : "";
    const duePart = e.payload.due ? `（建议期限：${e.payload.due}）` : "";
    return `关于「${e.payload.question}」，我建议开一条取证行动${ownerPart}${duePart}。`;
  } else {
    // deep_research_handoff
    if (ctx?.reportAlreadyThere) {
      return `这件议题已经有一份深研报告，我不会替你把现有报告作废。`;
    }
    return `${e.payload.why}，我需要回到深研重新梳理。`;
  }
}
