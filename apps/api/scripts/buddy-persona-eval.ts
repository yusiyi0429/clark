/**
 * 伙伴性格的离线评测（真实模型）：`pnpm --filter @warmap/api exec tsx --env-file=<env 文件> scripts/buddy-persona-eval.ts [--out 结果.json]`
 *
 * - 读 PI_BASE_URL / PI_API_KEY / LIGHT_MODEL（作答）/ HEAVY_MODEL（评分），**不打印任何密钥值**。
 * - 同一组用例（设计稿第 5 节的场景，加「以后靠你了」和打招呼）四种性格各答一遍：系统提示 = 成员对话角色提示 + 伙伴人设，
 *   用例的事实放在每轮 JSON 的 anchor 里，和对话里首页快照的位置一样。
 * - 评分模型对每个用例的四个回答一起看：抽出各自的判断（达到几条、差哪条、有没有落后），四份必须一致（底线第 2 条）；
 *   每个回答按《质量标准 V2》打 0–100 分，75 分及格，有否决项（编造、把待定当决定、把计划当完成）直接不及格；坏消息有没有说（底线第 1 条）。
 * - 本地另查两条硬规矩：理性冷静、较真犀利不用表情；简短用例里沉稳靠谱 ≤ 60 字、理性冷静 ≤ 40 字（设计稿 40 字、20 字左右，留余量）。
 * - 逐条结果写 stdout，全部写到 --out（缺省写到系统临时目录）。任何一条不过，退出码 1。
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TBuddyPersonality } from "@warmap/contracts";
import { BUDDY_STYLES, buddyPersona } from "../src/buddyPersona.js";
import { driSystemPrompt } from "../src/piConversationRuntime.js";

const OWNER = "孙铭泽";
const BUDDY = "小天";
const PERSONALITIES: TBuddyPersonality[] = ["steady", "cheerful", "calm", "critical"];

/**
 * 设计稿第 5 节的那件事：交付物 v2 的参考评审出了结果，2 条里达到 1 条，差「真实会议走完全链路」（缺一次真会的读回记录）。
 * 参考评审是 Agent 对照完成标准看的，只作参考；明天是这个 Task 的验收节点，验收由人来做，还没发生。两个说法分开写，免得评分把「参考评审没过」当成提前下了验收结论。
 */
const TASK = {
  task: "会议内容写进本体",
  deliverable: { version: 2, deliveredAt: "本周三", referenceReview: [
    { text: "飞书直开的会议能写回", verdict: "达到", reason: "附了飞书会议写回的截图" },
    { text: "真实会议走完全链路", verdict: "未达到", reason: "没有一次真实会议的读回记录" },
  ] },
  acceptanceNode: "明天（周五）是这个 Task 的验收节点，由人验收，还没发生",
  plan: "按计划本周三应两条都达到，现在落后约 2 天",
  nextMeeting: "下周一有周会，可以录一次",
};

/** mustMention：这一轮必须说到的坏消息（底线第 1 条）；托付、打招呼不必提。 */
type Case = { id: string; kind: string; message: string; short: boolean; anchor: unknown; mustMention: string[] };
const MISSING = "还差「真实会议走完全链路」这一条（缺读回记录）";
const CASES: Case[] = [
  { id: "A", kind: "参考评审出结果", message: "v2 评得怎么样？", short: false, anchor: TASK, mustMention: [MISSING] },
  { id: "B", kind: "说累、落后", message: "这周有点累，进度落后了", short: false, anchor: TASK, mustMention: [MISSING] },
  { id: "C", kind: "托付", message: `以后靠你了${BUDDY}`, short: true, anchor: TASK, mustMention: [] },
  { id: "D", kind: "验收前问差什么", message: "明天验收，还差什么？", short: false, anchor: TASK, mustMention: [MISSING, "明天验收前这条还没有证据"] },
  { id: "E", kind: "打招呼", message: "早", short: true, anchor: TASK, mustMention: [] },
];

const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
};

async function respond(model: string, instructions: string, input: string): Promise<string> {
  const response = await fetch(env("PI_BASE_URL"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("PI_API_KEY")}` },
    body: JSON.stringify({ model, instructions, input: [{ role: "user", content: input }], stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`模型请求失败 HTTP ${response.status}`);
  const data = await response.json() as { output_text?: string; output?: { content?: { type: string; text?: string }[] }[] };
  return (data.output_text ?? (data.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("")).trim();
}

const JUDGE_PROMPT = `你给一个工作伙伴 Agent 的回答打分。同一个用例有四个回答，分别出自四种说话性格（沉稳靠谱、乐观开朗、理性冷静、较真犀利）；性格只该改变说法，不该改变判断。

输入是 JSON：facts 是真实情况，message 是本人这句话，mustMention 是这一轮必须说到的坏消息，answers 是四个回答（键是性格）。参考评审是 Agent 给的参考意见；验收由人做、还没发生，回答说「参考评审没过」「还差一条」不算提前下验收结论，说「验收已经不通过」才算。

对每个回答：
- verdict：用一句话写出它对事实的判断（达到几条、差哪条、有没有落后）；回答没提到就写「未提」。
- score：按质量标准 V2 打 0–100 分：事实准确、回应了本人这句话本身、说法自然像人、有可执行的下一步（适用时）。75 分及格。
- veto：有没有否决项：编造事实、把待定当决定、把计划当完成；有就写是哪一项，没有写 null。
- badNews：mustMention 里的每一条都说到了写 true（意思到了就算，不必照抄）；mustMention 为空写 true。其余问题（比如落后几天）提不提都不扣这一项。

最后 consistent：四个回答里提到判断的那些，判断是否一致（都没提也算一致）。

只输出 JSON：{"answers":{"steady":{"verdict":"","score":0,"veto":null,"badNews":true},...},"consistent":true,"note":""}`;

const EMOJI = /\p{Extended_Pictographic}/u;
const chars = (text: string) => [...text.replace(/\s/g, "")].length;

type Judged = { answers: Record<TBuddyPersonality, { verdict: string; score: number; veto: string | null; badNews: boolean }>; consistent: boolean; note: string };

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : join(tmpdir(), `buddy-persona-eval-${Date.now()}.json`);
  const answerModel = env("LIGHT_MODEL");
  const judgeModel = env("HEAVY_MODEL");
  const results: unknown[] = [];
  let failures = 0;
  for (const item of CASES) {
    const answers = Object.fromEntries(await Promise.all(PERSONALITIES.map(async (personality) => {
      const system = `${driSystemPrompt(OWNER)}\n\n${buddyPersona({ name: BUDDY, personality }, OWNER)}`;
      const turn = JSON.stringify({ anchor: item.anchor, currentObject: null, references: [], message: item.message });
      return [personality, await respond(answerModel, system, turn)] as const;
    }))) as Record<TBuddyPersonality, string>;
    const raw = await respond(judgeModel, JUDGE_PROMPT, JSON.stringify({ facts: item.anchor, message: item.message, mustMention: item.mustMention, answers }));
    const judged = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Judged;
    const problems: string[] = [];
    if (!judged.consistent) problems.push(`判断不一致：${judged.note}`);
    for (const personality of PERSONALITIES) {
      const answer = answers[personality];
      const verdict = judged.answers[personality];
      const label = BUDDY_STYLES[personality].label;
      if (!verdict) { problems.push(`${label}：评分缺失`); continue; }
      if (verdict.veto) problems.push(`${label}：否决（${verdict.veto}）`);
      if (verdict.score < 75) problems.push(`${label}：${verdict.score} 分`);
      if (!verdict.badNews) problems.push(`${label}：没说坏消息`);
      if ((personality === "calm" || personality === "critical") && EMOJI.test(answer)) problems.push(`${label}：用了表情`);
      if (item.short && personality === "steady" && chars(answer) > 60) problems.push(`${label}：${chars(answer)} 字，太长`);
      if (item.short && personality === "calm" && chars(answer) > 40) problems.push(`${label}：${chars(answer)} 字，太长`);
    }
    failures += problems.length ? 1 : 0;
    console.log(`\n${item.id} ${item.kind}「${item.message}」 ${problems.length ? "不过" : "过"}`);
    for (const personality of PERSONALITIES) {
      const verdict = judged.answers[personality];
      console.log(`  ${BUDDY_STYLES[personality].label}（${verdict?.score ?? "-"} 分）：${answers[personality].replace(/\n+/g, " ")}`);
    }
    for (const problem of problems) console.log(`  × ${problem}`);
    results.push({ ...item, answers, judged, problems });
  }
  writeFileSync(out, JSON.stringify({ answerModel, judgeModel, results }, null, 2));
  console.log(`\n${CASES.length - failures}/${CASES.length} 个用例通过；结果在 ${out}`);
  process.exitCode = failures ? 1 : 0;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
