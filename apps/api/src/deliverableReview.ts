import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { Type, type Static } from "@sinclair/typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TBuddyPersonality, TCriterionVerdict } from "@warmap/contracts";
import { readBuddy } from "./buddy.js";
import { noteTone } from "./buddyPersona.js";
import type { ArticleFetcher } from "./articleText.js";
import { runCandidateAgent, type CandidateThinkingLevel } from "./candidateAgentRuntime.js";
import type { Query } from "./meetingStore.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * 交付物评审（spec 5.4）：新版本在后台按 Task 的验收标准逐条评，交付后伙伴写版本说明。
 * 队列照 missionCardReviewQueue.ts：进程内 Map，启动时和每分钟 recover；running 超过 10 分钟重排；单次 5 分钟超时。
 */

export const DELIVERABLE_REVIEW_PROMPT = `# 角色

你是天枢的交付物评审。对照一个 Task 的验收标准，评本人交来的这一版交付物，写一份评审报告。只按这一版里的证据判，不替人猜。

# 输入

一个 JSON：task 是 Task 的名字和完成定义；basis 说明按哪套标准评（acceptance 是本体验收标准，definition 是没有验收标准时用的完成定义）；criteria 是要逐条对照的标准，编号从 1 起，有约定的条带 proof（约定好用什么证明）；exclusions 有时出现，是约定里这次不包括的事；version 是这一版：statement 是本人附的一句话或现状说明，items 是能读到的材料（名字、类型、文字），图片随消息附上；unreadable 是读不到的材料和原因；previous 是上一版每一条的判定和理由，第一版没有；otherTasks 是本人这个月别的 Task 的名字，有时没有；dissent 有时出现，是本人对某一条的异议，这时 current 是这一版原来的报告。

# 先看对不对得上

- 先看这一版的材料是不是在做这个 Task。材料明显讲的是另一件事（别的 Task、别的项目）时，mismatch 写一句话：otherTasks 里有对得上的，就写「这份材料像是『X』的交付物」；没有就写它讲的是什么，例如「这份材料讲的是招聘流程，和这个 Task 对不上」。不超过 60 字。
- 对得上、只是不完整，或者读不到材料、判断不了，都写 null。
- 对不上时各条照常判。

# 怎么判

- 只按约定判，不加新要求：某一条带 proof 时，就看这一版里有没有 proof 说的那种证明，有就判 met，不再追加 proof 以外的条件；没带 proof 的条按标准原文判。exclusions 里的事不算缺口。
- 每一条三档：met 达到，partial 部分达到，unmet 未达到。
- 证据只认这一版的材料。没有证据就判 unmet，写清缺的是什么证据，例如「缺一段新人 3 分钟内走完上手的录屏」。
- 本人的现状说明是本人的陈述：有材料印证的才算证据；只有陈述、没有材料印证的，最多判 partial。
- 读不到的材料不能当证据；某一条要靠它时，在 fix 里写「这份材料打不开，请导出后上传」。
- reason：一句话说判定的理由，不超过 60 字。
- evidence：引用的证据位置，写哪份材料、哪一页或哪一段，可以照抄能定位的短语；met 必须写，其余没有就写 null。
- fix：具体怎么补，要补什么材料、做到什么程度；partial 和 unmet 必须写，met 写 null。
- 有 dissent 时只重评它指的那一条：认真看本人的理由，再看材料；理由有材料支撑就改判，没有就维持原判，并在 reason 里说清为什么。
- 约定以外你觉得还能做得更好的地方，写进 beyondScope（下次可以做），最多 3 条，每条不超过 40 字；这些不能当作 partial、unmet 的理由，也不写进 fix。没有就写空数组。

# 报告

- headline：一句结论，不超过 30 字。每一条都达到时写「2 条都达到了」这样的话；没都达到时点出最要紧的缺口，例如「还差第 2 条：缺题库打分结果」。
- summary：一到两句，说各条的大致情况，不超过 80 字。
- gain：和上一版比，多达到了哪几条、补上了什么，直接写内容，不用「比上一版」「较上一版」开头（界面上已经有这几个字）；第一版写 null。
- criteria：每一条一项，index 和输入的编号一一对应，不多不少；有 dissent 时只交它指的那一条。
- beyondScope：见上，有 dissent 时写空数组。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

/** 交付说明的提示词：口吻那一句按作者的伙伴性格换（buddyPersona 的 noteTone），没选伙伴按沉稳靠谱。 */
export const deliverableNotePrompt = (personality: TBuddyPersonality) => `# 角色

你是本人的伙伴。本人刚交付了一个 Task 的新版本，你替本人写这一版的说明，留给以后回看。

# 输入

一个 JSON：task 是 Task 的名字和验收标准；version 是这一版（附的一句话、材料名字、评审报告）；previous 是上一次交付的版本（同样三样），第一次交付没有。评审报告只作参考，没评完时是空的。

# 写什么

- achieved：先说达成了什么，一句话，不超过 30 字，例如「v2 达成了：对话质量过了 75 分线」。只写材料和报告里看得到的；报告里有没达到的标准时，只说做到的那部分，不说全部达成。
- gain：这一版比上一版多做到的，不超过 60 字；第一次交付写这一版做到了什么。
- why：为什么变了，写判断怎么变的、用了什么新方法、外部信息有什么变化，不超过 100 字；只写变化和原因，不复述做了哪些事。输入里看不出原因就写 null。
- lesson：一条经验或教训，不超过 60 字；没有就写 null。
- ${noteTone(personality)}不打招呼，不称呼本人。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
const ReviewCandidate = Type.Object({
  headline: Type.String({ minLength: 1, maxLength: 60 }),
  summary: Type.String({ minLength: 1, maxLength: 160 }),
  gain: Nullable(Type.String({ maxLength: 160 })),
  mismatch: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
  beyondScope: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 5 })),
  criteria: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    verdict: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
    reason: Type.String({ minLength: 1, maxLength: 120 }),
    evidence: Nullable(Type.String({ maxLength: 300 })),
    fix: Nullable(Type.String({ maxLength: 300 })),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
export type TReviewCandidate = Static<typeof ReviewCandidate>;

const NoteCandidate = Type.Object({
  achieved: Type.String({ minLength: 1, maxLength: 60 }),
  gain: Type.String({ minLength: 1, maxLength: 120 }),
  why: Nullable(Type.String({ maxLength: 200 })),
  lesson: Nullable(Type.String({ maxLength: 120 })),
}, { additionalProperties: false });
export type TNoteCandidate = Static<typeof NoteCandidate>;

/** 报告里存的一条（标准文字在版本的 criteria 快照里）。 */
export type StoredCriterion = TReviewCandidate["criteria"][number] & { dissent: { reason: string; upheld: boolean | null } | null };
/** mismatch：材料和这个 Task 对不上时的一句话；11/03 以前的报告没有这一项。beyondScope：约定外的改进建议；11/06 以前的报告没有这一项。 */
export type StoredReview = { headline: string | null; summary: string | null; gain: string | null; mismatch?: string | null; beyondScope?: string[]; criteria: StoredCriterion[] };
export type StoredNote = { status: "writing" | "done" | "failed"; achieved: string | null; gain: string | null; why: string | null; lesson: string | null; edited: boolean; dismissed: boolean };
/** 传版本时约定的快照（deliverable_versions.agreement）：proofs 和这一版的 criteria 一一对应，没写为 null。 */
export type AgreementSnapshot = { proofs: (string | null)[]; exclusions: string[] };

export type ReviewAgentInput = {
  task: { name: string; doneDefinition: string | null };
  basis: "acceptance" | "definition";
  /** proof：约定里这一条用什么证明（没约定的条不带）。 */
  criteria: { index: number; text: string; proof?: string }[];
  /** 约定里这次不包括的事（没有时不带）。 */
  exclusions?: string[];
  version: { statement: string | null; items: { name: string; kind: string; text: string | null }[] };
  unreadable: { name: string; note: string }[];
  previous?: { index: number; text: string; verdict: TCriterionVerdict; reason: string }[];
  /** 本人这个月别的 Task 的名字：材料传错了 Task 时用来点名。 */
  otherTasks?: string[];
  dissent?: { index: number; reason: string };
  current?: Omit<StoredCriterion, "dissent">[];
};
export type NoteAgentInput = {
  task: { name: string; criteria: string[] };
  version: NoteVersionInput;
  previous?: NoteVersionInput;
};
type NoteVersionInput = { number: number; statement: string | null; items: string[]; review: { headline: string | null; summary: string | null; criteria: { text: string; verdict: string; reason: string }[] } };

export type DeliverableReviewAgent = {
  review(input: ReviewAgentInput, options: { versionId: string; personId: string; images: ImageContent[]; signal: AbortSignal;
    /** 流式提交里已写到第几条；final 是整份报告写完。 */
    onProgress?: (written: number, final: boolean) => void }): Promise<TReviewCandidate>;
};
export type DeliverableNoteAgent = {
  write(input: NoteAgentInput, options: { versionId: string; personId: string; personality: TBuddyPersonality; signal: AbortSignal }): Promise<TNoteCandidate>;
};
export type DeliverableAgents = { review: DeliverableReviewAgent; note: DeliverableNoteAgent };

/** 报告的业务校验：编号正好 1..n 各一次（异议重评只交那一条也行）；met 要写依据，partial / unmet 要写怎么补。 */
export function reviewProblem(candidate: TReviewCandidate, total: number, dissentIndex?: number): string | null {
  const indices = candidate.criteria.map((item) => item.index);
  if (new Set(indices).size !== indices.length) return "criteria 里有重复的 index";
  if (indices.some((index) => index > total)) return `index 只能是 1 到 ${total}`;
  if (dissentIndex !== undefined ? !indices.includes(dissentIndex) : indices.length !== total) return dissentIndex !== undefined
    ? `要交第 ${dissentIndex} 条的重评` : `criteria 要正好 ${total} 项，index 从 1 到 ${total}`;
  for (const item of candidate.criteria) {
    if (item.verdict === "met" && !item.evidence?.trim()) return `第 ${item.index} 条判 met，evidence 要写依据位置`;
    if (item.verdict !== "met" && !item.fix?.trim()) return `第 ${item.index} 条判 ${item.verdict}，fix 要写怎么补`;
  }
  return null;
}

const THINKING_LEVELS = new Set<CandidateThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
type ModelOptions = { query: Query; baseUrl: string; apiKey: string; modelId: string; thinking?: string };
const modelOf = (options: ModelOptions) => {
  const level = options.thinking?.trim().toLowerCase() as CandidateThinkingLevel | undefined;
  return { query: options.query, baseUrl: options.baseUrl, apiKey: options.apiKey, modelId: options.modelId,
    thinkingLevel: level && THINKING_LEVELS.has(level) ? level : "medium" as const };
};

export function createDeliverableReviewAgent(options: ModelOptions): DeliverableReviewAgent {
  return {
    async review(input, { versionId, personId, images, signal, onProgress }) {
      const result = await runCandidateAgent({ ...modelOf(options), kind: "deliverable_review", objectRef: { type: "deliverable_version", id: versionId }, personId,
        input, prompt: DELIVERABLE_REVIEW_PROMPT, schema: ReviewCandidate, images, signal, maxModelCalls: 4,
        validate: (candidate) => reviewProblem(candidate, input.criteria.length, input.dissent?.index),
        onEvent: (event) => {
          if (event.type !== "tool_args" || event.name !== "submit_candidate") return;
          const criteria = (event.args as { criteria?: unknown } | null)?.criteria;
          onProgress?.(Array.isArray(criteria) ? criteria.length : 0, event.final === true);
        } });
      return result.candidate;
    },
  };
}

export function createDeliverableNoteAgent(options: ModelOptions): DeliverableNoteAgent {
  return {
    async write(input, { versionId, personId, personality, signal }) {
      return (await runCandidateAgent({ ...modelOf(options), kind: "deliverable_note", objectRef: { type: "deliverable_version", id: versionId }, personId,
        input, prompt: deliverableNotePrompt(personality), schema: NoteCandidate, signal, maxModelCalls: 3 })).candidate;
    },
  };
}

const FEISHU_HOST = /(?:^|\.)(?:feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/i;
const LINK_TEXT_CHARS = 20_000;
const ITEM_TEXT_CHARS = 30_000;
const TOTAL_TEXT_CHARS = 120_000;
const MAX_IMAGES = 8;
const RUN_TIMEOUT_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const REVIEW_FAILED = "评审没做完，可以重试";

/** 读一个链接：飞书文档这一版不读；其余按公网正文取，取不到算打不开。 */
async function readLink(url: string, fetchArticle: ArticleFetcher, signal?: AbortSignal): Promise<{ text: string } | { note: string }> {
  let host = "";
  try { host = new URL(url).hostname; } catch { return { note: "打不开 · 请导出后上传" }; }
  if (FEISHU_HOST.test(host)) return { note: "飞书文档请导出后上传" };
  const article = await fetchArticle(url, { signal });
  return article?.text.trim() ? { text: article.text.slice(0, LINK_TEXT_CHARS) } : { note: "打不开 · 请导出后上传" };
}

type VersionRow = { id: string; task_id: string; author_id: string; number: number; task_name: string; done_definition: string | null; statement: string | null;
  basis: "acceptance" | "definition" | "none"; criteria: string[]; agreement: AgreementSnapshot | null; review: StoredReview | null; review_status: string;
  delivered_at: Date | null; note: StoredNote | null };
type ItemRow = { id: string; kind: "file" | "image" | "link"; name: string; mime_type: string | null; storage_key: string | null; url: string | null;
  extracted_text: string | null; read: "pending" | "read" | "unreadable"; read_note: string | null };

const itemsOf = async (q: Query, versionId: string) =>
  (await q("SELECT * FROM deliverable_items WHERE version_id=$1 ORDER BY position", [versionId])).rows as ItemRow[];

/** 交给 Agent 的材料文字：单份 3 万字、合计 12 万字以内。 */
function readableItems(items: ItemRow[]): ReviewAgentInput["version"]["items"] {
  let left = TOTAL_TEXT_CHARS;
  return items.flatMap((item): ReviewAgentInput["version"]["items"] => {
    if (item.kind === "image") return item.read === "unreadable" ? [] : [{ name: item.name, kind: "image", text: null }];
    if (item.read !== "read" || !item.extracted_text) return [];
    const text = item.extracted_text.slice(0, Math.min(ITEM_TEXT_CHARS, Math.max(left, 0)));
    left -= text.length;
    return [{ name: item.name, kind: item.kind, text }];
  });
}

/** otherTasks：本人这个月别的 Task 的名字（不含这个），读不到时评审照常进行、不点名。 */
export function createDeliverableQueue(options: { pool: Pool; storageDir: string; agents: DeliverableAgents; fetchArticle: ArticleFetcher; now: () => Date; onError: (error: unknown) => void;
  otherTasks?: (personId: string, taskId: string) => Promise<string[]> }) {
  const running = new Map<string, Promise<void>>(), abort = new AbortController();
  const q: Query = options.pool.query.bind(options.pool);
  const stale = () => new Date(options.now().getTime() - STALE_MS);
  const runSignal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
  /** 在超时或关闭时立刻放手，不等 Agent 自己停下。 */
  const raced = <T>(work: Promise<T>, signal: AbortSignal) => Promise.race([work, new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);

  async function review(versionId: string) {
    const token = randomUUID();
    const row = (await q(`UPDATE deliverable_versions SET review_status='running',review_run_token=$2,review_started_at=$3,review_finished_at=NULL,review_error=NULL
      WHERE id=$1 AND (review_status='queued' OR (review_status='running' AND (review_run_token IS NULL OR review_started_at<$4))) RETURNING *`,
    [versionId, token, options.now(), stale()])).rows[0] as VersionRow | undefined;
    if (!row) return;
    const guard = "id=$1 AND review_run_token=$2 AND review_status='running'";
    const phase = (step: number, total: number, label: string) =>
      q(`UPDATE deliverable_versions SET review_phase=$3::jsonb WHERE ${guard}`, [versionId, token, JSON.stringify({ step, total, label })]);
    const dissent = row.review?.criteria.find((item) => item.dissent && item.dissent.upheld === null);
    const n = row.criteria.length;
    try {
      if (!n || row.basis === "none") {
        await q(`UPDATE deliverable_versions SET review_status='done',review=$3::jsonb,review_phase=NULL,review_finished_at=$4 WHERE ${guard}`,
          [versionId, token, JSON.stringify({ headline: null, summary: null, gain: null, mismatch: null, criteria: [] } satisfies StoredReview), options.now()]);
        return;
      }
      const signal = runSignal();
      let items = await itemsOf(q, versionId);
      if (dissent) await phase(1, 1, `重评第 ${dissent.index} 条`);
      else {
        await phase(1, n + 2, items.length ? `读交付物（${items.length} 份）` : "读现状说明");
        for (const item of items.filter((entry) => entry.kind === "link" && entry.read === "pending")) {
          const read = await readLink(item.url!, options.fetchArticle, signal);
          await q("UPDATE deliverable_items SET read=$2,extracted_text=$3,read_note=$4 WHERE id=$1",
            "text" in read ? [item.id, "read", read.text, null] : [item.id, "unreadable", null, read.note]);
        }
        items = await itemsOf(q, versionId);
      }
      const images: ImageContent[] = [], seen: string[] = [];
      for (const item of items.filter((entry) => entry.kind === "image" && entry.read !== "unreadable")) {
        const note = images.length >= MAX_IMAGES ? `一版最多看 ${MAX_IMAGES} 张图片` : null;
        const data = note ? null : await readFile(join(options.storageDir, item.storage_key!)).catch(() => null);
        if (data) { images.push({ type: "image", data: data.toString("base64"), mimeType: item.mime_type ?? "image/png" }); seen.push(item.id); continue; }
        await q("UPDATE deliverable_items SET read='unreadable',read_note=$2 WHERE id=$1", [item.id, note ?? "图片找不到了，请重新上传"]);
        item.read = "unreadable";
        item.read_note = note ?? "图片找不到了，请重新上传";
      }
      const previous = dissent ? null : (await q(`SELECT criteria,review FROM deliverable_versions WHERE task_id=$1 AND number<$2 AND review_status='done' AND review IS NOT NULL
        ORDER BY number DESC LIMIT 1`, [row.task_id, row.number])).rows[0] as { criteria: string[]; review: StoredReview } | undefined;
      const otherTasks = dissent || !options.otherTasks ? [] : await options.otherTasks(row.author_id, row.task_id).catch(() => []);
      const input: ReviewAgentInput = {
        task: { name: row.task_name, doneDefinition: row.done_definition }, basis: row.basis,
        criteria: row.criteria.map((text, index) => ({ index: index + 1, text, ...(row.agreement?.proofs[index] ? { proof: row.agreement.proofs[index]! } : {}) })),
        ...(row.agreement?.exclusions.length ? { exclusions: row.agreement.exclusions } : {}),
        version: { statement: row.statement, items: readableItems(items) },
        unreadable: items.filter((item) => item.read === "unreadable").map((item) => ({ name: item.name, note: item.read_note ?? "读不到" })),
        ...(previous?.review.criteria.length ? { previous: previous.review.criteria.map((item) => ({ index: item.index, text: previous.criteria[item.index - 1] ?? "",
          verdict: item.verdict, reason: item.reason })) } : {}),
        ...(otherTasks.length ? { otherTasks } : {}),
        ...(dissent ? { dissent: { index: dissent.index, reason: dissent.dissent!.reason }, current: row.review!.criteria.map(({ dissent: _dissent, ...item }) => item) } : {}),
      };
      let shown = 1;
      const onProgress = (written: number, final: boolean) => {
        if (dissent) return;
        const step = final ? n + 2 : 1 + Math.min(Math.max(written, 1), n);
        if (step <= shown) return;
        shown = step;
        void phase(step, n + 2, final ? "写报告" : `对照第 ${step - 1} 条`).catch(options.onError);
      };
      if (!dissent) await phase(2, n + 2, "对照第 1 条");
      const candidate = await raced(options.agents.review.review(input, { versionId, personId: row.author_id, images, signal, onProgress }), signal);
      const problem = reviewProblem(candidate, n, dissent?.index);
      if (problem) throw new Error(problem);
      const report: StoredReview = dissent
        ? { ...row.review!, headline: candidate.headline, summary: candidate.summary, criteria: row.review!.criteria.map((item) => {
          if (item.index !== dissent.index) return item;
          const next = candidate.criteria.find((entry) => entry.index === dissent.index)!;
          return { ...next, dissent: { reason: dissent.dissent!.reason, upheld: next.verdict === "met" } };
        }) }
        : { headline: candidate.headline, summary: candidate.summary, gain: previous ? candidate.gain : null, mismatch: candidate.mismatch ?? null,
          beyondScope: candidate.beyondScope ?? [], criteria: [...candidate.criteria].sort((a, b) => a.index - b.index).map((item) => ({ ...item, dissent: null })) };
      const saved = await q(`UPDATE deliverable_versions SET review_status='done',review=$3::jsonb,review_phase=NULL,review_finished_at=$4 WHERE ${guard}`,
        [versionId, token, JSON.stringify(report), options.now()]);
      if (saved.rowCount && seen.length) await q("UPDATE deliverable_items SET read='read' WHERE id=ANY($1::uuid[])", [seen]);
    } catch (cause) {
      // 关闭时放回队列，下次启动接着评；其余算这次没评完。
      await q(abort.signal.aborted
        ? `UPDATE deliverable_versions SET review_status='queued',review_run_token=NULL,review_phase=NULL WHERE ${guard}`
        : `UPDATE deliverable_versions SET review_status='failed',review_error=$3,review_phase=NULL,review_finished_at=$4 WHERE ${guard}`,
      abort.signal.aborted ? [versionId, token] : [versionId, token, REVIEW_FAILED, options.now()]);
      if (!abort.signal.aborted) options.onError(cause);
    }
  }

  async function note(versionId: string) {
    const row = (await q("SELECT * FROM deliverable_versions WHERE id=$1 AND delivered_at IS NOT NULL AND note->>'status'='writing'", [versionId])).rows[0] as VersionRow | undefined;
    if (!row) return;
    const describe = async (version: VersionRow): Promise<NoteVersionInput> => ({ number: version.number, statement: version.statement,
      items: (await itemsOf(q, version.id)).map((item) => item.name),
      review: { headline: version.review?.headline ?? null, summary: version.review?.summary ?? null,
        criteria: (version.review?.criteria ?? []).map((item) => ({ text: version.criteria[item.index - 1] ?? "", verdict: item.verdict, reason: item.reason })) } });
    const previous = (await q(`SELECT * FROM deliverable_versions WHERE task_id=$1 AND number<$2 AND delivered_at IS NOT NULL ORDER BY number DESC LIMIT 1`,
      [row.task_id, row.number])).rows[0] as VersionRow | undefined;
    const guard = "id=$1 AND delivered_at=$2 AND note->>'status'='writing'";
    try {
      const input: NoteAgentInput = { task: { name: row.task_name, criteria: row.criteria }, version: await describe(row), ...(previous ? { previous: await describe(previous) } : {}) };
      const signal = runSignal();
      const personality = (await readBuddy(q, row.author_id))?.personality ?? "steady";
      const candidate = await raced(options.agents.note.write(input, { versionId, personId: row.author_id, personality, signal }), signal);
      await q(`UPDATE deliverable_versions SET note=$3::jsonb WHERE ${guard}`, [versionId, row.delivered_at,
        JSON.stringify({ status: "done", ...candidate, edited: false, dismissed: false } satisfies StoredNote)]);
    } catch (cause) {
      if (abort.signal.aborted) return;
      await q(`UPDATE deliverable_versions SET note=note||'{"status":"failed"}'::jsonb WHERE ${guard}`, [versionId, row.delivered_at]);
      options.onError(cause);
    }
  }

  function enqueue(key: string, work: () => Promise<void>): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    const existing = running.get(key); if (existing) return existing;
    const job = work().catch(options.onError).finally(() => { running.delete(key); });
    running.set(key, job); return job;
  }
  return {
    enqueueReview: (versionId: string) => enqueue(`review:${versionId}`, () => review(versionId)),
    enqueueNote: (versionId: string) => enqueue(`note:${versionId}`, () => note(versionId)),
    async recover() {
      const reviews = await q(`SELECT id FROM deliverable_versions WHERE review_status='queued'
        OR (review_status='running' AND (review_run_token IS NULL OR review_started_at<$1))`, [stale()]);
      for (const { id } of reviews.rows) void enqueue(`review:${id}`, () => review(id));
      const notes = await q("SELECT id FROM deliverable_versions WHERE delivered_at IS NOT NULL AND note->>'status'='writing'");
      for (const { id } of notes.rows) void enqueue(`note:${id}`, () => note(id));
    },
    /** 等手上的评审和说明跑完（测试用）。 */
    async idle() { while (running.size) await Promise.all(running.values()); },
    async close() { abort.abort(); await Promise.all(running.values()); },
  };
}
export type DeliverableQueue = ReturnType<typeof createDeliverableQueue>;
