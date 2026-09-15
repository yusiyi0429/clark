/**
 * A5 的 prompt —— 把一份深研报告读成几条**待一号位确认**的判断。
 *
 * ## 这个 prompt 不归方法部门管
 *
 * `prompts/cognitive/` 下**故意没有 `a5.*.md`**，认知段整段不存在。理由不是还没写：
 * S01/S02/S03 三份技能各自对应研究流程里的一步，而「把研究结论收成公司口径的候选」
 * 是这个产品自己的动作 —— 判断板上下两层、确认只能由人按下、来源分三档，这些都不是
 * 方法标准里的概念。所以它整份写在这里，跟着代码一起改。
 *
 * **不要为了「补齐」给它建一个认知段文件。** 建了之后有人会往里写第二套标准，
 * 于是同一件事有两个地方在定义，而屏幕上看不出这一轮听的是哪一份。
 *
 * ## 它和 A4 深研故意长得不一样
 *
 * 深研是四节并列摊开的研究结果：判断、Evidence、反证、不确定性。它可以并列，因为
 * 读者读的是「这件事是什么」。判断不能并列 —— 它是几句「他点头之后就可以对外说的话」，
 * 每一句都要能被单独摘出去用，所以每一句都得自带依据、边界和重开条件。
 *
 * 从四节到几条判断，做的是**收**：报告里答不上来的部分不许硬凑成判断（那是把研究里
 * 的空白包装成公司口径），报告里的反证要变成边界和重开条件，而不是被丢掉。
 *
 * 形状照的是 Package 04b（Oasis 那份 Research 后的 Judgment）：每条一个短标签 +
 * 一句密实的判断 + 判断依据 + 当前边界，加上「什么新 Evidence 才需要重新打开」。
 *
 * ## 区块那一支多读两节
 *
 * 报告带 `blocks` 时（`TKOS_DR_BLOCKS=1` 跑出来的），user 段在四节之后多摆两节：几条
 * 判断的**原件**，和几条链路对不上的地方。理由在 `blocksSection` 上 —— 四节是它压出来的
 * 一面，而边界和重开条件要读的那两栏（证伪条件、升档条件）在压缩面里已经没有了。
 *
 * system 段一个字没改：它说的「判断从四节里长出来」对两种报告都成立，哪一面是原件是
 * 材料自己的事，写进 system 就等于让没有区块的那一轮也读到一句不成立的话。
 */
import type { Block, ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import type { Judgment, ResearchDoc } from "@/lib/data/types";

export type A5Input = {
  issueId: string;
  title: string;
  /** 刚跑完（或早就在库里）的那份深研报告。判断全部从它长出来。 */
  doc: ResearchDoc;
  /** 这个议题正在动摇的在版判断。判断要说清是不是要改其中某一条。 */
  judgments: Pick<Judgment, "id" | "statement" | "standing">[];
  /** 判断板上已经有的（含一号位确认过的）。同一句话不要再写一遍。 */
  existing: string[];
};

export const A5_SYSTEM = `你是这家公司一号位的参谋。这个议题的深度研究报告刚写完，你现在做下一件事：把那份报告读成**几条一号位可以逐条表态的判断**。

## 你交的东西还没有被确认

你给的每一条都会摊在他判断板的上半层，等他在对谈里或者会上逐条表态。**判断从参谋的猜测变成公司的口径，只能由他按下。**

所以不许出现「本判断已确认」「公司据此执行」「已形成一致意见」「已成为公司口径」这类话。研究结果、判断、共识是三样东西：报告是研究结果；你写的是当前的组织判断候选；只有相关责任人都认为一条判断成熟了，那才是共识。你只做中间那一步。

## 一条判断由五样东西组成

1. **短标签**（label）——六到十四个字，说清这一条管的是哪一块：「企业采用逻辑」「我们的战略边界」「必须掌握的控制点」「当前阶段怎么办」。他在板上扫一眼靠的是它。不要写「判断一」「重要判断」这种没有信息的标签。
2. **判断本身**（statement）——一句到两句密实的话，是他点头之后就可以对外说的那句。单独摘出来发给一个没读过这个议题的人，他要能读懂：不许出现「上述」「该方案」「这件事」「如前所说」这类回指。
3. **判断依据**（basis）——凭什么这么判。点到报告里的事实、数字、编号。半年后要重新打开这条判断时，要检查的正是这一段还成不成立，所以不能写成「综合研究结果」。
4. **当前边界**（boundary）——这条判断**不主张**什么。一条没有边界的判断，三个月后会被当成比它实际更强的东西用。写清楚它管到哪儿为止：不支持什么、不构成什么理由、只在什么范围内成立。
5. **重开条件**（reopenIf）——出现什么新证据，这条判断就该被重新打开。要写得出「什么东西出现」，写「情况有变化时再看」等于没写。

## 判断从报告的四节里长出来

- 报告的「当前判断」通常给出总口径 —— 你的第一条一般就是它，但要收成一句能被单独引用的话。
- 「关键 Evidence」是判断依据的来源。
- 「反证与风险」决定边界和重开条件 —— 反证不是被丢掉，是变成这两段。
- 「不确定性」决定哪些**还不能**成为判断。**答不上来的东西不要凑成一条判断。** 那是这一步最坏的失败：把研究里的空白包装成了公司口径，而屏幕上它和真判断长得一模一样。

## 条数：2 到 5 条，宁少不凑

每条管一块。两条在说同一件事就合成一条 —— 一块堆满近义句的板，比一块只有两条的板更没用，因为他数不出到底有几个判断。

## 强度必须跟依据对齐 —— 但对齐的是措辞，不是要不要表态

依据只到「目前的证据更支持」，就照实写「当前更支持」「初步支持」。一条写过头的判断被确认之后，公司会拿着一个比证据更硬的口径去做事。

**降强度不等于不表态。** 「尚不足以证明」「暂时无法判断」这类说法本身不是判断 —— 它没有主语、没有主张、他没法对它点头或摇头。依据薄的时候要写的仍然是一句有主张的话，只是把把握降下来：写「按目前的材料，我判断是 X —— 当前更支持，依据只有一条」，不写「是不是 X 尚不足以证明」。**前一句他能表态，后一句他只能再问一遍。**

## 硬规矩

- **屏幕不渲染 markdown。** 不要写 \`**\`、\`##\`、\`- \`、\`1. \` 这些记号，会原样显示成星号井号。
- **只用报告和递给你的材料里的事实。** 没给你的数字一个都不许出现。
- **每条判断必须有溯源**，指回报告的哪一节、哪份文档、哪条在版判断的编号。不要编来源。
- 编号照原样写（如 01-J2、ISS-003、DOC-05），屏幕会把它们变成可点开的。
- **只有短码可以写进 traces。** 材料里「member:」开头的是本体内部编号，屏幕认不出、点不开。
- 称呼一号位用「您」。不用感叹号。不说「赋能」「抓手」「打法」这类空词。
- **引号一律用「」**，不要用 ASCII 双引号 —— 输出是 JSON，裸的 " 会把它弄坏。
- **中英文与数字之间加空格**：写「产品 1.0」「Agent 收到」。`;

/**
 * 报告里那几个判断块和分歧块，原样摆出来（任务书 §4.3：判断板从 `judgment` +
 * `divergence_view` 两种块直接提取）。
 *
 * 为什么不只读四节：四节是这些块压出来的一面，读它等于读摘要的摘要。`falsifyCondition`
 * 在四节里被折进「反证与风险」的某一句里，`upgradeCondition` 压根没有对应的一节 ——
 * 而这一步要的恰好是这两样：边界和重开条件由它们长出来。
 *
 * 分歧那几块摆出来是为了**不让它们变成判断**。几条链路对不上的地方是「我们还不知道」，
 * 写成一条判断就是把研究里的空白包装成公司口径 —— 而屏幕上它和真判断长得一模一样。
 *
 * 旧报告（开关没开那阵子跑的）没有 `blocks`，整段不出现：凭空多一句「本轮没有区块」
 * 只会让模型以为它该自己补几个。
 */
function blocksSection(b: ReportBlocks): string {
  const judgments = b.blocks.filter((x): x is Extract<Block, { type: "judgment" }> => x.type === "judgment");
  const divergences = b.blocks.filter(
    (x): x is Extract<Block, { type: "divergence_view" }> => x.type === "divergence_view"
  );
  if (!judgments.length && !divergences.length) return "";

  const parts: string[] = [];
  if (judgments.length) {
    parts.push(
      `## 报告里那几条判断的原件\n\n` +
        `这几条是上面「深研给出的当前判断」那一节的原件 —— 同一件事两面都说时以这里为准。\n\n` +
        judgments
          .map((j, i) =>
            [
              `${i + 1}. ${j.claim}`,
              `　把握：${j.confidence}（方向：${j.direction}）`,
              `　凭什么：${j.reasoningSummary}`,
              `　什么会推翻它：${j.falsifyCondition || "报告里没写"}`,
              `　什么会让它升一档：${j.upgradeCondition || "报告里没写"}`,
              j.evidenceRefs.length ? `　证据：${j.evidenceRefs.join("、")}` : "",
              j.internalValidationHooks.length
                ? `　什么内部数据能裁决它：${j.internalValidationHooks.join("；")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n")
          )
          .join("\n\n") +
        `\n\n「什么会推翻它」进这一条判断的重开条件，「把握」决定措辞的强度 —— 不要把「当前更支持」写成定论。`
    );
  }
  if (divergences.length) {
    parts.push(
      `## 各条链路对不上的地方\n\n` +
        divergences
          .map(
            (d, i) =>
              [
                `${i + 1}. ${d.topic}`,
                ...d.positions.map((p) => `　${p.lane}：${p.verdict}（${p.confidence}）。依据：${p.keyBasis}`),
                `　怎么裁：${d.adjudication.status}・${d.adjudication.method}${d.adjudication.note ? `。${d.adjudication.note}` : ""}`,
              ].join("\n")
          )
          .join("\n\n") +
        `\n\n**这几处一处都不要写成判断。** 它们是「现在还定不下来」，写成判断就是把空白当成了口径。` +
        `每一处都要落在最接近的那条判断里：\n\n` +
        `- 「欠定」「需内部数据」「先验判断」那几处进**当前边界** —— 那条判断不主张这一处已经有答案。` +
        `是先验判断就照实说它是一条先验判断，不要写成证据支持的结论。\n` +
        `- 「待裁决」那几处进**重开条件** —— 写清等哪一次核查或者哪一次算账出结果，这条判断要重新打开。`
    );
  }
  return parts.join("\n\n");
}

export function buildA5User(input: A5Input): string {
  const d = input.doc;
  const parts: string[] = [];
  parts.push(`## 议题\n\n${input.title}（编号 ${input.issueId}）`);

  const list = (label: string, items: { text: string }[]) =>
    items.length ? `## ${label}\n\n${items.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}` : "";

  /*
   * 报告原样递过去，四节分开。
   *
   * 不做摘要：这一步的全部工作就是从四节里收，先摘一遍等于让另一个环节替它做了取舍，
   * 而那次取舍没有人看得见。溯源也不在这里压平 —— 模型要写「依据是 DOC-05」，
   * 得先在报告里看见 DOC-05 挂在哪一条上，所以下面把每条的溯源短码跟在正文后面。
   */
  const withTrace = (items: { text: string; traces?: { source: string }[] }[]) =>
    items.map((s) => ({
      text: s.traces?.length ? `${s.text}（来源：${s.traces.map((t) => t.source).join("、")}）` : s.text,
    }));

  parts.push(list("深研给出的当前判断", withTrace(d.judgment)));
  parts.push(list("关键 Evidence", withTrace(d.keyEvidence)));
  parts.push(list("反证与风险", withTrace(d.counters)));
  parts.push(list("不确定性（还答不上来的）", withTrace(d.unknowns)));
  if (d.routeSuggestion) parts.push(`## 深研的建议分流\n\n${d.routeSuggestion}`);
  // 区块那一支跑出来的报告多这两节（判断原件 + 各条对不上的地方）。摆在四节之后：
  // 四节是它压出来的一面，先读压缩面再读原件，读到的差别才知道该以哪一面为准。
  if (d.blocks) parts.push(blocksSection(d.blocks));

  if (input.judgments.length) {
    parts.push(
      `## 这个议题正在动摇的在版判断\n\n` +
        input.judgments.map((j) => `- ${j.id}（${j.standing}）：${j.statement}`).join("\n") +
        `\n\n如果某条新判断要改其中一条，在它的正文里点名是哪一条、改成什么；` +
        `如果只是补充而不冲突，也说清楚。`
    );
  }

  if (input.existing.length) {
    /*
     * 已经在板上的原样列出来。
     *
     * 不列的话模型会把同一句话换个措辞再写一遍，而板上的去重按正文前 30 字判 ——
     * 换了措辞就躲过去重，于是板上出现两条读起来一样的判断；真躲不过去重的那些
     * 会被静默丢掉，表现成「这次只生成了两条」。两种结果都看不出原因。
     */
    parts.push(
      `## 判断板上已经有的（含他确认过的）\n\n` +
        input.existing.map((s) => `- ${s}`).join("\n") +
        `\n\n这几条不要重复。如果你认为其中某一条现在该改，写成一条新判断并在正文里` +
        `说明它替换的是哪一句、哪里不一样。`
    );
  }

  parts.push(`## 输出

只输出 JSON，不要用代码块包裹，不要写任何解释。形状：

{
  "judgements": [
    {
      "label": "企业采用逻辑",
      "statement": "……",
      "basis": "……（点到报告里的事实、数字或编号）",
      "boundary": "这条判断不主张……，也不构成……的理由。",
      "reopenIf": "如果出现……，这条判断要重新打开。",
      "traces": [{ "kind": "int", "source": "文档标题", "href": "/docs/DOC-05" }]
    }
  ]
}

条数 2-5 条。五个字段每条都必须有，一个都不许空。
traces.kind 只能是 ext（外部事实）int（内部事实）human（人的判断）agent（推断）judgment（指向某条判断）之一。`);

  return parts.filter(Boolean).join("\n\n");
}

/** 校验没过时的重试提示。把违规原样递回去，不要笼统地说「请改进」。 */
export const buildA5Repair = (violations: string): string =>
  `上一版没通过质量门。逐条改，其余不要动：\n\n${violations}\n\n只输出修正后的 JSON。`;
