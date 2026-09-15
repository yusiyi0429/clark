/**
 * 区块报告的出口闸。**确定性的，不调模型。**
 *
 * 这是 `gate.ts` 的兄弟，不是它的替代：正则扫中文正文那一道门在旧格式上照旧跑。区块化
 * 之后能判的东西多了一档 —— 「哪个数没绑证据」以前要靠句子结构猜，现在是「这张 KPI 卡的
 * `evidenceRefs` 是空的」。
 *
 * ## 拒的粒度是块，不是报告
 *
 * 每条违规都带得出「第几个块、什么类型」。重写那一轮只重发被拒的那几个块 —— 让模型
 * 重写整篇的代价不只是 token：它会顺手改掉没被拒的那几段，而那几段已经过闸了。
 *
 * ## p0 与 p1
 *
 * p0 会触发重写：证据缺失、内部文档混进外部判断、共源当独立源、算式算不出 —— 这几类
 * 都指得出「改哪里」。p1 只记账：需要读上下文才能判准的那些（成本结构该不该配计算器、
 * 一组独立来源够不够撑起「较强支持」），确定性代码给不出结论，硬判会让每一轮都挂着
 * 一堆假违规，而假违规多了之后真违规就没人看了。
 */

import type { RejectedBlock } from "@/lib/agent/a4/prompt";
import type { Violation } from "@/lib/agent/rules";
import { sentences } from "@/lib/agent/rules";

import { compileExpr } from "./expr";
import { citedRefs, groupSizes, independentGroups } from "./registry";
import type { BadLine, Block, BlockEvidence, Confidence, ReportMeta } from "./schema";

export interface LintInput {
  meta?: ReportMeta;
  blocks: Block[];
  /** `buildRegistry` 折出来的证据表。 */
  evidence: BlockEvidence[];
  /** 解析不出来的那几行。少一块也是一条要报的事。 */
  bad?: BadLine[];
}

/** 指认一个块：「第 3 个块（kpi_cards · 上架率这一节）」。 */
const where = (b: Block, i: number): string =>
  `第 ${i + 1} 个块（${b.type}${b.heading ? ` · ${b.heading}` : ""}）`;

/**
 * 一条判断没引证据时，推理链至少要写多长（字数）。
 *
 * 这个数存在的理由是：**「说得出理由」这道门槛必须有一个机器判得动的下限**，否则
 * 「reasoningSummary 非空」会被一句「材料有限」满足，而那句话和空着是一个效果。
 *
 * 60 不是量出来的，是按内容定的：一条能被追问的推理最少要说清两件事 —— 从什么前提出发、
 * 中间那一步为什么成立。中文写下来是两个短句，六十字上下。**它是下限不是目标**，也拦不住
 * 一段六十字的车轱辘话；真正判「这段推理站不站得住」的是读它的人，这里只拦下那一类
 * 明显没写的。
 */
const MIN_REASONING_CHARS = 60;

/* -------------------------------------------------------------------------- */
/* 数字性陈述                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 摘掉不算「事实性数字」的那几类，剩下还有数字就是一句要绑证据的话。
 *
 * 摘的是：证据编号、年份、日期、第 N 节、型号里那串数（`H100`、`GPT-5`）。留下来的
 * 才是「62%」「1.2 万台」这一类。
 *
 * **中文数字写的量词抓不到**（「三成」「上万台」）—— 那一类只能靠人读。这条边界写在
 * 这里，是为了不让人以为过了这道闸就等于每个数都绑上了。
 */
const stripNonFacts = (text: string): string =>
  (text ?? "")
    .replace(/\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g, "")
    .replace(/[A-Za-z]+[-‑]?\d+[A-Za-z]*/g, "")
    .replace(/(?:19|20)\d{2}\s*(?:年|-|\/)?/g, "")
    .replace(/第\s*\d+\s*[节章条项段步轮]/g, "")
    .replace(/\d+\s*[月日]/g, "")
    /*
     * 2026-09-06 补三类（ISS-232 七条 B02 p0 里六条是它们）：世代线（「8.6 代」「6 代基板」）是名字不是数；
     * 「48 小时内」「两周内」这类时限出现在议程和行动骨架里，是我们自己定的规矩；「三样」「前三类」「另外
     * 十七条」这类是报告在数自己的条目。这三类都不是取回来的事实，绑不上证据也不该绑。
     */
    .replace(/\d+(?:\.\d+)?\s*代/g, "")
    .replace(/\d+\s*(?:小时|分钟|天|周|个月|个季度|个工作日)(?:内|之内|以内)?/g, "")
    .replace(/\d+\s*(?:条|件|份|样|档|类|步|段|页|次|块|节|项|张|句|个)(?![A-Za-z])/g, "");

const HAS_DIGIT = /\d/;
const hasRef = /\[E\d+/;

/** 这句话里有没有一个要绑证据的数。 */
const isNumericClaim = (text: string): boolean => HAS_DIGIT.test(stripNonFacts(text));

/** 成本结构那一类断言。它们必须能被复算，不能是抄来的一个占比。 */
const COST_TALK = /(成本结构|成本占比|占成本|电费占|单位成本|毛利率|净利率|回本周期|IRR|投资回报)/;

/* -------------------------------------------------------------------------- */
/* 主体                                                                        */
/* -------------------------------------------------------------------------- */

export function lintBlocks(input: LintInput): Violation[] {
  const v: Violation[] = [];
  /*
   * `at` 是第几个块（从 0 数）。给得出就给：返修那一轮靠它挑出要重发的那几行
   * （`rejectedFrom`）。报告级的那几条（少了 report_meta、一个块都没有）没有 `at` ——
   * 那种问题不属于任何一个块，硬按到第一个块上会让模型去改一个没错的块。
   */
  const p0 = (rule: string, message: string, at?: number) =>
    v.push({ rule, severity: "p0", message, ...(at === undefined ? {} : { block: at }) });
  const p1 = (rule: string, message: string, at?: number) =>
    v.push({ rule, severity: "p1", message, ...(at === undefined ? {} : { block: at }) });

  const blocks = input.blocks ?? [];
  const evidence = input.evidence ?? [];
  const byId = new Map(evidence.map((e) => [e.id, e] as const));
  const sizes = groupSizes(evidence);

  /*
   * 证据利用率对账那一块。A4-B06 的孤儿账和 A4-B11 的硬账读的是同一份声明 ——
   * 分两处各读一次的下场是同一条证据在一处被判「没用上」、在另一处算「已交代」。
   */
  const usageAt = blocks.findIndex((b) => b.type === "evidence_usage");
  const usage = usageAt >= 0 ? blocks[usageAt] : undefined;
  const declared = new Map(
    usage?.type === "evidence_usage" ? usage.discarded.map((d) => [d.id, d.reason] as const) : []
  );

  /* ---- A4-B01 报告的骨架 ------------------------------------------------ */

  if (!input.meta) {
    p0("A4-B01", "少了 report_meta 那一行：标题、置信分档、材料截止日期是报告级的事实，不在任何块里。");
  }
  if (!blocks.length) {
    p0("A4-B01", "一个块都没有 —— 这不是一份报告。");
    return v;
  }

  const banners = blocks.filter((b) => b.type === "verdict_banner");
  if (!banners.length) {
    p0("A4-B01", "没有 verdict_banner：开篇就要给答案，一份没有核心判断的报告读者要自己去总结。");
  } else if (banners.length > 1) {
    p0("A4-B01", `有 ${banners.length} 个 verdict_banner —— 两个横幅等于没有结论。合成一个，别的降成 judgment。`);
  }
  for (const b of banners) {
    if (!b.boundary) {
      p0(
        "A4-B01",
        "verdict_banner 没有 boundary：说不出「在什么范围内成立」的判断没法被证伪。",
        blocks.indexOf(b)
      );
    }
  }

  if (!blocks.some((b) => b.type === "judgment")) {
    p0("A4-B01", "没有 judgment 块：判断板的条目是从这几个块里取的，一个都没有意味着这一轮上不了板。");
  }
  if (!blocks.some((b) => b.type === "falsify_card")) {
    p1("A4-B01", "没有 falsify_card。推翻条件是常驻卡，缺了它这份报告没有自己的失效日期。");
  }
  if (!blocks.some((b) => b.type === "evidence_list") && evidence.length) {
    p1("A4-B01", `证据表里有 ${evidence.length} 条（由台账补齐），但报告里没有 evidence_list 这一节。`);
  }

  /* ---- A4-B02 数字要有出处 ---------------------------------------------- */

  blocks.forEach((b, i) => {
    switch (b.type) {
      case "kpi_cards": {
        const naked = b.cards.filter((c) => !c.evidenceRefs.length);
        if (naked.length) {
          p0(
            "A4-B02",
            `${where(b, i)}里有 ${naked.length} 张卡没有 evidenceRefs（${naked
              .map((c) => c.label)
              .slice(0, 4)
              .join("、")}）。一个没有出处的数在屏幕上和核过的数长得一样。`,
            i
          );
        }
        for (const c of b.cards) {
          if (!c.caliberNote) {
            p1(
              "A4-B02",
              `${where(b, i)}的「${c.label}」没有口径脚注 —— 这个数答的是哪一问，缺了它两个口径的数会被放在一起比。`,
              i
            );
          }
        }
        break;
      }
      case "layered_table": {
        const numeric = b.rows.some((row) => row.some(isNumericClaim));
        const cellRefs = citedRefs([b]);
        if (numeric && !cellRefs.length) {
          p0(
            "A4-B02",
            `${where(b, i)}里有数字，整张表一条证据都没引。表上的数和正文里的数是同一套要求。`,
            i
          );
        }
        break;
      }
      case "funnel":
      case "bar_compare": {
        if (!citedRefs([b]).length) {
          p0(
            "A4-B02",
            `${where(b, i)}的每一级/每一项都是画出来的数，一条证据都没引 —— 在 note 里写 [E编号]，或者这张图不该画。`,
            i
          );
        }
        break;
      }
      case "prose": {
        const bad = sentences(b.md).filter((x) => isNumericClaim(x) && !hasRef.test(x));
        if (bad.length) {
          p0(
            "A4-B02",
            `${where(b, i)}里有 ${bad.length} 句带数字但没绑证据的话：${bad
              .slice(0, 3)
              .map((x) => `「${x.slice(0, 40)}」`)
              .join("；")}`,
            i
          );
        }
        break;
      }
      default:
        break;
    }
  });

  /* ---- A4-B03 判断要说得出怎么被推翻 ------------------------------------ */

  blocks.forEach((b, i) => {
    if (b.type !== "judgment") return;
    if (!b.falsifyCondition) {
      p0(
        "A4-B03",
        `${where(b, i)}没有 falsifyCondition：「${b.claim.slice(0, 40)}」说不出什么会推翻它，那它不是判断。`,
        i
      );
    }
    if (b.defaulted?.includes("confidence")) {
      p0("A4-B03", `${where(b, i)}没写 confidence。分档是这条判断能被怎么用的全部信息，代码不替它选一档。`, i);
    }
    if (!b.upgradeCondition) {
      p1("A4-B03", `${where(b, i)}没有 upgradeCondition —— 只有推翻条件的判断永远升不上去。`, i);
    }
    /*
     * 「凭什么这么判」必须答得出。**答法有两种，缺一种不算违规，两种都缺才是。**
     *
     * 上一版只认证据：`evidenceRefs` 是空的就 p0。那条规则在有证据的轮次里是对的，在
     * 零证据的轮次里却是一道死门 —— 报告里每一条判断都会挂一条 p0，而它们一条都改不掉
     * （这一轮压根没有编号可引）。模型能学会的唯一避法是**不下判断**，于是零证据的那几轮
     * 交回来的是材料复述加一句「尚不能判断」。一号位 2026-08-31 的原话：没有看法和判断的
     * 调研就是没有价值的调研。
     *
     * 所以门槛换成「说得出理由」：引了证据算，写了推理链也算。推理链要够长 —— 一句
     * 「材料有限」不是推理，它和空着是一个效果，所以有一个字数下限。
     *
     * 拦得住的东西一个没少：既没有证据、也说不出怎么推出来的那一条，照旧 p0。那一条才是
     * 真正的裸断言。
     */
    const reasoned = b.reasoningSummary.trim().length >= MIN_REASONING_CHARS;
    if (!b.evidenceRefs.length && !reasoned) {
      p0(
        "A4-B03",
        `${where(b, i)}既没引证据、也没写出推理链（reasoningSummary 不足 ${MIN_REASONING_CHARS} 字）。` +
          "凭什么这么判，是这条判断上板之前要答的第一句 —— 没有证据的时候，答案是你怎么推出来的。",
        i
      );
    }
    if (!b.evidenceRefs.length && reasoned) {
      // 提醒，不挡。**这一条要上屏**：读的人得知道这条判断是推出来的，而不是核过的。
      p1(
        "A4-B03",
        `${where(b, i)}一条证据都没引，靠推理成立。确认 falsifyCondition 写的是**能被真实数据打掉**的条件 ——` +
          "推理得出的判断，证伪条件是它唯一能被检验的接口。",
        i
      );
    }
  });

  /* ---- A4-B04 内部文档只出现在两个地方 ---------------------------------- */

  const internal = new Set(evidence.filter((e) => e.sourceType === "内部DOC").map((e) => e.id));
  if (internal.size) {
    // 「对我们的当前含义」那一节：内部文档在那里是合法的，那一节本来就是内视角。
    const INWARD = /(对我们|我们自己|内部|当前含义|落到我们)/;
    blocks.forEach((b, i) => {
      // 证据清单里列着它不算「用它」——那一节的作用就是把它摆出来说清它是内部材料。
      if (b.type === "evidence_list") return;
      const inward = b.type === "prose" && INWARD.test(b.heading ?? "");
      if (inward) return;
      const hit = citedRefs([b]).filter((id) => internal.has(id));
      if (hit.length) {
        p0(
          "A4-B04",
          `${where(b, i)}引了内部文档（${hit.join("、")}）。内部文档只能出现在「对我们的当前含义」那一节和 ` +
            "judgment 的 internalValidationHooks 里 —— 拿它去撑一条外部市场判断，等于用一份外面核不了的材料下外部结论。",
          i
        );
      }
    });
  }

  /* ---- A4-B05 共源不是独立来源 ------------------------------------------ */

  blocks.forEach((b, i) => {
    if (b.type !== "judgment") return;
    const known = b.evidenceRefs.filter((id) => byId.has(id));
    if (known.length < 2) return;
    const groups = independentGroups(known, evidence);
    if (groups.length === 1) {
      const n = sizes.get(groups[0]) ?? known.length;
      p0(
        "A4-B05",
        `${where(b, i)}引了 ${known.join("、")}，这几条同属一个来源组（共源×${n}）—— 一份材料收三遍不是三个来源。` +
          "要么合并成一条并写明它只有一个源，要么补一条真正独立的。",
        i
      );
    }
  });

  blocks.forEach((b, i) => {
    if (b.type !== "judgment") return;
    if (b.confidence !== "较强支持" && b.confidence !== "接近确证") return;
    const known = b.evidenceRefs.filter((id) => byId.has(id));
    const groups = independentGroups(known, evidence);
    if (groups.length >= 2) return;
    // 一组也够的唯一情形：那一组是官方一手/法定披露（A 级）。
    const soleIsA = known.some((id) => byId.get(id)?.grade === "A");
    if (!soleIsA) {
      p1(
        "A4-B05",
        `${where(b, i)}标的是「${b.confidence}」，撑它的只有 ${known.length || 0} 条、不足两组独立来源，` +
          "而且没有一条是官方一手。降一档，或者补一组独立来源。",
        i
      );
    }
  });

  /* ---- A4-B06 引了就要解析得开 ------------------------------------------ */

  const dangling = citedRefs(blocks).filter((id) => !byId.has(id));
  if (dangling.length) {
    p0(
      "A4-B06",
      `正文引了证据表里没有的编号 ${dangling.slice(0, 8).join("、")}。要么在 evidence_list 里列出来（模型既有知识也要列），` +
        "要么把它从正文里去掉 —— 一枚点不开的编号比没有编号糟：读者会以为它核过。"
    );
  }

  const listed = new Set(
    blocks.flatMap((b) => (b.type === "evidence_list" ? b.items.map((x) => x.id) : []))
  );
  const cited = new Set(citedRefs(blocks));
  // 在 evidence_usage 里声明了弃用理由的不算孤儿：那一条**已经交代过了**。不减掉的话，
  // 同一条证据会同时收到 A4-B06 的「一次都没用上」和 A4-B11 的「已声明弃用」两种判读。
  const orphan = evidence.filter(
    (e) => e.origin === "ledger" && !cited.has(e.id) && !listed.has(e.id) && !declared.has(e.id)
  );
  if (orphan.length) {
    p1(
      "A4-B06",
      `台账里有 ${orphan.length} 条证据（${orphan.map((e) => e.id).slice(0, 6).join("、")}）报告里一次都没用上。` +
        "取回来没用上的证据要么说明取错了方向，要么说明报告漏了一段。"
    );
  }

  /* ---- A4-B07 成本结构要能复算 ------------------------------------------ */

  const hasParamModel = blocks.some((b) => b.type === "param_model");
  if (!hasParamModel) {
    const costTalk = blocks.some((b) => {
      if (b.type === "prose") return COST_TALK.test(b.md);
      if (b.type === "kpi_cards") return b.cards.some((c) => COST_TALK.test(`${c.label}${c.caliberNote}`));
      if (b.type === "verdict_banner") return COST_TALK.test(b.text);
      return false;
    });
    if (costTalk) {
      p1(
        "A4-B07",
        "报告里有成本结构类的断言，但没有 param_model。占比是算出来的还是抄来的，只有能复算的那一份说得清 ——" +
          "「电费占 30-50%」那一类错误就是抄来的一个跨层占比。"
      );
    }
  }

  /* ---- A4-B08 算式必须算得出来 ------------------------------------------ */

  blocks.forEach((b, i) => {
    if (b.type !== "param_model") return;
    const ids = new Set(b.params.map((p) => p.id));
    for (const out of b.outputs) {
      const r = compileExpr(out.expr);
      if (!r.ok) {
        p0(
          "A4-B08",
          `${where(b, i)}的「${out.label}」算式读不通：${r.why}。算式里只能有参数 id、数字、+ - * / 和括号。`,
          i
        );
        continue;
      }
      const unknown = r.expr.ids.filter((id) => !ids.has(id));
      if (unknown.length) {
        p0(
          "A4-B08",
          `${where(b, i)}的「${out.label}」用到了没声明的参数 ${unknown.join("、")}。` +
            `这个块声明的是 ${[...ids].join("、") || "（一个都没有）"}。`,
          i
        );
      }
    }
    for (const p of b.params) {
      if (p.default < p.min || p.default > p.max) {
        p1(
          "A4-B08",
          `${where(b, i)}的参数「${p.label}」默认值 ${p.default} 落在 ${p.min}–${p.max} 之外，滑块一进来就是越界状态。`,
          i
        );
      }
    }
    if (!b.disclaimer) {
      p1("A4-B08", `${where(b, i)}没有 disclaimer —— 一个能拖出任何结论的计算器必须写明它的适用边界。`, i);
    }
  });

  /* ---- A4-B09 裁决方式不能自相矛盾 -------------------------------------- */

  /*
   * 这三条只在 `TKOS_DR_V2=0` 那条对照链上够得着，而且第一条在那条链上也只是保险带。
   * 查到这里的人容易把它们判成死规则然后删掉，所以把两层原因写在这儿：
   *
   * 1. **默认那条七步链里没有 `divergence_view` 这种块。** 它只由跨链路对账那一步折出来
   *    （`blocks/divergence.ts` 的 `readDivergences` ＋ `insertDivergences`，只有 `run.ts`
   *    调），而出稿那几次的提示词明确不收它（`prompt.ts:842`）。默认链只有一份报告，没有
   *    「几条链路对同一命题裁得不一样」这件事，也就没有这种块。
   * 2. 第一条（欠定 ＋ 事实核查/程序执行）在对照链上**也永远不触发**：`readDivergences` 里的
   *    `adjudicate` 已经就地把这种组合改成「需内部数据」了。留着它不是重复 —— 那一步之所以
   *    敢就地改而不发返修，凭的正是这条规则在后面兜着；哪天有人把 `adjudicate` 拿掉，是它
   *    把这件事报出来。后两条（已裁决没写理由、某一方没写 keyBasis）**不是死的**：那两栏
   *    `readDivergences` 原样照抄模型交回来的，空着就会走到这里。
   */
  blocks.forEach((b, i) => {
    if (b.type !== "divergence_view") return;
    const { status, method, note } = b.adjudication;
    if (status === "欠定" && (method === "事实核查" || method === "程序执行")) {
      p0(
        "A4-B09",
        `${where(b, i)}把这处分歧记成「欠定」，裁决方式却是「${method}」—— 那读起来像「再查一轮就有答案」。` +
          "欠定的出路只有两条：要内部数据，或者承认这是一条先验判断。",
        i
      );
    }
    if (status === "已裁决" && !note) {
      p1("A4-B09", `${where(b, i)}写着「已裁决」但没说怎么裁的。裁决理由是这处分歧唯一留得下来的东西。`, i);
    }
    for (const p of b.positions) {
      if (!p.keyBasis) {
        p1("A4-B09", `${where(b, i)}里「${p.lane}」那一栏没写 keyBasis —— 分歧要指得出谁凭什么，不是各自表个态。`, i);
      }
    }
  });

  /* ---- A4-B10 坏行 ------------------------------------------------------ */

  const bad = input.bad ?? [];
  if (bad.length) {
    p1(
      "A4-B10",
      `有 ${bad.length} 行没解析出来（${bad.map((x) => `第 ${x.line} 行：${x.why}`).slice(0, 3).join("；")}）。` +
        "那几行对应的块这一份里没有。"
    );
  }

  /* ---- A4-B11 每条证据都要有个交代 -------------------------------------- */

  /*
   * 这一条是长度的真实引擎（补遗 §2.3）。前面那些规则管的都是「写出来的部分对不对」，
   * 只有这一条问「取回来的部分去哪儿了」—— 一份取回十八条、写进去六条、剩下十二条没人
   * 提的报告，在别的每一道门前面都是干净的。
   *
   * 只数台账那部分（`origin === "ledger"`）：模型自己既有知识入的那几条不是这一轮检索
   * 的产出，拿它去算利用率等于把模型的记忆记成检索成绩。
   *
   * 代码**不替它补** discarded：补一句「未使用」这条规矩就永远过得去，而它要拦的正是
   * 那十二条无人提及。
   */
  const pack = evidence.filter((e) => e.origin === "ledger");
  if (pack.length) {
    const usedDeclared = new Set(usage?.type === "evidence_usage" ? usage.used : []);
    const uncovered = pack.filter(
      (e) => !cited.has(e.id) && !listed.has(e.id) && !usedDeclared.has(e.id) && !declared.has(e.id)
    );
    if (uncovered.length) {
      p0(
        "A4-B11",
        `证据包里有 ${uncovered.length} 条证据（${uncovered.map((e) => e.id).slice(0, 8).join("、")}）` +
          `既没有被用上、也没有在 evidence_usage 里声明弃用${usageAt < 0 ? "（这一份压根没有 evidence_usage 这一块）" : ""}。` +
          "每一条要么写进正文，要么在 evidence_usage 的 discarded 里给出弃用理由 —— 没用上的证据等于白检索。",
        usageAt < 0 ? undefined : usageAt
      );
    }

    // `.trim()`：一格空格和没写是一件事。走 JSONL 那条路进来的已经被 `readBlock` 修过，
    // 而这道门也数直接落库的那一份（`ResearchDoc.blocks`），那一份没人替它修。
    const noReason = [...declared].filter(([, reason]) => !reason.trim()).map(([id]) => id);
    if (noReason.length) {
      p0(
        "A4-B11",
        `evidence_usage 里有 ${noReason.length} 条只写了编号没写理由（${noReason.slice(0, 8).join("、")}）。` +
          "弃用理由是这一栏唯一的内容：没有理由的弃用和漏掉一条，在屏幕上长得一样。",
        usageAt
      );
    }

    /*
     * 「列进 evidence_list」不算「用上了」—— 那一节的作用就是把取回来的都摆出来，弃用的
     * 那几条也该摆在里面。所以这一条另数一份只算正文的引用：拿 `cited` 来判的话，每一条
     * 老实列进清单的弃用声明都会被判成自相矛盾，而真正要拦的是「说弃用了、正文里又拿它
     * 当依据」。
     */
    const citedInBody = new Set(citedRefs(blocks.filter((b) => b.type !== "evidence_list")));
    const bothWays = [...declared.keys()].filter((id) => citedInBody.has(id));
    if (bothWays.length) {
      p1(
        "A4-B11",
        `evidence_usage 说弃用了 ${bothWays.slice(0, 6).join("、")}，正文里又引了它们。` +
          "两边对不上的时候，读的人不知道该信哪一边。",
        usageAt
      );
    }

    const outside = [...usedDeclared, ...declared.keys()].filter((id) => !byId.has(id));
    if (outside.length) {
      p1(
        "A4-B11",
        `evidence_usage 里出现了证据表里没有的编号 ${outside.slice(0, 6).join("、")} —— 对账对到了包外面。`,
        usageAt
      );
    }
  }

  return v;
}

/**
 * `assembleReport` 出来的那一份，直接过闸。
 *
 * 参数写成结构类型而不是 `import { Assembled }`：那样 `lint` 就要依赖 `report`，而
 * `report` 已经依赖 `parse` 与 `registry` —— 校验器该是这条链上谁都不依赖的一头。
 */
export const lintAssembled = (a: {
  meta?: ReportMeta;
  blocks: Block[];
  report: { evidence: BlockEvidence[]; bad?: BadLine[] };
}): Violation[] =>
  lintBlocks({
    ...(a.meta ? { meta: a.meta } : {}),
    blocks: a.blocks,
    evidence: a.report.evidence,
    ...(a.report.bad ? { bad: a.report.bad } : {}),
  });

/**
 * 落库形态那一份，直接过闸。跨链路对账把 `divergence_view` 插进去之后要重过一遍 ——
 * 那几块也归 A4-B09 管，而它们在链路里那一遍时还不存在。
 *
 * `title` 空着就等于当初压根没有 `report_meta`（`readMeta` 要求标题非空，缺元数据时
 * `assembleReport` 留的就是空串）。所以这里的 meta 是**重建，不是补** —— 无条件造一个
 * meta 出来会把「少了 report_meta」这条 p0 悄悄抹掉。
 */
export const lintStored = (r: {
  title: string;
  confidence: Confidence;
  dataCutoff: string;
  blocks: Block[];
  evidence: BlockEvidence[];
  bad?: BadLine[];
}): Violation[] =>
  lintBlocks({
    ...(r.title ? { meta: { title: r.title, confidence: r.confidence, dataCutoff: r.dataCutoff } } : {}),
    blocks: r.blocks,
    evidence: r.evidence,
    ...(r.bad ? { bad: r.bad } : {}),
  });

/** 这一轮要不要重写。**只看 p0** —— p1 是记账，不是闸。 */
export const mustRewrite = (violations: Violation[]): boolean =>
  violations.some((x) => x.severity === "p0");

/* -------------------------------------------------------------------------- */
/* 违规 → 要重发哪几块                                                         */
/* -------------------------------------------------------------------------- */

export interface Rejection {
  /** 要重发的那几块，按块序。 */
  rejected: RejectedBlock[];
  /** 不属于任何一个块的那几条 p0，合成一段。 */
  general: string;
  /** `report_meta` 那一行缺了或者写坏了 —— 这一行不属于任何块，只能让它重交。 */
  needsMeta: boolean;
}

/** 少了 report_meta 的那条违规。认这句话是因为它是这条规则唯一的出口（见上面 A4-B01）。 */
const META_MISSING = "少了 report_meta";

/**
 * 把违规折成「要重发哪几块」。
 *
 * 两条取舍：
 *
 * **进不进这一轮，只由 p0 决定；进来之后，p1 一起改。** 一个块已经要重写了，那它身上
 * 那几条 p1（没写口径脚注、没有 upgradeCondition）顺手就能补上；反过来，只有 p1 的块
 * 不进这一轮 —— 为一条「建议补口径」把一个过了闸的块推回去重写，换来的多半是别的地方
 * 变了样。
 *
 * **报告级的那几条不硬按到某个块上。** 它们进 `general`，提示词里让模型「在上面那几块里
 * 就近处理」。硬按的话，模型会去改一个本身没错的块，而真正的问题（比如台账里有证据一次
 * 都没用上）它根本没被告知在哪。
 */
export function rejectedFrom(violations: Violation[], blocks: Block[], sources: string[]): Rejection {
  const hit = new Set<number>();
  for (const x of violations) {
    if (x.severity === "p0" && x.block !== undefined) hit.add(x.block);
  }

  const rejected: RejectedBlock[] = [...hit]
    .filter((i) => i >= 0 && i < blocks.length)
    .sort((a, b) => a - b)
    .map((i) => ({
      at: i + 1,
      // 原文取不到时（数组那一支块多源少）退回重新序列化：贴一行空的回去，
      // 模型就只能凭那句原因猜它写过什么。
      line: sources[i] ?? JSON.stringify(blocks[i]),
      why: violations
        .filter((x) => x.block === i)
        .map((x) => `${x.rule} ${x.message}`)
        .join(" / "),
    }));

  const loose = violations.filter((x) => x.severity === "p0" && x.block === undefined);
  return {
    rejected,
    general: loose
      .filter((x) => !x.message.startsWith(META_MISSING))
      .map((x) => `${x.rule} ${x.message}`)
      .join("\n"),
    needsMeta: loose.some((x) => x.message.startsWith(META_MISSING)),
  };
}
