// 生成 10 月 Mission Card 讨论候选（占位草稿）：以 SSOT 里 9 月的 5 张个人卡为底，逐字搬运，不编新内容。
// 用法：node .scratch/onboarding/tools/gen-2026-10-candidates.mjs [SSOT 数据文件路径]
// 输出：seed/placeholders/2026-10-mission-cards.battlefield-01.json
// 规则见 .scratch/onboarding/design-04-mission-cards.md §7。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ssotPath = resolve(process.argv[2] ?? "C:/Users/10021/Desktop/clark/clark-main/docs/product/tianshu-ssot.data.json");
const outPath = resolve("seed/placeholders/2026-10-mission-cards.battlefield-01.json");
const raw = readFileSync(ssotPath);
const data = JSON.parse(raw.toString("utf8"));

// 9 月个人任务 → 9 月 MVP Mission 编号与能力域编号（依据 .scratch/ceo-warmap-mvp/issues/28-mission-entity-pages-import.md 的 21 条对照表）
const TASKS = {
  "renhao-202609-a": { september: "LHR-A", capabilityCode: "04" },
  "renhao-202609-b": { september: "LHR-B", capabilityCode: "05" },
  "renhao-202609-c": { september: "LHR-C", capabilityCode: "05" },
  "sun-202609-1": { september: "04-1", capabilityCode: "04" },
  "sun-202609-2": { september: "04-2", capabilityCode: "04" },
  "bai-202609-1": { september: "03-1", capabilityCode: "03" },
  "bai-202609-2": { september: "03-2", capabilityCode: "03" },
  "bai-202609-3": { september: "03-3", capabilityCode: "03" },
  "bai-202609-4": { september: "03-4", capabilityCode: "03" },
  "xinan-202609-1": { september: "PA-1", capabilityCode: "04" },
  "xinan-202609-2": { september: "PA-2", capabilityCode: "04" },
  "siyi-202609-1": {
    september: "05-1",
    capabilityCode: "05",
    note: "9 月 MVP 里这条的标题是「Clark Ontology & Memory v0.1」，与 SSOT 快照（本条）不同；以 SSOT 快照为底。",
  },
};

// 飞书文档 id（知识库链接背后的 docx id 以 ticket 28 读取结果为准）
const DOCUMENT_IDS = {
  "liu-renhao": "UvSrdWhPzoGGtCxE47fcHAPlnic",
  "bai-tiantian": "PxWNdgTPFo2Z4oxpWYrcy9AEndf",
  "chen-xinan": "SsVbduAu7ocyFpxjF4uc6DkGnWg",
  "yu-siyi": "IY0ndAzK2okR2yx09pLcyh8KnDf",
  "sun-mingze": "YiR7dyjYwoBa8ixFeRycaSPKnQU",
};

// 卡的先后与身份：按所负责战役的编号，不负责战役的放最后（SSOT DRI-05、概念 round.ts:142-151）
const CARD_ORDER = [
  { ownerId: "bai-tiantian", roleLabel: "01-1 战役 DRI" },
  { ownerId: "liu-renhao", roleLabel: "01-2 战役 DRI" },
  { ownerId: "sun-mingze", roleLabel: "01-3 战役 DRI" },
  { ownerId: "chen-xinan", roleLabel: "01-4 战役 DRI" },
  { ownerId: "yu-siyi", roleLabel: "参与 DRI" },
];

const LIMITS = { code: 40, title: 200, text: 4000, lineItems: 30, lineLength: 500 };
const LEADING_DATE = /^\d{1,2}\/\d{1,2}(\s*[–-]\s*\d{1,2}\/\d{1,2})?\s*/;

const monthDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${Number(m[2])}/${Number(m[3])}` : null;
};

function milestone(item) {
  const label = String(item.label ?? "").replace(LEADING_DATE, "").trim();
  const leading = String(item.label ?? "").match(LEADING_DATE)?.[0]?.trim();
  const planned = leading || monthDay(item.date);
  return planned ? `待定 · ${label}（9 月计划 ${planned}）` : `待定 · ${label}`;
}

function boundaries(boundary) {
  if (typeof boundary === "string") return boundary;
  const parts = [];
  if (boundary?.include?.length) parts.push(`包含：${boundary.include.join("；")}`);
  if (boundary?.exclude?.length) parts.push(`不包含：${boundary.exclude.join("；")}`);
  return parts.join("\n");
}

const lines = (value) => (Array.isArray(value) ? value.map(String) : String(value ?? "").split("\n")).map((s) => s.trim()).filter(Boolean);

function check(code, field, value) {
  if (typeof value === "string") {
    const max = field === "title" ? LIMITS.title : LIMITS.text;
    if (value.length > max) throw new Error(`${code}.${field} 超长：${value.length} > ${max}`);
  } else if (Array.isArray(value)) {
    if (value.length > LIMITS.lineItems) throw new Error(`${code}.${field} 行数 ${value.length} > ${LIMITS.lineItems}`);
    for (const line of value) if (line.length > LIMITS.lineLength) throw new Error(`${code}.${field} 单行超长：${line.length}`);
  }
}

const byOwner = new Map(data.personalCards.map((card) => [card.ownerId, card]));
const cards = CARD_ORDER.map(({ ownerId, roleLabel }, sortOrder) => {
  const source = byOwner.get(ownerId);
  if (!source) throw new Error(`SSOT 里没有 ${ownerId} 的个人卡`);
  const missions = source.expectedOutcomes.map((task) => {
    const mapping = TASKS[task.id];
    if (!mapping) throw new Error(`没有 ${task.id} 的能力域映射`);
    if (task.battlefieldId !== "01") throw new Error(`${task.id} 不在战场 01（${task.battlefieldId}）`);
    const code = task.id.replace("-202609-", "-202610-");
    if (code.length > LIMITS.code) throw new Error(`${code} 编号超长`);
    const mission = {
      code,
      carriedFrom: { ssotTaskId: task.id, septemberMissionCode: mapping.september, ...(mapping.note ? { note: mapping.note } : {}) },
      capabilityCode: mapping.capabilityCode,
      title: task.title,
      why: task.why ?? "",
      outcome: task.outcome ?? "",
      successEvidence: lines((task.successEvidence ?? []).map((e) => e.text)),
      boundaries: boundaries(task.boundary),
      keyPath: task.keyPath ?? "",
      milestones: (task.milestones ?? []).map(milestone),
      resources: task.resources ?? "",
      dependencies: lines(task.dependencies).join("\n"),
      humanAgentSplit: task.humanAgentSplit ?? "",
      risk: task.risk ?? "",
      retrospect: task.retrospect ?? "",
      source: { url: task.source.url, documentId: DOCUMENT_IDS[ownerId], revision: task.source.revision, fetchedOn: task.source.fetchedOn },
    };
    for (const [field, value] of Object.entries(mission)) check(code, field, value);
    return mission;
  });
  return { ownerId, sortOrder, roleLabel, sourceCardId: source.id, missions };
});

const output = {
  schema: "mission-card-drafts.v1",
  period: "2026-10",
  battlefieldCode: "01",
  origin: "placeholder",
  placeholderNote: "讨论候选（占位）· Agent 起草未接入，由 9 月个人卡生成，待核对",
  generatedBy: "Claude（.scratch/onboarding/tools/gen-2026-10-candidates.mjs）",
  source: {
    file: "clark-main/docs/product/tianshu-ssot.data.json",
    version: data.version,
    period: data.period,
    sha256: createHash("sha256").update(raw).digest("hex"),
  },
  rules: [
    "内容逐字取自 SSOT 的 9 月个人卡，不编新的目标、进度、资源或同意。",
    "里程碑日期写「待定」，括号里的是 9 月原计划的日期，只作参考，不平移到 10 月；正式确认前要给出 10 月的关键时间，或写明为什么本月不需要。",
    "只挂战场 01：SSOT 里这 12 项都只属于 01，跨战场个人卡（GAP-01）还没定规则。",
    "其他人和其他战场没有 9 月个人卡资料，不补造空卡。",
    "不复制个人卡原件正文（ADR-0019 §6）。",
  ],
  cards,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
const count = cards.reduce((n, c) => n + c.missions.length, 0);
console.log(`写入 ${outPath}：${cards.length} 张卡、${count} 项个人任务；源 sha256=${output.source.sha256}`);
