/**
 * 换源之后的一次真跑：**真本体 + 真模型**，一条真议题走完 A3 预研。
 *
 * 默认整条跳过。打开：`TKOS_A3_LIVE=1`（还要 `.env.local` 里那两把 —— 本体的
 * `TKOS_MEMORY_API_KEY` 和模型的 `ARK_API_KEY`）。一次约一到两次 `pro` 调用。
 *
 * ## 罐头验不到的是哪三件
 *
 * 离线那一批验的是「三态怎么接、bundle 长什么样」，全都是形状。真跑要答的是**内容**：
 *
 * 一、**那段公司层材料真的进 prompt 了吗。** 客户端那一层已经由 `narrative.live.test.ts`
 *     验过，但从客户端到 `h.contextBlock` 中间隔着分派、包裹、三档分支 —— 任何一处接错，
 *     表现都是「模型照常出稿，只是写得空」，看不出来。
 * 二、**它有没有把这条议题挂到某条 Mission / Outcome 上。** 这是换源之后这一路唯一的
 *     正向产出（工作记忆还没建起来，「公司之前怎么判的」这一层根本不在手上），
 *     也是 `wrapCompanyNarrative` 里唯一一条「要做的事」。挂不上要明说挂不上。
 * 三、**它有没有编造既有判断。** 手上拿着一整段真实的公司材料时，最顺手的写法就是从
 *     里面推想出一句「公司现有判断是……」。这是换源之后最容易出的坏产出 —— 格式完整、
 *     语气笃定、没有一处报错。
 *
 * ## 为什么用这条议题
 *
 * 「本体只建了公司层，议题与判断那一层还没有 —— Agents 还能不能算进入真实使用」：
 *
 * · 它**真的挂得上**。拿它去问本体，回来的正好是 `8月Outcome-05 Engine & Ontology`
 *   （企业 Context、本体与最小运行能力形成并支撑 Agents）和 `8月Outcome-04 Agents`
 *   （……形成可用版本并进入真实使用）—— 两条当期 Outcome 的接缝。挑一条本体答不上的题，
 *   这次真跑只能验出「没材料时它不乱写」，验不到「有材料时它会不会用」。
 * · 它是**真问题**，不是造出来的：05 只承诺「最小运行能力」，04 要的是「进入真实使用」，
 *   而这两句之间差着多少，正是眼下要判的。
 * · 它对第三条尤其毒：这条议题本身就在谈「判断那一层还没有」，模型要是编一句
 *   「公司现有判断是……」，那句话会自相矛盾到刺眼 —— 好过一条编了也看不出来的题。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_COMPANY_CONTEXT } from "@/lib/agent/harness";

import { runPreResearch } from "./run";
import type { A3Input } from "./prompt";

const ON = process.env.TKOS_A3_LIVE === "1";
const run = ON ? it : it.skip;
const LONG = 10 * 60 * 1000;

/**
 * 产出落盘的位置。跟着这次会话的 scratchpad 走，**不进仓库**（那是一次运行的痕迹）。
 *
 * 为什么不只 `console.log`：vitest 只在用例**失败**时把 stdout 打出来。而这个探针最有
 * 价值的一次恰恰是它**通过**的那次 —— 那份产出要人读一遍才知道挂得对不对，光看一个绿点
 * 说明不了任何事。落盘之后两种结局都留得下现场。
 */
const OUT_DIR =
  process.env.TKOS_A3_LIVE_OUT ?? join(process.env.TEMP ?? ".", "claude", "a3-narrative-live");

/**
 * 这一轮的题面。
 *
 * `judgments` 是**空的**，而且这不是省事：工作记忆还没进本体，所以真实情况就是这条议题
 * 手上一条在版判断都没有。塞两条假判断进去会让这次真跑的结论失真 —— 那验的是另一条路。
 */
const INPUT: A3Input = {
  issueId: "ISS-LIVE-ONTOLOGY",
  title: "本体只建了公司层的语义记忆，议题与判断那一层还没有，Agents 还能不能算进入真实使用",
  scope:
    "本体目前只提供公司层内容（愿景、本期 Outcome、各 Domain 与 Mission、经营原则），" +
    "议题及其判断、共识那一层尚未建立。一号位与管理者 Agents 因此拿不到任何既有判断。",
  material: null,
  judgments: [],
};

/**
 * `finding` / `openQuestion` 是 `Statement[]`（每条一句判断式短标题 + 正文 + 溯源），
 * 不是字符串 —— 直接 `String()` 会得到一串 `[object Object]`，看起来像模型交了坏数据，
 * 而其实是这个 dump 写错了。**这种误诊比没有 dump 更糟**：它会把人引去查 A3 的 shape。
 */
function render(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return JSON.stringify(v, null, 2);
  return v
    .map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const label = typeof o.label === "string" && o.label ? `**${o.label}** ` : "";
      const traces = Array.isArray(o.traces) && o.traces.length ? `\n   溯源 ${JSON.stringify(o.traces)}` : "";
      return `${i + 1}. ${label}${String(o.text ?? JSON.stringify(o))}${traces}`;
    })
    .join("\n");
}

describe("换源之后的 A3 预研 · 真本体 + 真模型", () => {
  /**
   * **同一条议题从老路再走一遍。** 这是那个换源开关唯一的用处，也是这个文件里
   * 唯一一条不为「新的对不对」而写的用例。
   *
   * 它答的是一个换源之后没人再问、但迟早要付账的问题：**这一换到底丢了什么**。
   * 两边各跑一遍存成两份，差在哪里是读出来的，不是推出来的 —— 而「推出来的差异」
   * 在这种事上一向偏乐观：丢掉的那部分不会报错，只会让报告写得比原来空一点。
   *
   * 老路这一次会走到哪一档取决于图里有没有对得上的锚点，两档都算通过：
   * 命中就装判断链，没命中转纯外部也照样带【公司经营状态】—— 而判断台账正在那一段里。
   */
  run(
    "对照：同一条议题走老路（TKOS_ONTOLOGY_SOURCE=graph），存下来比对丢了什么",
    async () => {
      const saved = process.env.TKOS_ONTOLOGY_SOURCE;
      process.env.TKOS_ONTOLOGY_SOURCE = "graph";
      try {
        const r = await runPreResearch(INPUT);
        const doc = r.doc as unknown as Record<string, unknown>;
        const dump = [
          "# A3 预研 · 老路（GraphKnowledge）· 同一条议题",
          "",
          `题面：${INPUT.title}`,
          `status ${r.run.status} · contextMode ${r.run.contextMode} · ` +
            `token 入 ${r.run.usage.inputTokens} 出 ${r.run.usage.outputTokens}`,
          `质量门：${r.violations.map((v) => `${v.rule}(${v.severity})`).join("、") || "无违规"}`,
          "",
          "## trace",
          ...r.run.trace.map((n) => `- ${n.label} · ${JSON.stringify(n.detail).slice(0, 400)}`),
          "",
          ...["question", "take", "finding", "openQuestion", "soWhat"].flatMap((k) =>
            doc[k] ? [`## ${k}`, "", render(doc[k]), ""] : []
          ),
        ].join("\n");
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "a3-graph.md"), dump, "utf8");
        console.log(`老路那份存到 ${join(OUT_DIR, "a3-graph.md")}`);

        // 走的是老路，不是新的 —— 这一条防的是开关根本没生效而两份跑的是同一支。
        expect(r.run.contextMode).not.toBe("narrative");
        expect(r.run.status).toBe("ok");
      } finally {
        if (saved === undefined) delete process.env.TKOS_ONTOLOGY_SOURCE;
        else process.env.TKOS_ONTOLOGY_SOURCE = saved;
      }
    },
    LONG
  );

  run(
    "公司层材料进了 prompt，产出挂到了当期 Outcome 上，而且没有编造既有判断",
    async () => {
      const r = await runPreResearch(INPUT);

      const ctx = String(r.run.trace.find((n) => n.detail?.promptChars)?.detail?.promptChars ?? "");
      console.log(
        [
          `status ${r.run.status} · contextMode ${r.run.contextMode} · ${r.attempts} 轮`,
          `token 入 ${r.run.usage.inputTokens} 出 ${r.run.usage.outputTokens}`,
          `质量门 ${r.violations.length} 条违规${r.degraded ? "（降级出稿）" : ""}${ctx ? ` · prompt ${ctx} 字` : ""}`,
        ].join("\n")
      );
      for (const n of r.run.trace) {
        if (n.kind === "context" || n.kind === "anchor" || n.label.includes("本体")) {
          console.log(`  [trace] ${n.label} ${JSON.stringify(n.detail).slice(0, 240)}`);
        }
      }
      const doc = r.doc as unknown as Record<string, unknown>;
      const dump = [
        "# A3 预研 · 真本体 + 真模型",
        "",
        `题面：${INPUT.title}`,
        `status ${r.run.status} · contextMode ${r.run.contextMode} · ${r.attempts} 轮 · ` +
          `token 入 ${r.run.usage.inputTokens} 出 ${r.run.usage.outputTokens}` +
          (r.run.usage.reasoningTokens ? `（其中思考 ${r.run.usage.reasoningTokens}）` : ""),
        `质量门：${r.violations.map((v) => `${v.rule}(${v.severity})`).join("、") || "无违规"}` +
          (r.degraded ? " —— 降级出稿" : ""),
        "",
        "## trace",
        ...r.run.trace.map((n) => `- ${n.label} · ${JSON.stringify(n.detail).slice(0, 400)}`),
        "",
        ...["question", "take", "finding", "openQuestion", "soWhat"].flatMap((k) =>
          doc[k] ? [`## ${k}`, "", render(doc[k]), ""] : []
        ),
      ].join("\n");
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, "a3.md"), dump, "utf8");
      console.log(`产出已存到 ${join(OUT_DIR, "a3.md")}`);

      // ── 一、材料真的进去了 ──
      expect(r.run.contextMode).toBe("narrative");
      expect(r.run.status).toBe("ok");
      /*
       * 断言看的正文也要过 `render`。用 `String()` 的话 `finding` / `openQuestion` 会塌成
       * `[object Object]` —— 而那两栏正是最容易编造既有判断的地方，塌掉之后下面那条检查
       * 在它们身上等于没跑，却照样是绿的。
       */
      const body = ["question", "take", "finding", "openQuestion", "soWhat"]
        .map((k) => render(doc[k] ?? ""))
        .join("\n");
      expect(body.length).toBeGreaterThan(100);

      // ── 二、挂到了某条当期 Outcome / Mission 上 ──
      /*
       * 判据是**它有没有指名道姓**，不是它挂得对不对（对不对要人看）。这两条 Outcome 的
       * 名字只可能来自本体那一段 —— 模型自己编不出「8月Outcome-05Engine & Ontology」
       * 这种写法，所以命中它就等于证明了那段材料被读进去并且被用上了。
       */
      const anchored = /Outcome|Mission|Agents|Engine\s*&\s*Ontology/i.test(body);
      expect(anchored, `产出里一处 Outcome / Mission 都没提到：\n${body.slice(0, 600)}`).toBe(true);

      // ── 三、没有编造既有判断 ──
      /*
       * 工作记忆不在手上，所以这几句话这一轮**只可能是推想出来的**。列的是句式不是关键词：
       * 「判断」两个字本身在这条议题里是合法词汇（它就在谈判断那一层），拿它当禁用词会
       * 把一条正确的产出判红。
       */
      const fabricated = [
        "公司现有判断是",
        "公司已有研究表明",
        "公司此前判断",
        "我们之前认为",
        "已有共识认为",
        "在版判断显示",
      ].filter((p) => body.includes(p));
      expect(fabricated, `编了既有判断：${fabricated.join("、")}`).toEqual([]);

      // 上下文段绝不该是那句兜底 —— 它是「这一轮什么都没拿到」的说法。
      expect(body).not.toContain(NO_COMPANY_CONTEXT.slice(0, 12));
    },
    LONG
  );
});
