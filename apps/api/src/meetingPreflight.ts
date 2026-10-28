import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PreflightCandidate,
  type TIssueDecisionHistory,
  type TMeetingPreflight,
  type TMeetingPreflightEntry,
  type TMeetingParticipant,
  type TPreflightProgress,
  type TPreflightEvidenceRecord,
  type TPreflightInputCoverage,
  type TPreflightCandidate,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { issueDecisionHistory } from "./issueDecisionHistory.js";
import { collectMeetingEvidence, evidenceVersions, parseGroupMaterialRef, type MeetingEvidence } from "./meetingEvidence.js";
import type { MaterialViewer } from "./objectMaterials.js";
import { personDisplayNames } from "./people.js";
import { computeStaleInputs } from "./preflightStaleness.js";
import type { CandidateAgentEvent } from "./candidateAgentRuntime.js";
import { readAnchorContext, type PreflightAnchorContext, type PreflightWorld } from "./preflightAnchors.js";
import {
  battlefieldDecisionsForPreflight,
  historyScope,
  relatedMeetingsForPreflight,
  type BattlefieldDecision,
  type PreflightRelatedMeeting,
} from "./preflightHistory.js";
import {
  PreflightProgressRecorder,
  analysisLabel,
  createAgentProgressHandler,
  inputProgressEvents,
  type ThoughtTranslator,
} from "./preflightProgress.js";
import { CEO_QUESTION_CONTAINMENT_MIN_CHARS, CEO_QUESTION_DUPLICATE_SIMILARITY } from "./promptRules.js";
import { findForbiddenPhrase } from "./promptStyle.js";
import { issueOriginFields } from "./dataOrigin.js";
import {
  appendFingerprint,
  commit,
  getMeetingRow,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type MeetingActionOutcome,
  type Query,
} from "./meetingStore.js";
import { shanghaiDate } from "./workdays.js";

const PREFLIGHT_AGENT_FAILED = "preflight_agent_failed";
const INVALID_PREFLIGHT_CANDIDATE = "invalid_preflight_candidate";
const INVALID_SOURCE_REF = "invalid_source_ref";
export const PREFLIGHT_INTERRUPTED = "preflight_interrupted";
/** 默认超时（不开思考的模型）；开了深度思考的预审 Agent 用自己的 timeoutMs。 */
const PREFLIGHT_TIMEOUT_MS = 180_000;
/** 群材料最新有效版本：与 Chat 的 list_materials/read_material 同一份数据与权限。 */
export type PreflightGroupMaterialInput = {
  sourceRef: string;
  objectType: "meeting" | "issue";
  objectTitle: string;
  fileName: string;
  format: string;
  version: number;
  updatedAt: string;
  owner: string;
  revisionSummary: string | null;
  state: "used" | "link_only" | "unreadable";
  /** 带 [p<n>] 段落标记的正文；link_only / unreadable 为 null。 */
  text: string | null;
  truncated: boolean;
  url?: string;
};

/** 群讨论成员发言：作者、时间、原话；是个人意见/提案/信息，不是组织决定。 */
export type PreflightDiscussionInput = {
  sourceRef: string;
  objectType: "meeting" | "issue";
  objectTitle: string;
  author: string;
  at: string;
  content: string;
  quote?: unknown;
  /** 导入资料标注的发言性质（提案/意见/事实核对等）。 */
  stance?: string;
};

export type PreflightAgentInput = {
  meeting: { id: string; title: string; scheduledAt: string; participants: TMeetingParticipant[] };
  /** 约会议时挑的挂点及读到的内容（长期目标、本月目标、Mission、责任单元；v5）。没挑过挂点的会为空。 */
  anchors: PreflightAnchorContext[];
  /** nature / origin 只在 AI 候选议题上出现（dataOrigin.ts），真实议题没有这两项。 */
  issues: { id: string; title: string; location: unknown; urgency: unknown; research: unknown; nature?: "ai_suggested"; origin?: string }[];
  /** 旧会前材料（meetings.materials），已去掉与群材料同名或同内容的重复项。 */
  materials: { id: string; fileName: string; mimeType: string; extractedText: string; sourceRef: string }[];
  groupMaterials: PreflightGroupMaterialInput[];
  discussions: PreflightDiscussionInput[];
  /** 每个关联议题的有效历史分层（仍有效决定 / 执行变化 / 本次待判断 / 已失效）。 */
  decisionHistory: TIssueDecisionHistory[];
  inputCoverage: TPreflightInputCoverage;
  /** 本次会议议题所在的战场与单元（找近期会议和同战场决定用）。 */
  scope: { battlefields: { id: string; name: string }[]; unitIds: string[] };
  /** 对照的近期会议：共享议题，或同一战场 / 单元（按时间倒序，已去重）。 */
  relatedMeetings: PreflightRelatedMeeting[];
  /** 同一战场 / 单元里其他议题仍有效的决定。 */
  battlefieldDecisions: BattlefieldDecision[];
};

/**
 * 预审运行时的回调：过程事件（思考、候选写作）；validate 是提交时的业务校验（档位规则、引用白名单、翻案句），
 * 返回说明时让模型按说明改好再交，不必整轮重来。
 */
export type PreflightAgentHooks = {
  onEvent?: (event: CandidateAgentEvent) => void;
  validate?: (candidate: TPreflightCandidate) => string | null;
};

export type PreflightAgent = {
  promptHash?: string;
  modelSlot?: "light" | "heavy";
  /** true：触发预审的接口只等「预审中」落库就返回，模型在后台跑（巡检 P1-5/6：加入会议 25 秒、新建会议 33 秒）。 */
  background?: boolean;
  /** 所用模型与思考强度（写进报告，运行记录用）。 */
  model?: { id: string; thinking: string };
  /** 整次预审的时限；不给时 180 秒。 */
  timeoutMs?: number;
  /** 英文推理小标题译成中文思考要点；不给时只显示中文要点。 */
  translateThought?: ThoughtTranslator;
  /** 读挂点里长期目标、本月目标内容的本体客户端（只读）；没有时挂点只有名称和天枢里的 Mission。 */
  world?: PreflightWorld;
  generate(input: PreflightAgentInput, signal?: AbortSignal, hooks?: PreflightAgentHooks): Promise<{ candidate: unknown; runId?: string }>;
};
export async function executeRunPreflight(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled" || row.preflight.status !== "pending") {
      return { error: { status: 409, code: "MEETING_PREFLIGHT_NOT_PENDING", message: "只有 pending 的 scheduled Meeting 可以运行预审" } };
    }
    const updated = await updateMeeting(client, row.id, "version = version + 1, action_fingerprints = $2::jsonb", [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await startPreflight(pool, peopleDirectory, preflightAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}
async function executeExplicitPreflight(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  expectedStatus: "failed" | "ready",
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以运行预审" } };
    if (row.preflight.status !== expectedStatus) {
      return { error: {
        status: 409,
        code: expectedStatus === "failed" ? "MEETING_PREFLIGHT_NOT_FAILED" : "MEETING_PREFLIGHT_NOT_READY",
        message: expectedStatus === "failed" ? "只有失败的预审可以显式重试" : "只有已完成的预审可以重新生成",
      } };
    }
    const updated = await updateMeeting(
      client,
      row.id,
      "version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await startPreflight(pool, peopleDirectory, preflightAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

export const executeRetryPreflight = (
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
) => executeExplicitPreflight(pool, peopleDirectory, preflightAgent, secret, scope, fingerprint, "failed");

export const executeRegeneratePreflight = (
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
) => executeExplicitPreflight(pool, peopleDirectory, preflightAgent, secret, scope, fingerprint, "ready");
type IssueSnapshotRow = { id: string; title: string; location: unknown; urgency: unknown; research: unknown; origin_ref?: unknown };

/** 候选引用的白名单：本次输入里显式出现的来源，以及每份群材料实际给出的段落数。 */
export type PreflightRefScope = {
  allowed: Set<string>; paragraphCounts: Map<string, number>;
  /** 这场会只有标题、时间、参会人和挂点名称（公司事实只是背景，不算）：只能写 thin，不凭公司事实下判断。 */
  thinOnly?: boolean;
};
export type PreflightCandidateProblem = { code: typeof INVALID_PREFLIGHT_CANDIDATE | typeof INVALID_SOURCE_REF; message: string };

/**
 * 信息不足档只给缺什么：模型常把可选的 judgment、decision 也填上占位话（实测「待补」「不适用」反复重交），
 * 这里直接去掉，不当成错误让模型重写。
 */
export function withoutThinJudgment(candidate: TPreflightCandidate): TPreflightCandidate {
  if (candidate.depth !== "thin") return candidate;
  const { judgment: _judgment, decision: _decision, ...rest } = candidate;
  return rest;
}

/** 候选里给人看的文字，逐项带字段名：命中翻案句时告诉模型改哪一处。 */
function candidateProse(candidate: TPreflightCandidate): [string, string][] {
  const prose: [string, string][] = [["decision", candidate.decision ?? ""]];
  if (candidate.judgment) prose.push(["judgment.headline", candidate.judgment.headline], ["judgment.body", candidate.judgment.body]);
  candidate.questions.forEach((item, index) => prose.push([`questions[${index}].question`, item.question], [`questions[${index}].why`, item.why]));
  candidate.decisions.forEach((item, index) => {
    prose.push([`decisions[${index}].question`, item.question], [`decisions[${index}].recommendation`, item.recommendation],
      [`decisions[${index}].changeIf`, item.changeIf], [`decisions[${index}].whyNow`, item.whyNow], [`decisions[${index}].whyCeo`, item.whyCeo]);
    item.options.forEach((option, at) => prose.push([`decisions[${index}].options[${at}]`, `${option.label}。${option.impact}`]));
  });
  candidate.gaps.forEach((gap, index) => prose.push([`gaps[${index}]`, gap]));
  prose.push(["basis", candidate.basis]);
  return prose;
}

/**
 * v5 候选的业务校验（提交时交给模型按说明改；生成后再核一次）：各档必填项、翻案句、引用白名单。合格返回 null。
 * - strategic：decision、judgment 必写，questions 至少 1 个（提示词要求二到三个）；
 * - standard：judgment 必写，questions 至少 1 个；这两档 gaps 为空，缺的事实写进 basis 或写成要聊的问题；
 * - thin：不写 judgment 和 decisions，questions 最多 2 个，gaps 写 1 到 2 句缺什么。
 * 输入只有标题、时间、参会人和挂点名称时（refs.thinOnly）只能是 thin。要拍板的事没有下限（可以为 0），只有契约上的上限。
 * thin 档顺手写的 judgment、decision 不算错，先由 withoutThinJudgment 去掉再校验。
 */
export function preflightCandidateError(candidate: TPreflightCandidate, refs: PreflightRefScope): PreflightCandidateProblem | null {
  const problem = (message: string): PreflightCandidateProblem => ({ code: INVALID_PREFLIGHT_CANDIDATE, message });
  const { depth } = candidate;
  if (refs.thinOnly && depth !== "thin") return problem("这场会除了标题、时间、参会人和挂点名称没有别的内容，公司事实不能代替会议内容：depth 只能是 thin，在 gaps 写缺什么");
  candidate = withoutThinJudgment(candidate);
  if (depth === "thin") {
    if (candidate.decisions.length) return problem("depth=thin 时 decisions 必须为空数组");
    if (candidate.questions.length > 2) return problem("depth=thin 时 questions 最多 2 个");
    if (!candidate.gaps.length) return problem("depth=thin 时 gaps 写 1 到 2 句：缺哪一项具体内容、补上之后能定什么");
  } else {
    if (!candidate.judgment) return problem(`depth=${depth} 时必须写 judgment`);
    if (!candidate.questions.length) return problem(`depth=${depth} 时 questions 至少写 1 个`);
    if (candidate.gaps.length) return problem(`depth=${depth} 时 gaps 必须为空数组，缺的事实写进 basis 或写成要聊的问题`);
    if (depth === "strategic" && !candidate.decision) return problem("depth=strategic 时必须写 decision（这场会要定的事）");
  }
  for (const [field, text] of candidateProse(candidate)) {
    const hit = findForbiddenPhrase(text);
    if (hit) return problem(`${field} 用了「${hit}」句式，改成正面直接陈述`);
  }
  const lists: [string, string[]][] = [
    ...(candidate.judgment ? [["judgment", candidate.judgment.sourceRefs] as [string, string[]]] : []),
    ...candidate.questions.map((item, index) => [`questions[${index}]`, item.sourceRefs] as [string, string[]]),
    ...candidate.decisions.map((item, index) => [`decisions[${index}]`, item.sourceRefs] as [string, string[]]),
  ];
  for (const [field, list] of lists) {
    const checked = normalizeSourceRefs(list, refs.allowed, refs.paragraphCounts);
    if (checked.bad) return { code: INVALID_SOURCE_REF, message: `${field}.sourceRefs 里的 ${checked.bad} 不在输入里，只能用输入里显式出现的引用` };
  }
  return null;
}

const normalizeQuestion = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function bigrams(text: string): Map<string, number> {
  const chars = Array.from(text);
  const grams = new Map<string, number>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index] + chars[index + 1];
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/**
 * 两条 CEO 级问题是否是同一疑问：去标点后相同、较短一条（≥8 字）被包含，或字符二元组 Dice 相似度达到阈值。
 * 只比正文（问题本身）；标题常是“追问一/追问二”这类序号，不参与比较。
 */
export function isDuplicateQuestion(a: string, b: string): boolean {
  const x = normalizeQuestion(a);
  const y = normalizeQuestion(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (Array.from(short).length >= CEO_QUESTION_CONTAINMENT_MIN_CHARS && long.includes(short)) return true;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const [gram, n] of gx) { shared += Math.min(n, gy.get(gram) ?? 0); total += n; }
  for (const n of gy.values()) total += n;
  return total > 0 && (2 * shared) / total >= CEO_QUESTION_DUPLICATE_SIMILARITY;
}

/** 同一个问题只出现一次：要聊的问题与要拍板的事说的是同一件事时留要拍板的事，要聊的问题之间留先出现的；来源并进保留项（最多 6 条）。 */
export function dropDuplicateQuestions(candidate: TPreflightCandidate): TPreflightCandidate {
  const decisions = candidate.decisions.map((item) => ({ ...item, sourceRefs: [...item.sourceRefs] }));
  const questions: TPreflightCandidate["questions"] = [];
  for (const item of candidate.questions) {
    const twin = decisions.find((decision) => isDuplicateQuestion(decision.question, item.question))
      ?? questions.find((kept) => isDuplicateQuestion(kept.question, item.question));
    if (twin) {
      twin.sourceRefs = [...new Set([...twin.sourceRefs, ...item.sourceRefs])].slice(0, 6);
      continue;
    }
    questions.push({ ...item, sourceRefs: [...item.sourceRefs] });
  }
  return { ...candidate, questions, decisions };
}

const sentence = (text: string) => (/[。！？.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}。`);

/**
 * v5 候选写成会议预审条目（id 按顺序 entry-1…，每条可核对、可请人补材料）：
 * 核心判断 core_judgment（标题是一句话结论）；要聊的问题 discussion_question（正文是为什么要聊）；
 * 要拍板的事 meeting_question（正文是推荐与改判条件，ceoDecision 带决策时机、为什么需要一号位和选项）。
 */
export function preflightEntries(candidate: TPreflightCandidate, refs: PreflightRefScope): TMeetingPreflightEntry[] {
  const normalized = (list: string[]) => normalizeSourceRefs(list, refs.allowed, refs.paragraphCounts).refs;
  const entries: Omit<TMeetingPreflightEntry, "id">[] = [
    ...(candidate.judgment ? [{ kind: "core_judgment" as const, title: candidate.judgment.headline, body: candidate.judgment.body,
      sourceRefs: normalized(candidate.judgment.sourceRefs) }] : []),
    ...candidate.questions.map((item) => ({ kind: "discussion_question" as const, title: item.question, body: item.why, sourceRefs: normalized(item.sourceRefs) })),
    ...candidate.decisions.map((item) => ({ kind: "meeting_question" as const, title: item.question,
      body: `${sentence(item.recommendation)}${sentence(item.changeIf)}`, sourceRefs: normalized(item.sourceRefs),
      ceoDecision: { whyNow: item.whyNow, whyCeo: item.whyCeo, options: item.options } })),
  ];
  return entries.map((entry, index) => ({ id: `entry-${index + 1}`, ...entry }));
}

/**
 * sourceRef 白名单校验与规范化：未知来源返回 bad；群材料段落锚点超出本次输入实际给出的段落时去掉锚点，
 * 保留可核对的版本引用，不因为锚点数字整份预审失败。
 */
function normalizeSourceRefs(refs: string[], allowed: Set<string>, paragraphCounts: Map<string, number>): { refs: string[]; bad?: string } {
  const out: string[] = [];
  for (const ref of refs) {
    if (allowed.has(ref)) { out.push(ref); continue; }
    const parsed = parseGroupMaterialRef(ref);
    const base = parsed ? `material:${parsed.id}@v${parsed.version}` : "";
    if (!parsed || !allowed.has(base)) return { refs, bad: ref };
    const paragraph = parsed.paragraph;
    out.push(paragraph !== null && paragraph >= 1 && paragraph <= (paragraphCounts.get(base) ?? 0) ? `${base}#p${paragraph}` : base);
  }
  return { refs: [...new Set(out)] };
}

/** 群材料给模型的形状：链接只有标题与地址，不可读材料只给状态，避免模型以为读过。 */
function groupMaterialInputs(evidence: MeetingEvidence): PreflightGroupMaterialInput[] {
  return evidence.materials.map((material) => ({
    sourceRef: material.sourceRef,
    objectType: material.objectType,
    objectTitle: material.objectTitle,
    fileName: material.fileName,
    format: material.format,
    version: material.version,
    updatedAt: material.updatedAt,
    owner: material.owner.displayName,
    revisionSummary: material.revisionSummary,
    state: material.state,
    text: material.text,
    truncated: material.truncated,
    ...(material.url ? { url: material.url } : {}),
  }));
}

/**
 * 触发一次预审。agent.background=true 时只等「预审中」写进库就返回，生成在后台继续，页面按 running 状态显示「预审中」；
 * 否则（测试替身）等整次预审跑完再返回，行为与以前一致。
 */
export async function startPreflight(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  meetingId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!preflightAgent.background) return runPreflight(pool, peopleDirectory, preflightAgent, meetingId, options);
  let started!: () => void;
  const marked = new Promise<void>((resolve) => { started = resolve; });
  void runPreflight(pool, peopleDirectory, preflightAgent, meetingId, { ...options, onRunning: () => started() })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: "preflight.background_failed", meetingId, message: (error as Error)?.message }));
    })
    .finally(() => started());
  await marked;
}

/** 一次预审最多跑几轮：模型出错、超时或交不出合格候选时自动再跑一轮，两轮都没成才显示失败、等人点重试。 */
export const PREFLIGHT_ATTEMPTS = 2;
/**
 * 这个进程里每场会正在跑的那一次预审：同一场会又开始一次（材料又变了、有人点了重新预审）时，旧的一次立即停下，
 * 不再白跑模型（它的结果本来也会因为 pendingSince 不是自己而写不进库）。
 */
const activeRuns = new Map<string, AbortController>();

/**
 * 运行一次会前预审（v5）：读输入（含挂点内容）→ 模型生成 → 校验 → 写成核心判断、要聊的问题、要拍板的事。
 * 提交时的校验不合格先让模型按说明改；整轮失败自动重跑一轮（PREFLIGHT_ATTEMPTS），再失败才可见。过程逐步写进 preflight.progress。
 */
export async function runPreflight(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  meetingId: string,
  { timeoutMs = preflightAgent.timeoutMs ?? PREFLIGHT_TIMEOUT_MS, onRunning }: { timeoutMs?: number; onRunning?: () => void } = {},
): Promise<void> {
  const q = pool.query.bind(pool);
  const meeting = await getMeetingRow(q, meetingId);
  if (!meeting || meeting.status !== "scheduled") return;
  const startedAt = new Date().toISOString();
  const { progress: _previousProgress, ...previous } = meeting.preflight;
  const initialProgress: TPreflightProgress = { startedAt, updatedAt: startedAt, steps: [
    { key: "collect", kind: "input", label: "正在读取挂点、会议材料与历史决定", state: "active", at: startedAt, updatedAt: startedAt },
  ] };
  const running: TMeetingPreflight = { ...previous, status: "running", pendingSince: startedAt, error: null, progress: initialProgress };
  await q("UPDATE meetings SET preflight = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1", [meetingId, JSON.stringify(running)]);
  onRunning?.();
  const run = new AbortController();
  activeRuns.get(meetingId)?.abort(new Error("同一场会开始了新的一次预审"));
  activeRuns.set(meetingId, run);
  // 后台跑时可能又被触发了一次：只有仍是本次「预审中」时才写结果，旧的一次不覆盖新的一次。
  const mine = "preflight->>'pendingSince' = $3";

  // 过程写库：只写本次运行中的这一份，不加 version（不打断预审期间的勾选与草稿）。
  const recorder = new PreflightProgressRecorder(async (progress) => {
    await q(
      `UPDATE meetings SET preflight = jsonb_set(preflight, '{progress}', $2::jsonb)
        WHERE id = $1 AND ${mine} AND preflight->>'status' = 'running'`,
      [meetingId, JSON.stringify(progress), running.pendingSince],
    );
  });
  recorder.step({ key: "collect", kind: "input", label: "正在读取挂点、会议材料与历史决定", state: "active" });
  const model = preflightAgent.model;

  // 失败保留 last-good entries 供页面展示，但旧条目即将被重建，核对与编辑一并失效
  const fail = async (code: string, message: string) => {
    recorder.step({ key: "failed", kind: "check", label: "预审没有完成", detail: message });
    const progress = await recorder.finish();
    await q(
      `UPDATE meetings
          SET preflight = $2::jsonb,
              draft = jsonb_set(jsonb_set(draft, '{checkedEntryIds}', '[]'::jsonb), '{editsByEntryId}', '{}'::jsonb),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND ${mine}`,
      [meetingId, JSON.stringify({ ...running, status: "failed", progress, error: { code, message, at: new Date().toISOString() } }), running.pendingSince],
    );
  };

  try {
    const issueResult = await q("SELECT id, title, location, urgency, research, origin_ref FROM issues WHERE id = ANY($1::uuid[])", [meeting.issue_ids]);
    const issues = issueResult.rows as IssueSnapshotRow[];
    // 对照的历史：共享议题的会，加上同一战场 / 单元的近期会议与已确认决定（去重）。
    const scope = historyScope(issues.map((issue) => issue.location));
    const battlefieldRows = scope.battlefieldIds.length
      ? (await q("SELECT id, name FROM battlefield_config WHERE id = ANY($1::text[]) ORDER BY id", [scope.battlefieldIds])).rows as { id: string; name: string }[]
      : [];
    const foundMeetings = await relatedMeetingsForPreflight(q, meeting, scope);
    const battlefieldDecisions = await battlefieldDecisionsForPreflight(q, meeting.issue_ids, scope);
    // 群材料最新版、群讨论与旧会前材料：按会议 CEO 参会人的原生权限读取（与 Chat 同一份）。
    const names = personDisplayNames(peopleDirectory);
    const viewer: MaterialViewer = { personId: meeting.ceo_participant_id, role: "ceo",
      displayName: names.get(meeting.ceo_participant_id) ?? meeting.ceo_participant_id };
    const evidence = await collectMeetingEvidence(q, meeting.id, viewer, { names });
    if (!evidence) throw new Error("Meeting 不存在，无法读取预审输入");
    // 约会议时挑的挂点：长期目标、本月目标读本体，Mission、责任单元读天枢（读不到只给名称）。
    const anchors = await readAnchorContext(q, preflightAgent.world, meeting.world_anchors ?? [],
      { period: shanghaiDate(meeting.scheduled_at).slice(0, 7), names });
    // 每个关联议题的有效历史分层：跨所有相关会议检索，不只取最近一场。
    const ceoName = meeting.participants.find((person) => person.personId === meeting.ceo_participant_id)?.displayName ?? viewer.displayName;
    const decisionHistory: TIssueDecisionHistory[] = [];
    for (const issueId of meeting.issue_ids) {
      const history = await issueDecisionHistory(q, issueId, viewer, { names, ceo: { personId: meeting.ceo_participant_id, displayName: ceoName } });
      if (history) decisionHistory.push(history);
    }
    // 会后确认过、已经写成议题决定的条目由议题历史分层负责（含之后的撤回、替代），近期会议里不再重复列为约束。
    const coveredItems = new Set(decisionHistory.flatMap((history) => [...history.effective, ...history.inactive])
      .flatMap((entry) => entry.source.kind === "meeting-item" && entry.source.outcomeItemId ? [`outcome:${entry.source.meetingId}#${entry.source.outcomeItemId}`] : []));
    const relatedMeetings = foundMeetings.map((related) => ({
      ...related, confirmedDecisions: related.confirmedDecisions.filter((decision) => !coveredItems.has(decision.ref)),
    }));

    const legacyUsed = evidence.legacyMaterials.filter((material) => material.state === "used");
    const readableGroup = evidence.materials.filter((material) => material.state === "used" && material.text);
    const hasResearch = issues.some((issue) => Boolean(issue.research && (issue.research as { doc?: unknown }).doc));
    const inputCoverage: TPreflightInputCoverage = {
      background: issues.length > 0 || anchors.some((anchor) => anchor.readState === "ok") ? "available" : "missing",
      purpose: "derived",
      sourceMaterial: hasResearch || legacyUsed.length > 0 || readableGroup.length > 0 ? "available" : "missing",
      relatedMeeting: relatedMeetings.length ? "available" : "missing",
      groupMaterials: readableGroup.length > 0 ? "available" : "missing",
      discussions: evidence.discussions.length > 0 ? "available" : "missing",
      decisionHistory: decisionHistory.some((history) => history.effective.length || history.inactive.length || history.pending.some((item) => item.kind === "outcome_candidate"))
        || battlefieldDecisions.length > 0 || relatedMeetings.some((related) => related.confirmedDecisions.length > 0)
        ? "available" : "missing",
    };

    // CEO 已提供会前材料（旧会前材料或会议群里的可读材料）时，预审源材料以新材料为准：Issue 只保留标题等基本事实，
    // 不再注入旧 ResearchDoc，避免预审锚定过期研究结论。议题群里的材料是背景资料，不触发这条规则。
    const useUploadedMaterials = legacyUsed.length > 0 || readableGroup.some((material) => material.objectType === "meeting");
    const allowedSourceRefs = new Set<string>([
      `meeting:${meeting.id}`,
      ...issues.map((issue) => `issue:${issue.id}`),
    ]);
    for (const material of legacyUsed) allowedSourceRefs.add(material.sourceRef);
    const paragraphCounts = new Map<string, number>();
    for (const material of evidence.materials) {
      if (material.state === "unreadable") continue;
      allowedSourceRefs.add(material.sourceRef);
      paragraphCounts.set(material.sourceRef, material.paragraphCount);
    }
    for (const message of evidence.discussions) allowedSourceRefs.add(message.sourceRef);
    for (const history of decisionHistory) {
      for (const entry of [...history.effective, ...history.inactive]) for (const ref of [entry.ref, ...entry.sourceRefs]) allowedSourceRefs.add(ref);
      for (const change of history.changes) allowedSourceRefs.add(change.ref);
      for (const item of history.pending) allowedSourceRefs.add(item.ref);
    }
    for (const related of relatedMeetings) for (const ref of related.sourceRefs) allowedSourceRefs.add(ref);
    for (const decision of battlefieldDecisions) allowedSourceRefs.add(decision.ref);
    for (const issue of issues) {
      if (!useUploadedMaterials && issue.research && (issue.research as { doc?: unknown }).doc) allowedSourceRefs.add(`research:${issue.id}`);
    }
    // 只有标题、时间、参会人和挂点名称：没有议题、可读材料、群讨论、读到内容的挂点和可对照的历史，只写缺什么。
    const thinOnly = !issues.length && !readableGroup.length && !legacyUsed.length && !evidence.discussions.length
      && !anchors.some((anchor) => anchor.readState === "ok") && !relatedMeetings.length && !battlefieldDecisions.length;
    const refs: PreflightRefScope = { allowed: allowedSourceRefs, paragraphCounts, thinOnly };

    const evidenceRecord: TPreflightEvidenceRecord = {
      collectedAt: evidence.collectedAt,
      viewerId: viewer.personId,
      materials: evidence.materials.map((material) => ({ id: material.id, objectType: material.objectType, objectId: material.objectId,
        fileName: material.fileName, format: material.format, version: material.version, state: material.state,
        truncated: material.truncated, sourceRef: material.sourceRef })),
      legacyMaterials: evidence.legacyMaterials.map((material) => ({ id: material.id, fileName: material.fileName, state: material.state,
        ...(material.duplicateOf ? { duplicateOf: material.duplicateOf } : {}) })),
      discussionMessageIds: evidence.discussions.map((message) => message.id),
      discussionMaxId: evidence.discussionMaxId,
      decisionRefs: [
        ...decisionHistory.flatMap((history) => history.effective.map((entry) => entry.ref)),
        ...battlefieldDecisions.map((decision) => decision.ref),
        ...relatedMeetings.flatMap((related) => related.confirmedDecisions.map((decision) => decision.ref)),
      ],
      inactiveDecisionRefs: decisionHistory.flatMap((history) => history.inactive.map((entry) => entry.ref)),
      skippedObjects: evidence.skippedObjects,
      relatedMeetings: relatedMeetings.map((related) => ({ id: related.id, title: related.title, scheduledAt: related.scheduledAt,
        matchedBy: related.matchedBy, confirmedDecisions: related.confirmedDecisions.length, pendingDecisions: related.pendingDecisions.length })),
    };

    const input: PreflightAgentInput = {
      meeting: { id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduled_at.toISOString(), participants: meeting.participants },
      anchors,
      // AI 候选议题带来源性质：预审报告引用它时不写来源标注，但不当作已发生的事实。
      issues: issues.map((issue) => ({ id: issue.id, title: issue.title, location: issue.location, urgency: issue.urgency, research: useUploadedMaterials ? null : issue.research,
        ...issueOriginFields(issue.origin_ref) })),
      materials: legacyUsed.map((material) => ({ id: material.id, fileName: material.fileName, mimeType: material.mimeType, extractedText: material.extractedText, sourceRef: material.sourceRef })),
      groupMaterials: groupMaterialInputs(evidence),
      discussions: evidence.discussions.map((message) => ({ sourceRef: message.sourceRef, objectType: message.objectType, objectTitle: message.objectTitle,
        author: message.author.displayName, at: message.at, content: message.content, ...(message.quote ? { quote: message.quote } : {}),
        ...(message.stance ? { stance: message.stance } : {}) })),
      decisionHistory,
      inputCoverage,
      scope: { battlefields: scope.battlefieldIds.map((id) => ({ id, name: battlefieldRows.find((row) => row.id === id)?.name ?? id })), unitIds: scope.unitIds },
      relatedMeetings,
      battlefieldDecisions,
    };

    // 输入阶段的过程：读到了哪些挂点、每份材料读了几段、找到了哪几场同战场的会。
    for (const event of inputProgressEvents(input, paragraphCounts)) recorder.step(event);
    recorder.done("collect", "已读取会前资料");
    recorder.step({ key: "analysis", kind: "thinking", label: analysisLabel(input), state: "active" });
    await recorder.flush();

    // 阶段性对照结论里的决定引用 → 原文（过程里写「哪一条」）。
    const refLabels = new Map<string, string>([
      ...relatedMeetings.flatMap((related) => [...related.confirmedDecisions, ...related.pendingDecisions].map((decision) => [decision.ref, decision.text] as [string, string])),
      ...battlefieldDecisions.map((decision) => [decision.ref, decision.text] as [string, string]),
      ...decisionHistory.flatMap((history) => history.effective.map((entry) => [entry.ref, entry.text] as [string, string])),
    ]);
    /** 跑一轮：超时保护（开了深度思考的预审时限更长，见 PreflightAgent.timeoutMs）；被新的一次取代时随之停下。 */
    const attempt = async (): Promise<{ candidate: TPreflightCandidate; runId?: string } | { error: { code: string; message: string } }> => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error(`Preflight exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
      const signal = AbortSignal.any([run.signal, timeout.signal]);
      const onEvent = createAgentProgressHandler(recorder, { translate: preflightAgent.translateThought, signal, refLabels });
      let generated: { candidate: unknown; runId?: string };
      try {
        generated = await preflightAgent.generate(input, signal, { onEvent, validate: (candidate) => preflightCandidateError(candidate, refs)?.message ?? null });
      } catch (error) {
        return { error: { code: PREFLIGHT_AGENT_FAILED, message: (error as Error).message || "Preflight Agent 失败" } };
      } finally {
        clearTimeout(timer);
      }
      if (!Value.Check(PreflightCandidate, generated.candidate)) return { error: { code: INVALID_PREFLIGHT_CANDIDATE, message: "Preflight candidate 不符合严格 schema" } };
      const candidate = withoutThinJudgment(generated.candidate);
      const problem = preflightCandidateError(candidate, refs);
      return problem ? { error: problem } : { candidate, runId: generated.runId };
    };

    let failure = { code: PREFLIGHT_AGENT_FAILED, message: "Preflight Agent 失败" };
    for (let round = 1; round <= PREFLIGHT_ATTEMPTS; round += 1) {
      if (round > 1) {
        recorder.step({ key: "retry", kind: "check", label: "第一轮没有完成，正在自动重新预审", detail: failure.message });
        recorder.restart({ key: "analysis", kind: "thinking", label: analysisLabel(input), state: "active" });
      }
      const outcome = await attempt();
      // 被同一场会更新的一次预审取代：那一次负责写结果，这一次什么都不写。
      if (run.signal.aborted) return;
      if ("error" in outcome) {
        failure = outcome.error;
        continue;
      }
      recorder.done("analysis", analysisLabel(input, true));
      recorder.done("compose", "已写出预审结论");
      recorder.step({ key: "check", kind: "check", label: "正在核对引用和结构", state: "active" });
      // 同一个问题只出现一次（确定性合并，来源并入保留项），再写成可核对的条目。
      const candidate = dropDuplicateQuestions(outcome.candidate);
      const entries = preflightEntries(candidate, refs);
      // 生成期间材料或讨论变了：报告照常保存，但如实标记“生成时已不是最新资料”，不冒充最新报告。
      const after = await collectMeetingEvidence(q, meeting.id, viewer, { names, withContent: false, discussionSince: evidence.discussionMaxId });
      const inputsChangedDuringRun = !after || computeStaleInputs(evidenceRecord, evidenceVersions(after)) !== null;
      recorder.done("check", "已核对引用和结构");
      const progress = await recorder.finish();
      // entries 整体重建：指向旧表述的核对与编辑一并失效，read/carried/note 保留
      await q(
        `UPDATE meetings
            SET preflight = $2::jsonb,
                draft = jsonb_set(jsonb_set(draft, '{checkedEntryIds}', '[]'::jsonb), '{editsByEntryId}', '{}'::jsonb),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND ${mine}`,
        [meetingId, JSON.stringify({
          status: "ready",
          pendingSince: running.pendingSince,
          runId: outcome.runId ?? randomUUID(),
          entries,
          basis: candidate.basis,
          // 一句话：有核心判断时是它的结论，信息不足时是缺什么。
          brief: candidate.judgment?.headline ?? candidate.gaps.map(sentence).join(""),
          depth: candidate.depth,
          ...(candidate.decision ? { decision: candidate.decision } : {}),
          inputCoverage: { ...inputCoverage, evidence: evidenceRecord },
          progress,
          ...(model ? { model } : {}),
          error: null,
          generatedAt: new Date().toISOString(),
          ...(inputsChangedDuringRun ? { inputsChangedDuringRun: true } : {}),
        }), running.pendingSince],
      );
      return;
    }
    await fail(failure.code, failure.message);
  } catch (err) {
    if (run.signal.aborted) return;
    await fail(PREFLIGHT_AGENT_FAILED, (err as Error).message || "Preflight Agent 失败");
  } finally {
    if (activeRuns.get(meetingId) === run) activeRuns.delete(meetingId);
  }
}
/** 待整理的妙记整理成的会（已开完，不跑预审）：启动恢复和补跑都不碰。 */
const NOT_MINUTE_MEETING = "origin_ref->>'type' IS DISTINCT FROM 'feishu_minute'";

/** 启动恢复：进程崩溃留下的 pending/running 预审标为可见失败，等待显式重试。 */
export async function recoverInterruptedPreflight(
  q: Query,
  { now = () => new Date(), staleAfterMs = 15 * 60 * 1000 }: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<number> {
  const result = await q(
    `UPDATE meetings
        SET preflight = jsonb_set(
              jsonb_set(preflight, '{status}', '"failed"'),
              '{error}',
              jsonb_build_object('code', $2::text, 'message', '会前预审还没完成，可以重新预审。', 'at', now())
            ),
            version = version + 1,
            updated_at = now()
      WHERE status = 'scheduled' AND ${NOT_MINUTE_MEETING}
        AND preflight->>'status' IN ('pending', 'running')
        AND (preflight->>'pendingSince')::timestamptz < $1::timestamptz`,
    [new Date(now().getTime() - staleAfterMs), PREFLIGHT_INTERRUPTED],
  );
  return result.rowCount ?? 0;
}

/**
 * 启动后补跑（巡检 P1-17）：还没开的会里，预审从没跑过（pending，例如新场次导入的会）或被重启打断的，按顺序在后台重跑一次。
 * 只在真实 Agent（background=true）下由 app 调用；一场失败不影响下一场，失败照常显示为可重试。
 */
export async function resumePreflights(pool: Pool, peopleDirectory: PeopleDirectory, preflightAgent: PreflightAgent): Promise<number> {
  const rows = (await pool.query<{ id: string }>(
    `SELECT id FROM meetings
      WHERE status = 'scheduled' AND ${NOT_MINUTE_MEETING}
        AND (preflight->>'status' = 'pending' OR (preflight->>'status' = 'failed' AND preflight->'error'->>'code' = $1))
      ORDER BY scheduled_at, id`, [PREFLIGHT_INTERRUPTED])).rows;
  for (const row of rows) await runPreflight(pool, peopleDirectory, preflightAgent, row.id).catch(() => undefined);
  return rows.length;
}
