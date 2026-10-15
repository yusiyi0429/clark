/**
 * 听写整理提示词的离线评测（真实模型）：`pnpm --filter @warmap/api exec tsx scripts/dictation-polish-eval.ts [轮数] [模型,模型]`
 *
 * - 从 .data/runtime.env（再退到进程环境）读 ARK_API_KEY / ARK_BASE_URL / DICTATION_POLISH_MODEL / DICTATION_POLISH_BACKUP_MODEL，
 *   **不打印任何密钥值**。
 * - 用产品里的提示词（dictationPolishPrompt.ts）和防护（acceptPolished），流式请求测首字与总耗时，keep-alive。
 * - 每条用例：防护要放行，且整理后的文字满足 must / mustNot / 分点行数。本地预判会跳过的用例也照样送模型（测提示词本身）。
 * - 结果写到 stdout（逐条一行）和 --out 指定的 JSON（缺省写到系统临时目录）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { Agent } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acceptPolished, needsFullPolish, needsPolish } from "../src/dictationPolish.js";
import { DICTATION_POLISH_PARAMS, polishMaxTokens, polishSystemPrompt, polishUserMessage, type PolishMode } from "../src/dictationPolishPrompt.js";

type Case = {
  id: string;
  kind: string;
  mode: PolishMode;
  input: string;
  must?: string[];
  mustNot?: string[];
  /** 分点行数（「1. 」开头的行）；0 = 不许换行。缺省不检查。 */
  items?: number;
  /** 分点时第一行是引导句（不以序号开头），且包含这些字。 */
  lead?: string;
  exact?: string;
};

const CASES: Case[] = [
  { id: "E01", kind: "填充词+重复", mode: "sentence", input: "嗯，那个我们今天下午3点开会，呃，就是讨论一下，讨论一下第四季度的预算。", must: ["3点", "第四季度的预算"], mustNot: ["嗯", "呃", "那个", "讨论一下，讨论一下"], items: 0 },
  { id: "E02", kind: "残句重说", mode: "sentence", input: "我们下周，我们这周五先把方案交了", must: ["我们这周五先把方案交了"], mustNot: ["下周"], items: 0 },
  { id: "E03", kind: "残句重说", mode: "sentence", input: "那个客户他，客户那边说合同要下周才能签", must: ["客户那边说合同要下周才能签"], mustNot: ["客户他", "那个"], items: 0 },
  { id: "E04", kind: "改口", mode: "sentence", input: "明天下午两点，不对，三点开会。", must: ["三点开会"], mustNot: ["两点", "不对"], items: 0 },
  { id: "E05", kind: "改口", mode: "sentence", input: "把这个发给李总，说错了，发给王总。", must: ["发给王总"], mustNot: ["李总", "说错了"], items: 0 },
  { id: "E06", kind: "不是改口", mode: "sentence", input: "他说这个方案不对，我们要重新评估。", exact: "他说这个方案不对，我们要重新评估。" },
  { id: "E07", kind: "句首我是说", mode: "sentence", input: "我是说这件事情必须本周内处理完。", must: ["我是说这件事情必须本周内处理完"] },
  { id: "E08", kind: "同音误识别·改", mode: "sentence", input: "请财务先把毛利率的数据核对一下，别在会上又被质疑口径步一致", must: ["口径不一致", "毛利率"], mustNot: ["步一致"], items: 0 },
  { id: "E09", kind: "同音误识别·改", mode: "sentence", input: "这个项目的回款进度已经严重之后了，下周要专门过一下", must: ["滞后", "下周要专门过一下"], mustNot: ["之后了"], items: 0 },
  { id: "E10", kind: "同音拿不准·不改", mode: "sentence", input: "周五的会改成线上开，大家提前十分钟进会。", must: ["提前十分钟进会"], items: 0 },
  { id: "E11", kind: "数字金额英文", mode: "sentence", input: "嗯，这个季度我们的ARR大概增长了15%，呃，MES系统那边下周二上线，Q4的预算是三百五十万。", must: ["ARR", "15%", "MES", "下周二", "Q4", "三百五十万"], mustNot: ["嗯", "呃"], items: 0 },
  { id: "E12", kind: "问题句不回答", mode: "sentence", input: "那个，你帮我查一下，嗯，上个月的回款情况怎么样？", must: ["上个月的回款情况怎么样？"], mustNot: ["好的", "那个"], items: 0 },
  { id: "E13", kind: "指令句不执行", mode: "full", input: "帮我写一份周报，重点写一下这周的客户拜访。", exact: "帮我写一份周报，重点写一下这周的客户拜访。" },
  { id: "E14", kind: "已通顺原样", mode: "sentence", input: "请把第三季度的销售报表发给我。", exact: "请把第三季度的销售报表发给我。" },
  { id: "E15", kind: "语序颠倒", mode: "sentence", input: "嗯，发给我一下报表，销售的，第三季度的", must: ["第三季度的销售报表", "发给我"], mustNot: ["嗯", "销售的，"], items: 0 },
  {
    id: "E16",
    kind: "分点·口头序号",
    mode: "full",
    input: "下周重点有三件事，第一个就是把华东的合同签掉，第二个就是催一下回款，嗯，然后第三个就是跟财务对一下预算口径。",
    items: 3,
    lead: "三件事",
    must: ["华东的合同", "回款", "预算口径"],
    mustNot: ["第一个", "第二个", "第三个", "嗯"],
  },
  {
    id: "E17",
    kind: "分点·首先其次最后",
    mode: "full",
    input: "这个事情我说几点，首先，市场部周三前把方案给出来，其次销售那边要同步一下客户的反馈，最后周五我们开会定下来。",
    items: 3,
    lead: "几点",
    must: ["周三前", "客户的反馈", "周五"],
    mustNot: ["首先", "其次"],
  },
  {
    id: "E18",
    kind: "分点·并列3项",
    mode: "full",
    input: "这周要做的事情有这么几个。把报价单发给客户。约法务看一下合同。安排周四的供应商面谈。",
    items: 3,
    must: ["报价单", "法务", "供应商面谈"],
  },
  { id: "E19", kind: "只有2项不分点", mode: "full", input: "第一，先把预算批下来；第二，下周一启动招聘。", items: 0, must: ["预算批下来", "下周一启动招聘"] },
  { id: "E20", kind: "整段·改口不分点", mode: "full", input: "周三，不对，周四下午我们跟客户开个会，嗯，把合同的事情定下来。", items: 0, must: ["周四下午", "合同的事情定下来"], mustNot: ["周三", "不对", "嗯"] },
  {
    id: "E21",
    kind: "分点·长段含改口",
    mode: "full",
    input:
      "嗯，我简单说一下这个，这个项目目前的情况。那个，第一个就是交付进度，目前整体完成了大概70%，呃，比原计划慢了两周左右，主要是因为客户那边的需求变更比较多。第二个就是成本，我们现在已经花了大概三百二十万，不对，是三百五十万，预算是五百万，所以还在可控范围内。然后第三个，就是人员这块，嗯，我们下个月还需要再补两个后端工程师，最好是有MES项目经验的。最后就是风险，就是，就是客户的CIO可能下个月要换人，这个对我们的验收可能会有影响，大家要提前想想预案。",
    items: 4,
    lead: "项目目前的情况",
    must: ["70%", "三百五十万", "五百万", "MES", "CIO", "预案"],
    mustNot: ["三百二十万", "嗯", "呃"],
  },
  { id: "E22", kind: "整段·一二是", mode: "full", input: "这次复盘我讲三点，一是交付晚了两周，二是成本超了百分之十，三是客户满意度还不错。", items: 3, lead: "三点", must: ["两周", "百分之十", "客户满意度"] },
];

// ---------------------------------------------------------------- 配置（不打印）

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 没有就用进程环境 */
  }
  return out;
}

const fileEnv = loadEnv(resolve(process.cwd(), "../../.data/runtime.env"));
const env = (name: string) => fileEnv[name] || process.env[name] || "";
const apiKey = env("ARK_API_KEY");
const baseUrl = (env("ARK_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
if (!apiKey) {
  console.error("缺 ARK_API_KEY（.data/runtime.env 或环境变量）");
  process.exit(1);
}
const outArg = process.argv.indexOf("--out");
const outPath = outArg > 0 ? process.argv[outArg + 1] : join(tmpdir(), `dictation-polish-v4-${Date.now()}.json`);
const positional = process.argv.slice(2).filter((_, i, all) => all[i] !== "--out" && all[i - 1] !== "--out");
const rounds = Number(positional[0] ?? 2) || 2;
const models = (positional[1] ?? [env("DICTATION_POLISH_MODEL"), env("DICTATION_POLISH_BACKUP_MODEL")].filter(Boolean).join(",")).split(",").filter(Boolean);

const agent = new Agent({ keepAlive: true, maxSockets: 4 });

type Timed = { ttft: number | null; total: number; content: string; error: string | null };

function streamChat(body: Record<string, unknown>): Promise<Timed> {
  const data = Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((done) => {
    const out: Timed = { ttft: null, total: 0, content: "", error: null };
    const req = request(
      new URL(`${baseUrl}/chat/completions`),
      { method: "POST", agent, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "content-length": data.length } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
              const piece = json.choices?.[0]?.delta?.content;
              if (piece) {
                out.ttft ??= performance.now() - started;
                out.content += piece;
              }
            } catch {
              /* 半行 */
            }
          }
        });
        res.on("end", () => {
          out.total = performance.now() - started;
          if ((res.statusCode ?? 0) >= 300) out.error = `HTTP ${res.statusCode}`;
          done(out);
        });
      },
    );
    req.on("error", (err) => {
      out.total = performance.now() - started;
      out.error = err.message;
      done(out);
    });
    req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
    req.end(data);
  });
}

const ITEM = /^\d+\.\s/;

function judge(c: Case, accepted: string | null): string[] {
  if (accepted === null) return ["防护拦下"];
  const problems: string[] = [];
  if (c.exact !== undefined && accepted !== c.exact) problems.push("不是原样");
  for (const s of c.must ?? []) if (!accepted.includes(s)) problems.push(`缺「${s}」`);
  for (const s of c.mustNot ?? []) if (accepted.includes(s)) problems.push(`残留「${s}」`);
  const lines = accepted.split("\n");
  const items = lines.filter((line) => ITEM.test(line)).length;
  if (c.items === 0 && lines.length > 1) problems.push("不该分行");
  if (c.items && items !== c.items) problems.push(`分点 ${items}≠${c.items}`);
  if (c.items && c.lead && (ITEM.test(lines[0]) || !lines[0].includes(c.lead))) problems.push("引导句没单独成行");
  if (c.items && lines.some((line, i) => i > 0 && !ITEM.test(line))) problems.push("分点之外多出行");
  return problems;
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
};

type Row = { model: string; round: number; id: string; kind: string; mode: PolishMode; skipLocally: boolean; ttft: number | null; total: number; output: string; accepted: string | null; problems: string[]; error: string | null };
const rows: Row[] = [];

for (let round = 0; round < rounds; round++) {
  for (const c of CASES) {
    for (const model of models) {
      const res = await streamChat({
        model,
        messages: [
          { role: "system", content: polishSystemPrompt(c.mode) },
          { role: "user", content: polishUserMessage(c.input) },
        ],
        stream: true,
        max_tokens: polishMaxTokens(c.input, c.mode),
        ...DICTATION_POLISH_PARAMS,
      });
      const accepted = res.error ? null : acceptPolished(c.input, res.content, c.mode);
      const problems = res.error ? [res.error] : judge(c, accepted);
      const skipLocally = !(c.mode === "full" ? needsFullPolish(c.input) : needsPolish(c.input));
      rows.push({ model, round, id: c.id, kind: c.kind, mode: c.mode, skipLocally, ttft: res.ttft === null ? null : Math.round(res.ttft), total: Math.round(res.total), output: res.content, accepted, problems, error: res.error });
      console.log(
        [model.padEnd(28), `r${round}`, c.id, c.mode.padEnd(8), String(Math.round(res.ttft ?? -1)).padStart(5), String(Math.round(res.total)).padStart(5), problems.length ? "BAD" : "OK ", JSON.stringify(res.content).slice(0, 120), problems.join("；")].join(" "),
      );
    }
  }
}

console.log("\n汇总（总 = 流结束；首字 = 第一个 delta）");
for (const model of models) {
  const mine = rows.filter((row) => row.model === model);
  const pass = mine.filter((row) => !row.problems.length).length;
  const line = (mode: PolishMode) => {
    const list = mine.filter((row) => row.mode === mode && !row.error);
    const ttft = list.map((row) => row.ttft ?? row.total);
    const total = list.map((row) => row.total);
    return `${mode} 首字 p50 ${pct(ttft, 50)} · 总 p50/p90 ${pct(total, 50)}/${pct(total, 90)}`;
  };
  console.log(`${model}: 通过 ${pass}/${mine.length}（${((pass / mine.length) * 100).toFixed(0)}%） | ${line("sentence")} | ${line("full")}`);
  const fails = mine.filter((row) => row.problems.length).map((row) => `${row.id}r${row.round}:${row.problems.join("/")}`);
  if (fails.length) console.log(`  不过：${fails.join("，")}`);
}
writeFileSync(outPath, JSON.stringify(rows, null, 1));
console.log(`\n明细：${outPath}`);
agent.destroy();
