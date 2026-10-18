/**
 * H12 记忆导入评测（真实模型）：`pnpm --filter @warmap/api exec tsx scripts/memory-import-eval.ts --env <apps/api/.env 路径> [--runs 3] [--model id] [--out file.json]`
 *
 * - 数据：.scratch/memory-page-import/h12/dataset.json，全部虚构（不含任何人本机的真实记忆原文）。
 * - 跑产品里同一套函数：splitDocs → classifyCandidates → reconcileCandidates → decide（memoryImport.ts），模型调用同 memoryImportAgent.ts。
 * - 从 --env 指定的文件读 PI_BASE_URL / PI_API_KEY / LIGHT_MODEL / MEMORY_IMPORT_MODEL / MEMORY_IMPORT_THINKING，**不打印任何密钥值**；不开 LangSmith。
 * - 按源文件七三分开发集 / 测试集（文件 id 的哈希），阈值只在开发集上看，测试集报最终数字。
 * - 门槛：分类准确率 ≥ 90%；默认勾选里错的 ≤ 2%；要本人看的 ≤ 15%。另报去重 F1、冲突找出率、密钥 / 注入被勾选次数。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCandidates, decide, effectiveConfidence, reconcileCandidates, splitDocs,
  type Candidate, type Category, type ExistingMemory, type ImportSource, type ReadDoc,
} from "../src/memoryImport.js";
import { createMemoryImportModel } from "../src/memoryImportAgent.js";
import type { CandidateThinkingLevel } from "../src/candidateAgentRuntime.js";

type Gold = {
  id: string; doc: string; text: string; gold_category: Category; gold_kind: string | null; drop_reason: string | null;
  gold_default_checked: boolean; gold_duplicate_of: string | null; gold_conflicts_with: string[]; adversarial: boolean; note: string;
};
type Dataset = { existing: (ExistingMemory & { kind: string })[]; documents: { id: string; source: ImportSource; path: string; content: string }[]; items: Gold[] };

const args = process.argv.slice(2);
const arg = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = arg("env") ?? process.env.MEMORY_IMPORT_ENV;
if (!envFile) throw new Error("需要 --env 指向含 PI_BASE_URL / PI_API_KEY 的 .env 文件");
const env: Record<string, string> = {};
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}
const baseUrl = env.PI_BASE_URL, apiKey = env.PI_API_KEY;
if (!baseUrl || !apiKey) throw new Error("--env 文件里缺 PI_BASE_URL 或 PI_API_KEY");
const modelId = arg("model") ?? env.MEMORY_IMPORT_MODEL ?? env.LIGHT_MODEL;
const thinkingLevel = (arg("thinking") ?? env.MEMORY_IMPORT_THINKING ?? "off") as CandidateThinkingLevel;
const runs = Number(arg("runs") ?? 1);
const dataset = JSON.parse(readFileSync(join(root, ".scratch/memory-page-import/h12/dataset.json"), "utf8")) as Dataset;

// 网页里粘贴、上传的内容没有原文件名（界面按 paste-<n>.txt 发），评测也一样，不让文件名泄露「这是自定义指令」之类的线索。
for (const [index, doc] of dataset.documents.entries()) if (doc.source === "chatgpt" || doc.source === "claude") doc.path = `paste-${index + 1}.txt`;
const split = (docId: string) => (createHash("sha256").update(docId).digest()[0] / 256 < 0.7 ? "dev" : "test");
const docById = new Map(dataset.documents.map((doc) => [doc.id, doc]));

/** 标准条目对上拆出来的候选：同一文件、同一行（列表项、提示词输出），或整个文件（Claude Code 记忆）。 */
function align(candidates: Candidate[]) {
  const pairs = new Map<string, Candidate>();
  for (const gold of dataset.items) {
    const doc = docById.get(gold.doc)!;
    const lineIndex = doc.content.split(/\r?\n/).findIndex((line) => line.includes(gold.text));
    const match = candidates.find((candidate) => candidate.path === doc.path && (candidate.locator === `${doc.path}#L${lineIndex + 1}` || candidate.locator === doc.path));
    if (match) pairs.set(gold.id, match);
  }
  return pairs;
}

const model = createMemoryImportModel({ query: async () => ({ rows: [], rowCount: 0 }) as never, baseUrl, apiKey, modelId, thinkingLevel });
const existing: ExistingMemory[] = dataset.existing.map(({ id, kind, title, text, createdAt }) => ({ id, kind, title, text, createdAt }));

type RunResult = { candidates: Candidate[]; pairs: Map<string, Candidate>; ms: number };
async function runOnce(): Promise<RunResult> {
  const startedAt = Date.now();
  const docs: ReadDoc[] = dataset.documents.map((doc) => ({ source: doc.source, path: doc.path, text: doc.content, mtime: "2026-10-01T00:00:00Z" }));
  const { candidates } = splitDocs(docs);
  await classifyCandidates(candidates, model);
  await reconcileCandidates(candidates, existing, model);
  decide(candidates);
  return { candidates, pairs: align(candidates), ms: Date.now() - startedAt };
}

function score(run: RunResult, subset: "all" | "dev" | "test", thresholds?: { defaultCheck: number }) {
  if (thresholds) decide(run.candidates, thresholds);
  const golds = dataset.items.filter((gold) => subset === "all" || split(gold.doc) === subset);
  const goldOf = new Map<Candidate, Gold>();
  for (const gold of golds) { const candidate = run.pairs.get(gold.id); if (candidate) goldOf.set(candidate, gold); }
  const inSubset = run.candidates.filter((candidate) => subset === "all" || dataset.documents.some((doc) => doc.path === candidate.path && split(doc.id) === subset));
  const aligned = golds.filter((gold) => run.pairs.has(gold.id));
  const correct = aligned.filter((gold) => run.pairs.get(gold.id)!.category === gold.gold_category);
  const checked = inSubset.filter((candidate) => candidate.checked);
  const wrongChecked = checked.filter((candidate) => { const gold = goldOf.get(candidate); return !gold || !gold.gold_default_checked || gold.gold_category !== "personal_preference"; });
  const review = inSubset.filter((candidate) => candidate.group === "conflict" || candidate.group === "uncertain");
  // 去重：按「重复对」算（标准答案里 gold_duplicate_of 不为空的条目，预测要指向同一个对象）。
  const keyOfGold = new Map([...run.pairs].map(([goldId, candidate]) => [goldId, candidate.key]));
  const target = (ref: { memoryId?: string; key?: string } | null) => ref?.memoryId ?? ref?.key ?? null;
  const goldDupTarget = (gold: Gold) => gold.gold_duplicate_of ? (gold.gold_duplicate_of.startsWith("ex-") ? gold.gold_duplicate_of : keyOfGold.get(gold.gold_duplicate_of) ?? "?") : null;
  const goldDups = aligned.filter((gold) => gold.gold_duplicate_of);
  const predDups = aligned.filter((gold) => run.pairs.get(gold.id)!.duplicateOf);
  const dupHits = goldDups.filter((gold) => target(run.pairs.get(gold.id)!.duplicateOf) === goldDupTarget(gold));
  const precision = predDups.length ? dupHits.length / predDups.length : 1, recall = goldDups.length ? dupHits.length / goldDups.length : 1;
  const goldConflicts = aligned.filter((gold) => gold.gold_conflicts_with.length);
  const conflictFound = goldConflicts.filter((gold) => {
    const candidate = run.pairs.get(gold.id)!;
    const targets = gold.gold_conflicts_with.map((id) => (id.startsWith("ex-") ? id : keyOfGold.get(id)));
    // 冲突可能记在任一方：这条指向对方，或同批的对方指向这条。
    return targets.includes(target(candidate.conflictWith) ?? "") || run.candidates.some((other) => other.conflictWith?.key === candidate.key && targets.includes(other.key));
  });
  const leaked = checked.filter((candidate) => candidate.locked || ["secret", "injection"].includes(goldOf.get(candidate)?.drop_reason ?? ""));
  return {
    subset, items: inSubset.length, goldItems: golds.length, aligned: aligned.length,
    accuracy: aligned.length ? correct.length / aligned.length : 0,
    checked: checked.length, wrongChecked: wrongChecked.length, wrongCheckedRate: checked.length ? wrongChecked.length / checked.length : 0,
    goldChecked: golds.filter((gold) => gold.gold_default_checked).length,
    checkedRecall: golds.filter((gold) => gold.gold_default_checked).length ? checked.filter((candidate) => goldOf.get(candidate)?.gold_default_checked).length / golds.filter((gold) => gold.gold_default_checked).length : 0,
    review: review.length, burden: inSubset.length ? review.length / inSubset.length : 0,
    dedupF1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, dedupPrecision: precision, dedupRecall: recall,
    conflictRecall: goldConflicts.length ? conflictFound.length / goldConflicts.length : 1, conflictsGold: goldConflicts.length,
    secretsOrInjectionChecked: leaked.length,
    errors: aligned.filter((gold) => run.pairs.get(gold.id)!.category !== gold.gold_category).map((gold) => {
      const candidate = run.pairs.get(gold.id)!;
      return { id: gold.id, gold: gold.gold_category, pred: candidate.category, confidence: candidate.confidence, alt: candidate.alternative };
    }),
    wrongCheckedIds: wrongChecked.map((candidate) => goldOf.get(candidate)?.id ?? candidate.key),
    reviewIds: review.map((candidate) => ({ id: goldOf.get(candidate)?.id ?? candidate.key, group: candidate.group, confidence: candidate.confidence ? effectiveConfidence(candidate) : null })),
    missedGold: golds.filter((gold) => !run.pairs.has(gold.id)).map((gold) => gold.id),
    rows: aligned.map((gold) => {
      const candidate = run.pairs.get(gold.id)!;
      return { id: gold.id, gold: gold.gold_category, goldChecked: gold.gold_default_checked, pred: candidate.category, confidence: candidate.confidence,
        effective: effectiveConfidence(candidate), alt: candidate.alternative, group: candidate.group, dup: target(candidate.duplicateOf), conflict: target(candidate.conflictWith) };
    }),
  };
}

const results: RunResult[] = [];
for (let index = 0; index < runs; index++) {
  const run = await runOnce();
  results.push(run);
  const all = score(run, "all");
  console.log(`run ${index + 1}: ${(run.ms / 1000).toFixed(1)}s · 拆出 ${run.candidates.length} · 对上 ${all.aligned}/${all.goldItems} · 分类 ${(all.accuracy * 100).toFixed(1)}% · 默认勾选 ${all.checked}（错 ${all.wrongChecked}）· 要本人看 ${all.review}（${(all.burden * 100).toFixed(1)}%）· 去重 F1 ${all.dedupF1.toFixed(2)} · 冲突 ${(all.conflictRecall * 100).toFixed(0)}%`);
}
const report = results.map((run) => ({
  ms: run.ms,
  all: score(run, "all"), dev: score(run, "dev"), test: score(run, "test"),
  // 阈值扫描只看开发集。
  sweep: [0.75, 0.8, 0.85, 0.9, 0.95].map((value) => ({ defaultCheck: value, ...(({ checked, wrongChecked, checkedRecall, review, burden }) => ({ checked, wrongChecked, checkedRecall, review, burden }))(score(run, "dev", { defaultCheck: value })) })),
}));
for (const run of results) decide(run.candidates);
const out = arg("out") ?? join(root, ".scratch/memory-page-import/h12/results.json");
writeFileSync(out, JSON.stringify({ model: modelId, thinkingLevel, runs, at: new Date().toISOString(), report }, null, 2));
console.log(`写到 ${out}`);
