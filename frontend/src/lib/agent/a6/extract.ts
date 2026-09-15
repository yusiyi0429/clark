/**
 * 一轮对谈之后的萃取。**每一轮跑一次，决定这一轮该不该动判断板。**
 *
 * ## 为什么要单独一次调用，不从对话流里解析
 *
 * 对话是流式散文。要从里面可靠地抠出「这一轮有没有长出一条判断 / 他有没有把某一条
 * 认下来」，只能靠正则和关键词 —— 而那是 A6-05 那条规则已经栽过的跟头：换个说法就漏，
 * 出现一个「所以」就误放。判断有没有形成、他有没有确认，都是语义问题，该用模型判，
 * 不该用词表判。
 *
 * 这一次调用是**非流式、flash 档、几秒**。它在参谋说完之后跑，不挡屏幕。
 *
 * ## 为什么是「板」而不是「一条链」
 *
 * 上一版这里判的是一件事：主链上那**一条**判断有没有被动摇。而屏幕左栏摆的是一块板，
 * 上面并排 2 到 5 条判断（A5 从深研报告读出来的那几条）。两者对不上的后果是实打实的：
 * 他在对谈里就第 3 条追问出一个新结论，模型拿它去比第 1 条，比不出 from → to，
 * 于是那条真结论被写成一支「旁支」—— 而旁支不上板，屏幕上什么也不出现。
 *
 * 所以这一版递进去的是整块板（带编号），要回来的也是对着板说的三件事：
 * 这一轮长出了哪几条（`formed`）、他把哪几条认下来了（`confirms`）、
 * 有没有开出一个新方向（`aside`）。
 *
 * ## 这个 agent 最重要的行为仍然是「什么都不做」
 *
 * 一场深聊十几轮，真正长出判断的可能只有两三轮。其余的是澄清、是补充事实、
 * 是一号位在想。**这些一条都不该上板。** 上了，左栏就变成第二份聊天记录 ——
 * 而它存在的全部理由，恰恰是它不是聊天记录。
 *
 * 所以 prompt 的重心不在「怎么描述判断」，在「什么不算一条判断」。三样默认都是空的。
 *
 * ## 确认为什么也从这里出
 *
 * 「确认」是这个产品里唯一一次权力转移：一句参谋的候选变成公司口径。它只能由他按下 ——
 * 而他按下的方式有两种：板上那颗按钮，或者在对谈里说一句「第 2 条我认了，因为……」。
 * 后者必须认得出来，否则他说完那句话之后屏幕上毫无反应，只能再去点一遍按钮 ——
 * 那等于告诉他对谈是装饰。
 *
 * 认得出来的门槛故意设得高：他要指明是哪一条，而且**要给出理由**。没有理由就不算确认
 * （参谋这一轮的活是把那句理由问出来，见 `instructions.ts`）—— 半年后重新打开这条
 * 判断，查的就是那一句，而它只能是他自己的话。
 *
 * ## 上了 harness，但**不开公司上下文**
 *
 * 台账要有：一场深聊十几轮就是十几次模型调用，而「这轮该不该上板」正是最需要事后复核
 * 的判断 —— 板上少了一条、或多了一条流水账，都得答得出当时是哪个模型按什么材料判的。
 *
 * 上下文不开：这一次调用跑在参谋说完之后，**不挡屏幕**（见上面那段）。装一次 S02 是
 * 两跳 P3 加一次装配，几秒钟，而它要判的东西全在递进来的几段文本里 —— 板上此刻有什么、
 * 一号位这一轮、参谋这一轮。为一个分类任务把每轮对话都拖慢几秒，换不到任何判准上的
 * 改善。台账里 `contextMode` 因此是空串，明确表示「从来没开过」，和「开了但没锚上」
 * （`external_only`）不是一回事。
 *
 * 模型调用本身失败时**不留记录**（异常原样抛给 `runTask`）—— 与 A3/A4/A10 一致：
 * harness 只在图服务不可达那条路上落 failed 记录。这是一个已知的空档，不是 A6 独有。
 */
import { Harness } from "@/lib/agent/harness";
import { parseJson, str, type Msg } from "@/lib/agent/json";
import { commonViolations, type Violation } from "@/lib/agent/rules";
import type { AgentRunRecord } from "@/lib/data/types";

/**
 * 板上一条，递给模型时的样子。
 *
 * `ref` 是给模型用的短编号（"R1"、"D2"），`id` 是真的 `BoardJudgement.id`，模型看不见 ——
 * 让它回写 `BJ-ISS-D4-research-3` 这种串，抄错一个字符就指到空气上，而指错的表现是
 * 「他明明确认了，屏幕上没反应」。
 *
 * 编号由调用方按那一条的 id 算（`refCodeOf`），**不按列表下标**：下标会随着板上多一条
 * 少一条改指，而「改指」在确认这条路上意味着系统替他认了另一条判断。同一个编号在
 * 对谈上下文里和这里是同一个（`boardRefsFor` 一处出），他嘴里的「那一条」才对得上。
 */
export type BoardRef = {
  ref: string;
  id: string;
  label?: string;
  statement: string;
  confirmed: boolean;
};

export type ExtractInput = {
  issueTitle: string;
  /** 主链上当前最新的那一版判断全文。板空着时可能是空串。 */
  currentStatement: string;
  currentVersion: number;
  /** 一号位这一轮说的话。 */
  ceoTurn: string;
  /** 参谋这一轮的回复。 */
  agentTurn: string;
  /** 判断板此刻的样子。空板也要递 —— 那一轮长出来的第一条就是这块板的起点。 */
  board: BoardRef[];
};

/** 这一轮长出来的一条判断。字段与判断板上一条的形状对齐（见 `DraftJudgement`）。 */
export type FormedJudgement = {
  /** 六到十四字的短标签，板上那一行的抬头。 */
  label: string;
  statement: string;
  /** 凭什么。空的不上板 —— 一条没有依据的判断摆在板上就是一句口号。 */
  basis: string;
  boundary: string;
  reopenIf: string;
  /** 这一条是参谋说的，还是一号位自己下的。 */
  by: "agent" | "ceo";
  /** 它改写的是板上哪一条（`BoardJudgement.id`）。不改任何一条就是 null。 */
  replaces: string | null;
  changeLabel: string;
  changeFrom: string;
  changeTo: string;
};

/** 他这一轮明确认下来的一条。`support` 是他自己给的理由。 */
export type Confirmation = { id: string; support: string };

export type TurnOutcome = {
  /** 这一轮长出来的判断，0 到 2 条。**绝大多数轮次是 0。** */
  formed: FormedJudgement[];
  /** 他这一轮认下来的，0 到 3 条。绝大多数轮次是 0。 */
  confirms: Confirmation[];
  /** 一号位这一句的压缩。有 `formed` 时落成链上那个蓝节点。 */
  ceoChallenge: string;
  /** 他提的、不属于板上任何一条的另一个方向。没有就是 null。 */
  aside: { text: string; why: string } | null;
};

export type ExtractResult = {
  outcome: TurnOutcome;
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
};

/** 一轮最多落 2 条判断、3 条确认。超出的截掉 —— 见 `extractTurn` 里那段注释。 */
const MAX_FORMED = 2;
const MAX_CONFIRMS = 3;

const SYSTEM = `你在看一号位和他的参谋就某个议题的一轮对话。屏幕左栏是这个议题的**判断板**：上半层是还没经过他的候选判断，下半层是他已经确认成公司口径的。你只做一件事：判断这一轮之后，那块板该不该动。

三件事各自独立，绝大多数轮次三件都是空的：

## 一、这一轮有没有长出一条判断（formed）

一条判断是**能被单独摘出去用的一句话**：摘给一个没读过这段对话的人，他能读懂，而且知道它在赌什么。

以下全部不算，返回空数组：

- 参谋补充了事实、数据、背景，但没有给出新的结论。
- 参谋把板上已有的某一条换个说法重讲一遍，或者讲得更细。
- 参谋承认「这一条我没有依据」—— 那是诚实，不是新判断。
- 一号位在陈述自己的想法，参谋表示同意，而同意的正是板上已有的那一条。
- 参谋提出了新的风险或不确定性，但明说这不改变现有判断。
- 双方只是在澄清词义、确认事实、或者在讨论下一步该查什么。

什么算：

- 参谋这一轮给出了板上没有的结论，而且说清了凭什么。
- 一号位自己下了一句判断（「这层我们不做，交给生态」），而且不是在重复板上已有的某一条。这一条的 by 是 "ceo"。
- 板上某一条被实质改写：范围收窄或扩大、结论反转、前提被替换、强度变了。这时 replaces 填那一条的编号，并且**你要能写出一个 from → to 的对子**；写不出来，就是没改，这一条不要交。

一条最多两条。宁少不凑：漏掉一条，他在对话里还看得到；多凑一条，板就变成流水账，而板的全部价值在于它短。

每一条要写齐五样：

- label：六到十四个字的短标签，说清这一条管的是什么（例如「战略边界」「当前阶段」）。
- statement：判断本身，一到两句。不要写「在上述基础上」这类回指。
- basis：凭什么这么说。只能用这一轮对话里真的出现过的依据，或者板上那一条已有的依据。**编不出来就不要交这一条。**
- boundary：它没有说什么、在哪儿到头。
- reopenIf：出现什么新事实就要把它重新打开。要具体到能被观察到，不要写「情况有变化时」。

## 二、他有没有把板上某一条认下来（confirms）

只有他**明确指着某一条说他认**，才算。「第 2 条我认可」「战略边界那条就这么定」。

以下都不算：

- 他只是顺着某一句往下说，或者说「对」「嗯」「有道理」。
- 参谋建议他确认，而他还没表态。
- 他说的是「先放着」「再看看」「我倾向于」。
- 那一条已经在下半层了（上下文里标着「已确认」）。

**他没给理由就不算确认。** 确认要连着一句「凭什么」，因为半年后重新打开这条判断查的就是那一句。support 照他这一轮的原话压缩成一句，不许你替他编、也不许你把参谋说的理由算成他的。他说了要认但没说凭什么，就返回空数组 —— 参谋下一句会把那句理由问出来。

## 三、他有没有开一个新方向（aside）

一号位这一轮如果提的是**另一个方向**，既不是板上任何一条的改写，也还没成形为一条判断 —— 比如从「要不要做」跳到「谁来做」、或者引入了一个此前没讨论过的维度 —— 把它写进 aside。

aside 要写清两件事：他关注的那一点是什么（text），以及它为什么扣着这件议题（why）。写不出 why 的就不是新方向，是闲聊，返回 null。

## 写法

- ceoChallenge 是一号位那句话的压缩，保留他的原话口吻，不超过 30 字。
- changeFrom / changeTo 各不超过 12 个字，是一对可以直接放在箭头两边的短语；replaces 为 null 时三个 change 字段都留空串。
- replaces 和 confirms 里的编号照上下文里那一条前面的编号原样写（例如 R1、D2）。他嘴里的「第 2 条」指的是列表里第二行，回写时写那一行的编号。
- 不要 markdown 记号。引号用「」。中文与英文、数字之间加空格。

只输出 JSON：

{ "formed": [], "confirms": [], "ceoChallenge": "", "aside": null }

formed 里每一条的形状：

{ "label": "", "statement": "", "basis": "", "boundary": "", "reopenIf": "", "by": "agent", "replaces": null, "changeLabel": "", "changeFrom": "", "changeTo": "" }

confirms 里每一条的形状：

{ "ref": "R2", "support": "" }`;

function buildUser(i: ExtractInput): string {
  const parts = [`## 议题\n\n${i.issueTitle}`];
  if (i.board.length > 0) {
    parts.push(
      [
        "## 判断板此刻的样子",
        "",
        ...i.board.map(
          (b) =>
            `${b.ref}｜${b.label ? `${b.label}：` : ""}${b.statement}（${b.confirmed ? "已确认，已经是公司口径" : "待他确认，还只是候选"}）`
        ),
      ].join("\n")
    );
  } else {
    parts.push("## 判断板此刻的样子\n\n板上还是空的。");
  }
  parts.push(`## 一号位这一轮说的\n\n${i.ceoTurn}`);
  parts.push(`## 参谋这一轮的回复\n\n${i.agentTurn}`);
  return parts.join("\n\n");
}

/** "R1"、"r1"、"第 1 条"、"板上第 1 条" 都归一成 "R1" / "1" 这种可比的样子。 */
const norm = (v: unknown): string =>
  str(v)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const digitsOf = (s: string): string => s.match(/\d+/)?.[0] ?? "";

/**
 * 把模型写的编号解析回板上那一条。
 *
 * 三种写法都要认：原样的 "R1"、只写数字的 "1"、口语的「第 1 条」。只写数字时按序号
 * 找 —— 但**只有唯一一条对得上才算**（R1 和 D1 的数字都是 1）。对得上两条时返回
 * undefined，也就是「指不到」：一次指错的确认，是系统替他把一句候选变成了公司口径。
 */
const resolveRef = (board: BoardRef[], v: unknown): BoardRef | undefined => {
  const k = norm(v);
  if (!k) return undefined;
  const exact = board.find((b) => norm(b.ref) === k);
  if (exact) return exact;
  const d = digitsOf(k);
  if (!d) return undefined;
  const hits = board.filter((b) => digitsOf(b.ref) === d);
  return hits.length === 1 ? hits[0] : undefined;
};

/**
 * 判断这一轮有没有值得上板的东西。
 *
 * 用 flash 不用 pro：这是一个分类任务（有没有长出判断 + 压缩成几行），不是生成任务。
 * 每轮对话都要跑，用 pro 会让每一句闲聊都付一次高档模型的钱。
 */
export async function extractTurn(input: ExtractInput): Promise<ExtractResult> {
  // 不调 openContext，理由见文件头。`temperature` 压到 0.2：这是分类，不是写作。
  const h = new Harness({ agent: "A6", slot: "flash", temperature: 0.2 });
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUser(input) },
  ];
  const raw = (
    await h.callMessages("模型调用 · a6.turn", messages, { maxTokens: 2000 }, {}, "a6.turn")
  ).text;
  const j = parseJson<Record<string, unknown>>(raw);

  /*
   * 整形与结构自检。**不回问模型。**
   *
   * 每一处降级都 `h.note` 一笔：屏幕上「这一轮板没动」和模型判「什么都没发生」
   * 长得一模一样，台账上必须分得开 —— 否则「板怎么没动」只能靠猜。
   */
  const rawFormed = Array.isArray(j.formed) ? j.formed : [];
  const formed: FormedJudgement[] = [];
  for (const x of rawFormed) {
    const o = (x ?? {}) as Record<string, unknown>;
    const statement = str(o.statement);
    const basis = str(o.basis);
    if (!statement) continue;
    /*
     * 没有依据的判断不上板。
     *
     * 这一条比看起来重要：板上每一行下面摊开的第一句就是「凭什么」，空着的时候
     * 那一行是一句口号 —— 而口号看起来和判断一模一样，他没法分辨哪条经得起追问。
     */
    if (!basis) {
      h.note("这一条写不出依据 —— 不上板", { statement });
      continue;
    }
    // 有的模型会把「不改任何一条」写成字符串 "null" —— 那不是一个编号。
    const replacesRef = ["", "NULL", "NONE"].includes(norm(o.replaces)) ? "" : norm(o.replaces);
    const target = replacesRef ? resolveRef(input.board, o.replaces) : undefined;
    const changeFrom = str(o.changeFrom);
    const changeTo = str(o.changeTo);
    if (replacesRef && !target) {
      // 指到了板上没有的编号。当成「新长出来的一条」而不是丢掉 —— 判断本身还在。
      h.note("它说改写了板上某一条，但编号指不到", { replaces: str(o.replaces), statement });
    }
    if (target && !(changeFrom && changeTo)) {
      /*
       * 说改写了却写不出 from → to，那句「改写」就不成立 —— 这正是 prompt 里那条
       * 判据的代码形式。整条丢掉而不是降级成「新长出来的一条」：改不动的那种改写
       * 就是把板上已有的一条换个说法，而那恰恰是板会变成流水账的入口。
       */
      h.note("说改写了板上某一条，但写不出 from→to —— 按「没改」处理，这一条不上板", {
        replaces: target.ref,
        statement,
      });
      continue;
    }
    formed.push({
      label: str(o.label),
      statement,
      basis,
      boundary: str(o.boundary),
      reopenIf: str(o.reopenIf),
      by: str(o.by) === "ceo" ? "ceo" : "agent",
      replaces: target?.id ?? null,
      changeLabel: target ? str(o.changeLabel) || "判断更新" : "",
      changeFrom: target ? changeFrom : "",
      changeTo: target ? changeTo : "",
    });
  }
  if (formed.length > MAX_FORMED) {
    h.note("一轮里交了太多条判断，只取前两条", { got: formed.length });
    formed.length = MAX_FORMED;
  }

  const rawConfirms = Array.isArray(j.confirms) ? j.confirms : [];
  const confirms: Confirmation[] = [];
  for (const x of rawConfirms) {
    const o = (x ?? {}) as Record<string, unknown>;
    const target = resolveRef(input.board, o.ref);
    const support = str(o.support);
    if (!target) {
      h.note("说他确认了某一条，但编号指不到 —— 不确认", { ref: str(o.ref) });
      continue;
    }
    if (target.confirmed) {
      // 已经在下半层了。重复确认不是错，只是没有内容 —— 静静跳过。
      continue;
    }
    if (!support) {
      /*
       * 没有「凭什么」不算确认。这一行是这条链路上最要紧的一行之一：一次没有理由的
       * 确认，半年后重新打开这条判断时等于什么都没记（见 `confirmBoardJudgement`
       * 那句硬校验）。参谋的活是把那句理由问出来，不是替他补上。
       */
      h.note("他要确认但没说凭什么 —— 不确认，等参谋问出那一句", { ref: target.ref });
      continue;
    }
    confirms.push({ id: target.id, support });
  }
  if (confirms.length > MAX_CONFIRMS) {
    h.note("一轮里确认了太多条，只取前三条", { got: confirms.length });
    confirms.length = MAX_CONFIRMS;
  }

  const asideRaw = (j.aside ?? null) as { text?: unknown; why?: unknown } | null;
  const aside =
    asideRaw && str(asideRaw.text) && str(asideRaw.why)
      ? { text: str(asideRaw.text), why: str(asideRaw.why) }
      : null;

  const outcome: TurnOutcome = {
    formed,
    confirms,
    ceoChallenge: str(j.ceoChallenge),
    aside,
  };
  const violations = checkTurn(outcome);

  return {
    outcome,
    run: h.finish({
      /*
       * 板没动是 `ignored`，不是 `ok` —— 和 A1a 判噪音同一个意思：**产出为空就是
       * 正确结果**。分开之后台账才答得出「这场十四轮聊下来，板上长了两条」；
       * 混成 ok 的话，那个比例永远算不出来，而它正是这条链路唯一要看的指标。
       *
       * 只开了一支旁支也算 `ignored`：旁支不上板。
       */
      status: outcome.formed.length || outcome.confirms.length ? "ok" : "ignored",
      input: `${input.issueTitle} · 板上 ${input.board.length} 条`,
      output: outcome as unknown as Record<string, unknown>,
      violations: violations.map((v) => `${v.rule} ${v.severity} ${v.message}`),
    }),
  };
}

/** 上板之前查一遍文本卫生。只记日志，不挡 —— 挡了板上就少一条，那更糟。 */
export function checkTurn(o: TurnOutcome): Violation[] {
  const v: Violation[] = [];
  if (o.ceoChallenge) v.push(...commonViolations(o.ceoChallenge, "追问"));
  for (const f of o.formed) {
    v.push(...commonViolations(f.statement, "新判断"));
    if (f.label.length < 6 || f.label.length > 14) {
      v.push({
        rule: "A6X-03",
        severity: "p1",
        message: `标签「${f.label}」是 ${f.label.length} 字，板上那一行要的是 6 到 14 字。`,
      });
    }
    if (f.changeFrom.length > 14 || f.changeTo.length > 14) {
      v.push({
        rule: "A6X-01",
        severity: "p1",
        message: `变化的两端太长（${f.changeFrom.length}/${f.changeTo.length} 字），箭头两边放不下。`,
      });
    }
    if (/^(在原判断|基于上述|如前所述|承上)/.test(f.statement)) {
      v.push({
        rule: "A6X-02",
        severity: "p1",
        message: "新判断用回指开头 —— 它要能被单独摘出来读懂。",
      });
    }
  }
  return v;
}
