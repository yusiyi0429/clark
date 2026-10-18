/**
 * 会后分层（H2）与影响分析（H3）的离线评测脚手架（真实模型）：
 *   pnpm --filter @warmap/api exec tsx scripts/eval-meeting-layering.ts --ids M030,M036 [--impact] [--out <目录>] [--dir <纪要目录>] [--env <.env 路径>]
 *
 * - 只读真实会议纪要目录（缺省 C:\Users\10021\Desktop\clark\minutes\eval-2026-10，每场一个目录：meta.json、transcript.md）。这是敏感数据：
 *   结果和标注表只写到 --out（缺省本仓库 .scratch/meeting-impact/eval/<时间>/，已在 .gitignore 里），不进仓库、不进 LangSmith（不读 LANGSMITH_*）。
 * - 模型配置从 --env 指的 .env 读 PI_BASE_URL / PI_API_KEY / HEAVY_MODEL（OUTCOME_MODEL / OUTCOME_THINKING 优先）/ LIGHT_MODEL，不打印任何密钥。
 * - 流程与线上一致：逐字稿 → 会后抽取（postMeetingAgent，带公司地图）→ 服务端校验（assessOutcomeCandidate）→ 分层（meetingDecisionAgent）→
 *   挑主持人条目（selectHostDecisions）；--impact 时再对「定了」的条目跑影响分析（候选人用 10 月已知 Mission，没有 Task 快照）。
 * - 输出：每场一个 JSON；标注表 H2 标注表.csv（UTF-8 BOM，Excel 直接打开）；--impact 时另有 H3 标注表.csv；summary.md 是计数与耗时。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TMeetingOutcomeItem, TMeetingParticipant, TTranscriptTurn } from "@warmap/contracts";
import { agentModel, agentModelEnvFrom } from "../src/agentModels.js";
import { createImpactAgent, type TImpactAnalysisCandidate } from "../src/impactAgent.js";
import type { ImpactCandidate, InterpretationContext } from "../src/meetingContext.js";
import { createDecisionLayeringAgent, transcriptLines, type TDecisionLayeringCandidate } from "../src/meetingDecisionAgent.js";
import { selectHostDecisions } from "../src/meetingDecisions.js";
import { assessOutcomeCandidate } from "../src/outcome.js";
import { createPostMeetingAgent } from "../src/postMeetingAgent.js";
import { parseFeishuTranscriptText } from "../src/transcriptMarkdown.js";

const REPO = resolve(import.meta.dirname, "../../..");
const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; };
const DIR = arg("dir") ?? "C:\\Users\\10021\\Desktop\\clark\\minutes\\eval-2026-10";
const ENV_FILE = arg("env") ?? "C:\\Users\\10021\\Desktop\\clark\\Tianshu-MVP\\apps\\api\\.env";
const IDS = (arg("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const WITH_IMPACT = process.argv.includes("--impact");
const OUT = arg("out") ?? join(REPO, ".scratch", "meeting-impact", "eval", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
if (!IDS.length) throw new Error("用 --ids M030,M036 指定要跑的会");

const env = Object.fromEntries(readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("="))
  .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]));
for (const key of ["PI_BASE_URL", "PI_API_KEY", "HEAVY_MODEL"]) if (!env[key]) throw new Error(`${ENV_FILE} 缺 ${key}`);
const model = agentModel(agentModelEnvFrom(env), "outcome", { modelId: env.HEAVY_MODEL });
const noopQuery = async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
const base = { query: noopQuery as never, baseUrl: env.PI_BASE_URL, apiKey: env.PI_API_KEY, ...model };
const extractor = createPostMeetingAgent(base);
const layering = createDecisionLayeringAgent(base);
const impact = createImpactAgent({ ...base, answerModelId: env.LIGHT_MODEL || model.modelId });

/** 人员目录：公司名单（.env 里 COMPANY_PEOPLE_SEED 指的文件，不在仓库里）；10 月已知 Mission 的「本月一句话」当作 Mission outcome。 */
const peopleFile = arg("people") ?? resolve(dirname(ENV_FILE), env.COMPANY_PEOPLE_SEED ?? "../../seed/company-people.json");
const seedPeople = (JSON.parse(readFileSync(peopleFile, "utf8")) as { people: { personId: string; displayName: string; roles: string[] }[] }).people;
const known = (JSON.parse(readFileSync(join(REPO, "seed", "imports", "2026-10-known-missions.json"), "utf8")) as { items: { personId: string; title: string; markdown: string }[] }).items;
const oneLiner = (markdown: string) => /\*\*本月一句话：\*\*\s*([^\n]+)/.exec(markdown)?.[1].trim() ?? markdown.replace(/<[^>]+>/g, "").slice(0, 300);
/** --candidates：影响分析的候选人快照（ImpactCandidate[]，带 Task 和验收项）；冒烟用脱敏样例时给，真实纪要没有会议当天的 Task 快照。 */
const candidatesFile = arg("candidates");
const candidates: ImpactCandidate[] | null = candidatesFile ? JSON.parse(readFileSync(candidatesFile, "utf8")) as ImpactCandidate[] : null;
const context: InterpretationContext = {
  period: "2026-10",
  company: { longTermOutcome: null, monthOutcome: null },
  battlefields: [],
  worldGoals: [],
  people: candidates ? candidates.map(({ tasks: _tasks, ...person }) => person) : known.map((item) => ({ personId: item.personId, name: seedPeople.find((person) => person.personId === item.personId)?.displayName ?? item.personId,
    missions: [{ id: `mission:${item.personId}:2026-10`, code: `${item.personId}-202610`, title: item.title.split("｜").slice(1).join("｜") || item.title, outcome: oneLiner(item.markdown), timeBoundary: "2026-10-31" }] })),
};
const CEO = seedPeople.find((person) => person.roles.includes("ceo"))!;

type Meta = { id: string; title: string; start_time: string; organizer?: string; participants?: string[]; type?: string };
const csv = (rows: (string | number | null | undefined)[][]) => `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n")}\r\n`;
const clock = () => Date.now();

async function runMeeting(id: string) {
  const folder = readdirSync(DIR).find((name) => name.startsWith(`${id}_`));
  if (!folder) throw new Error(`${id} 不在 ${DIR}`);
  const meta = JSON.parse(readFileSync(join(DIR, folder, "meta.json"), "utf8")) as Meta;
  const raw = readFileSync(join(DIR, folder, "transcript.md"), "utf8");
  const parsed = parseFeishuTranscriptText(raw);
  if (!parsed.ok) throw new Error(`${id} 逐字稿解析失败：${parsed.error.message}`);
  // 说话人对人：公司名单里有的用真实 id，其余记成访客。
  const ids = new Map<string, string>();
  for (const turn of parsed.transcript.turns) {
    if (ids.has(turn.speakerName)) continue;
    const person = seedPeople.find((item) => turn.speakerName.startsWith(item.displayName));
    ids.set(turn.speakerName, person?.personId ?? `guest-${ids.size + 1}`);
  }
  const participants: TMeetingParticipant[] = [...new Map([[CEO.displayName, CEO.personId], ...ids]).entries()].map(([name, personId]) => ({
    personId, displayName: name, roles: personId === CEO.personId ? ["ceo", "dri"] : ["participant"], sourceRef: "eval", updatedAt: new Date().toISOString(),
  }));
  const unique = [...new Map(participants.map((person) => [person.personId, person])).values()];
  const host = seedPeople.find((person) => person.displayName === meta.organizer) ?? CEO;
  const turns: TTranscriptTurn[] = parsed.transcript.turns.map((turn, index) => ({ id: `turn-${String(index + 1).padStart(4, "0")}`, speakerId: ids.get(turn.speakerName)!, text: turn.text }));
  const names = new Map(unique.map((person) => [person.personId, person.displayName]));

  const t0 = clock();
  const generated = await extractor.generate({
    meeting: { id, title: meta.title, scheduledAt: new Date(meta.start_time.replace(" ", "T") + ":00+08:00").toISOString(), ceoParticipantId: CEO.personId, participants: unique },
    transcript: { turns }, issues: [], context,
  }, AbortSignal.timeout(600_000));
  // 已知问题（线上同样存在，待用户定修法）：结构化提交要求每个字段都填，没有关联议题的会里模型把会议 id 填进 issueId，
  // 校验按「issueId 不属于该会」整条丢掉。评测为了看分层质量，先把这种 issueId 去掉（这场会没有议题）。
  const candidate = generated.candidate as { items?: Record<string, unknown>[] };
  const stripped = candidate.items?.filter((item) => item.issueId !== undefined).length ?? 0;
  for (const item of candidate.items ?? []) delete item.issueId;
  const assessed = assessOutcomeCandidate({ candidate, turns, participants: unique, ceoParticipantId: CEO.personId, issueIds: [] });
  if (!assessed.ok) throw new Error(`${id} 抽取候选不合格：${assessed.message}`);
  const t1 = clock();
  const items: TMeetingOutcomeItem[] = assessed.items;
  const lookup = (personId: string | null) => (personId ? names.get(personId) ?? personId : null);
  // 与线上一致：没有可挑的条目就不调分层模型。
  const pickable = items.some((item) => ["decision", "todo", "ceoJudgment", "reopenWhen"].includes(item.kind));
  const layered: TDecisionLayeringCandidate = !pickable ? { decisions: [] } : await layering.layer({
    meeting: { id, title: meta.title, date: meta.start_time.slice(0, 10), host: { personId: host.personId, name: host.displayName }, ceo: { personId: CEO.personId, name: CEO.displayName },
      attendees: unique.map((person) => ({ personId: person.personId, name: person.displayName })) },
    summary: assessed.summary,
    items: items.filter((item) => item.kind !== "strategic").map((item) => ({ id: item.id, kind: item.kind, text: item.text, quote: item.quote, turnId: item.turnId,
      speaker: lookup(item.speakerId)!, owner: lookup(item.ownerPersonId), dueDate: item.dueDate ?? null, parentItemId: item.parentItemId })),
    strategic: items.filter((item) => item.kind === "strategic").map((item) => ({ id: item.id, title: item.title ?? item.text, brief: item.brief ?? "" })),
    transcript: transcriptLines(turns, names),
    context,
  }, AbortSignal.timeout(600_000));
  const hostRows = selectHostDecisions(items, layered);
  const t2 = clock();

  const impacts: { statement: string; tier: string; cards: TImpactAnalysisCandidate["cards"] }[] = [];
  if (WITH_IMPACT) {
    const people: ImpactCandidate[] = candidates ?? context.people.map((person) => ({ ...person, tasks: [] }));
    const targets = [
      // 评测里假定 CEO 同意战略项（与线上 CEO 确认后的输入一致）。
      ...items.filter((item) => item.kind === "strategic").map((item) => ({ statement: `CEO 同意：${item.title ?? item.text}${item.brief ? `（${item.brief}）` : ""}`, tier: "strategic", quote: item.quote, speaker: lookup(item.speakerId), why: item.brief ?? null, itemIds: [item.id] })),
      ...hostRows.filter((row) => row.recommendation === "confirmed").map((row) => ({ statement: row.statement, tier: "host", quote: row.primary.quote, speaker: lookup(row.primary.speakerId), why: row.why, itemIds: row.itemIds })),
    ];
    for (const target of targets) {
      const result = await impact.analyze({
        today: meta.start_time.slice(0, 10),
        decision: { statement: target.statement, decidedBy: target.tier === "strategic" ? "ceo" : "host", meeting: { title: meta.title, date: meta.start_time.slice(0, 10), host: host.displayName },
          quote: target.quote, speaker: target.speaker, why: target.why },
        relatedItems: items.filter((item) => target.itemIds.includes(item.id)).map((item) => ({ kind: item.kind, text: item.text, owner: lookup(item.ownerPersonId), dueDate: item.dueDate ?? null })),
        meetingSummary: assessed.summary, company: context.company, people,
      }, { decisionId: `${id}:${target.statement.slice(0, 10)}` }, AbortSignal.timeout(600_000));
      impacts.push({ statement: target.statement, tier: target.tier, cards: result.cards });
    }
  }
  const t3 = clock();
  return {
    id, title: meta.title, date: meta.start_time, type: meta.type ?? "", organizer: meta.organizer ?? null, turns: turns.length, speakers: Object.fromEntries(names), strippedIssueIds: stripped,
    timings: { extractMs: t1 - t0, layerMs: t2 - t1, impactMs: t3 - t2 },
    summary: assessed.summary, items, warnings: assessed.warnings, layered, hostRows: hostRows.map((row) => ({ ...row, speaker: lookup(row.primary.speakerId) })), impacts,
  };
}

mkdirSync(OUT, { recursive: true });
const results = [];
for (const id of IDS) {
  process.stdout.write(`${id} … `);
  try {
    const result = await runMeeting(id);
    writeFileSync(join(OUT, `${id}.json`), JSON.stringify(result, null, 2));
    results.push(result);
    console.log(`抽取 ${result.items.length} 条（战略 ${result.items.filter((item) => item.kind === "strategic").length}），主持人 ${result.hostRows.length} 条，${Math.round((result.timings.extractMs + result.timings.layerMs + result.timings.impactMs) / 1000)}s`);
  } catch (error) {
    console.log(`失败：${(error as Error).message}`);
    writeFileSync(join(OUT, `${id}.error.txt`), String((error as Error).stack ?? error));
  }
}

const KIND: Record<string, string> = { decision: "决定", todo: "待办", ceoJudgment: "CEO 判断", reopenWhen: "重开条件", open: "未决", strategic: "战略" };
const h2: (string | number | null)[][] = [["会议编号", "会议", "日期", "层级", "序号", "会上定了什么", "原话", "说话人", "Agent 推荐", "推荐依据", "标注：真定了吗（对/改一下/其实没定）", "标注：层级对吗（对/应给CEO/应给主持人/不该出现）", "标注：改成", "备注"]];
for (const result of results) {
  const speaker = (personId: string) => result.speakers[personId] ?? personId;
  result.items.filter((item) => item.kind === "strategic").forEach((item, index) =>
    h2.push([result.id, result.title, result.date.slice(0, 10), "战略→CEO", index + 1, `${item.title ?? item.text}：${item.brief ?? ""}`, item.quote, speaker(item.speakerId), "等 CEO", "", "", "", "", ""]));
  result.hostRows.forEach((row, index) =>
    h2.push([result.id, result.title, result.date.slice(0, 10), "主持人确认", index + 1, row.statement, row.primary.quote, row.speaker, row.recommendation === "confirmed" ? "定了" : "其实没定", row.why, "", "", "", ""]));
  const picked = new Set(result.hostRows.flatMap((row) => row.itemIds));
  result.items.filter((item) => (item.kind === "decision" || item.kind === "todo") && !picked.has(item.id)).forEach((item, index) =>
    h2.push([result.id, result.title, result.date.slice(0, 10), `未挑（${KIND[item.kind]}）`, index + 1, item.text, item.quote, speaker(item.speakerId), "", "", "", "", "", ""]));
  h2.push([result.id, result.title, result.date.slice(0, 10), "漏掉的（请补）", "", "", "", "", "", "", "", "", "", ""]);
}
writeFileSync(join(OUT, "H2 标注表.csv"), csv(h2));

if (WITH_IMPACT) {
  const h3: (string | number | null)[][] = [["会议编号", "决定", "层级", "收卡人", "落到", "卡面：影响", "要做什么", "截止", "置信度", "前因后果", "标注：该收到吗", "标注：落点对吗", "标注：看得懂、知道要做什么吗", "备注"]];
  for (const result of results) for (const item of result.impacts) {
    if (!item.cards.length) h3.push([result.id, item.statement, item.tier, "（没有人受影响）", "", "", "", "", "", "", "", "", "", ""]);
    for (const card of item.cards) {
      const person = (candidates ?? []).find((candidate) => candidate.personId === card.personId);
      const label = (target: { type: string; id: string; index?: number }) => {
        const task = person?.tasks.find((candidate) => candidate.id === target.id);
        const mission = context.people.flatMap((candidate) => candidate.missions).find((candidate) => candidate.id === target.id);
        if (target.type === "acceptance" && task) return `验收项：${task.title} · ${task.acceptance[target.index ?? -1] ?? "?"}`;
        return task ? `Task：${task.title}` : mission ? `Mission：${mission.title}` : `${target.type}:${target.id}`;
      };
      h3.push([result.id, item.statement, item.tier, context.people.find((candidate) => candidate.personId === card.personId)?.name ?? card.personId,
        card.targets.map(label).join("；"), card.impact, card.action.text, card.action.due, card.confidence, card.why, "", "", "", ""]);
    }
  }
  writeFileSync(join(OUT, "H3 标注表.csv"), csv(h3));
}

const lines = ["# 会后分层评测（初跑）", "", `模型：${model.modelId}（思考 ${model.thinkingLevel}）；纪要目录只读；${new Date().toISOString()}`, "",
  "去掉的 issueId：没有关联议题的会里模型填进 issueId 的会议 id（见脚本注释，线上待修）。", "",
  "| 会 | 类型 | 发言段 | 抽取条目 | 去掉的 issueId | 校验丢弃 | 战略→CEO | 主持人条目 | 其中推荐「其实没定」 | 影响卡 | 抽取 s | 分层 s | 影响 s |", "|-|-|-|-|-|-|-|-|-|-|-|-|-|"];
for (const result of results) {
  lines.push(`| ${result.id} ${result.title} | ${result.type} | ${result.turns} | ${result.items.length} | ${result.strippedIssueIds} | ${result.warnings.length} | ${result.items.filter((item) => item.kind === "strategic").length} | ${result.hostRows.length} | ${result.hostRows.filter((row) => row.recommendation === "not_decided").length} | ${result.impacts.reduce((sum, item) => sum + item.cards.length, 0)} | ${Math.round(result.timings.extractMs / 1000)} | ${Math.round(result.timings.layerMs / 1000)} | ${Math.round(result.timings.impactMs / 1000)} |`);
}
lines.push("", "## 校验丢弃的原因", "");
for (const result of results) for (const warning of result.warnings) lines.push(`- ${result.id}：${warning.reason}`);
writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
console.log(`输出：${OUT}`);
