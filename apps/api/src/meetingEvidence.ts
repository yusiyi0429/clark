import type { TPreflightEvidenceLegacyMaterial, TPreflightEvidenceMaterial } from "@warmap/contracts";
import { splitMaterialBlocks } from "./materialDiff.js";
import { getMeetingRow, type Query } from "./meetingStore.js";
import { canAccessObjectMaterials, type MaterialViewer } from "./objectMaterials.js";
import type { GroupInputVersions } from "./preflightStaleness.js";
import { isActiveMember, type ThreadRef } from "./threads.js";

/**
 * 预审与 Chat 共用的“群里有什么”读取层（feedback 12 / H04）。
 *
 * 读取范围：会议本身与其关联议题上的群材料最新有效版本、群讨论（thread_messages 的成员消息），
 * 以及会议的旧会前材料（meetings.materials，与群材料重复的去掉）。私人 Chat（conversations）永远不在这里读。
 *
 * 权限沿原生规则：
 * - 群材料：canAccessObjectMaterials（与 /api/materials 和 Chat 的 list_materials/read_material 同一道门）；
 * - 群讨论：isActiveMember（与 /api/threads 同一道门，非成员含 CEO 一律看不到）。
 * 无权限的对象只计数，不进入输入，也不暴露名称。
 *
 * sourceRef 格式（预审 entries.sourceRefs 白名单与历史分层共用；旧格式继续有效）：
 * - `material:<objectMaterialId>@v<version>`：群材料的某一版本；可加段落锚点 `#p<n>`（n 从 1 起，
 *   对应输入正文里的 `[p<n>]` 标记，即原生 splitMaterialBlocks 的块序号）；
 * - `material:<legacyMaterialId>`：旧会前材料（meetings.materials），不带版本；
 * - `discussion:<threadMessageId>`：一条群讨论消息；
 * - `decision:<receiptId|historyId>`：一条已确认的历史决定（见 issueDecisionHistory.ts）。
 */

export const groupMaterialRef = (id: string, version: number) => `material:${id}@v${version}`;
export const discussionRef = (id: number) => `discussion:${id}`;
export const decisionRef = (id: string) => `decision:${id}`;

const GROUP_MATERIAL_REF = /^material:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@v(\d+)(?:#p(\d+))?$/i;

/** 解析 `material:<id>@v<n>[#p<k>]`；不是群材料版本引用时返回 null。 */
export function parseGroupMaterialRef(ref: string): { id: string; version: number; paragraph: number | null } | null {
  const match = GROUP_MATERIAL_REF.exec(ref);
  if (!match) return null;
  return { id: match[1].toLowerCase(), version: Number(match[2]), paragraph: match[3] ? Number(match[3]) : null };
}

/** 单份群材料最多进入输入的字符数；整体群材料预算。超过即截断并在快照里标 truncated。 */
export const EVIDENCE_MATERIAL_MAX_CHARS = 60_000;
export const EVIDENCE_MATERIALS_TOTAL_CHARS = 200_000;
/** 群讨论最多带最近多少条成员消息。 */
export const EVIDENCE_DISCUSSION_MAX_MESSAGES = 120;

export type EvidencePerson = { personId: string; displayName: string };

export type EvidenceMaterial = {
  id: string;
  objectType: "meeting" | "issue";
  objectId: string;
  objectTitle: string;
  fileName: string;
  format: string;
  version: number;
  updatedAt: string;
  owner: EvidencePerson;
  revisionSummary: string | null;
  sourceRef: string;
  state: TPreflightEvidenceMaterial["state"];
  /** 带 `[p<n>]` 段落标记的正文；link_only / unreadable 为 null。 */
  text: string | null;
  /** text 中实际给出的段落数（锚点只能落在这个范围内）。 */
  paragraphCount: number;
  truncated: boolean;
  url: string | null;
};

export type EvidenceDiscussion = {
  id: number;
  sourceRef: string;
  objectType: "meeting" | "issue";
  objectId: string;
  objectTitle: string;
  author: EvidencePerson;
  at: string;
  content: string;
  quote: unknown;
  /** 发言性质（导入资料提供：提案/意见/事实核对等）；现场发言为 null。发言不是组织决定。 */
  stance: string | null;
};

export type EvidenceLegacyMaterial = {
  id: string;
  fileName: string;
  mimeType: string;
  providedBy: string | null;
  uploadedAt: string;
  extractedText: string;
  sourceRef: string;
  state: TPreflightEvidenceLegacyMaterial["state"];
  duplicateOf?: string;
};

export type ObjectEvidence = {
  viewerId: string;
  collectedAt: string;
  /** 有权限读取的对象。 */
  objects: (ThreadRef & { title: string })[];
  /** 因无权限没有读取的对象数。 */
  skippedObjects: number;
  materials: EvidenceMaterial[];
  discussions: EvidenceDiscussion[];
  /** 可见群讨论的最大消息 id（含未带入输入的旧消息）。 */
  discussionMaxId: number;
  /** 可见群讨论总条数；大于 discussions.length 时只带了最近的部分。 */
  discussionTotal: number;
  /** options.discussionSince 之后的可见成员消息数（未给时等于 discussionTotal）。 */
  discussionSinceCount: number;
};

export type MeetingEvidence = ObjectEvidence & {
  meetingId: string;
  legacyMaterials: EvidenceLegacyMaterial[];
};

type MaterialSqlRow = {
  id: string; object_type: "meeting" | "issue"; object_id: string; file_name: string; format: string; url: string | null;
  owner_id: string; current_version: number; updated_at: Date; summary: string | null; body?: string;
};

/** HTML 源码转可读文字：去掉脚本/样式/注释，块级标签分段，其余标签去掉，常见实体还原。 */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|header|footer|h[1-6]|li|ul|ol|table|tr|blockquote|pre|figure|figcaption)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#") && name !== "#39") return String.fromCodePoint(Number(name.slice(1)));
      return entities[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 正文切段并加 `[p<n>]` 标记，按预算截断。 */
function paragraphs(text: string, format: string, budget: number): { text: string; count: number; truncated: boolean } {
  const blocks = (format === "html" ? text.split(/\n{2,}/) : splitMaterialBlocks(text)).map((block) => block.trim()).filter(Boolean);
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const [index, block] of blocks.entries()) {
    const labelled = `[p${index + 1}] ${block}`;
    if (used + labelled.length > budget) {
      const room = budget - used - `[p${index + 1}] `.length;
      if (room > 200) out.push(`[p${index + 1}] ${block.slice(0, room)}…`);
      truncated = true;
      break;
    }
    out.push(labelled);
    used += labelled.length + 2;
  }
  return { text: out.join("\n\n"), count: out.length, truncated };
}

const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();
const normalizeBody = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

/**
 * 读取一组对象上的群材料与群讨论。withContent=false 时只取版本与讨论游标（用于生成后/投影时判断是否过期）。
 * 对象顺序即输出顺序：调用方把“当前对象”放在最前。
 */
export async function collectObjectEvidence(
  q: Query,
  objects: ThreadRef[],
  viewer: MaterialViewer,
  options: { names: Map<string, string>; withContent?: boolean; titles?: Map<string, string>; discussionSince?: number },
): Promise<ObjectEvidence> {
  const withContent = options.withContent !== false;
  const name = (personId: string): EvidencePerson => ({ personId, displayName: options.names.get(personId) ?? personId });
  const accessible: (ThreadRef & { title: string })[] = [];
  let skippedObjects = 0;
  const discussionObjects: ThreadRef[] = [];
  for (const ref of objects) {
    if (ref.objectType !== "meeting" && ref.objectType !== "issue") continue;
    if (!await canAccessObjectMaterials(q, ref, viewer)) {
      skippedObjects += 1;
      continue;
    }
    accessible.push({ ...ref, title: options.titles?.get(`${ref.objectType}:${ref.objectId}`) ?? "" });
    if (await isActiveMember(q, ref, viewer.personId)) discussionObjects.push(ref);
  }

  const materials: EvidenceMaterial[] = [];
  let budget = EVIDENCE_MATERIALS_TOTAL_CHARS;
  for (const ref of accessible) {
    const rows = (await q(
      `SELECT m.id::text AS id, m.object_type, m.object_id, m.file_name, m.format, m.url, m.owner_id, m.current_version, m.updated_at,
              r.summary${withContent ? ", r.body" : ""}
         FROM object_materials m
         JOIN material_revisions r ON r.material_id = m.id AND r.version = m.current_version
        WHERE m.object_type = $1 AND m.object_id = $2 AND m.deleted_at IS NULL
        ORDER BY m.created_at, m.id`,
      [ref.objectType, ref.objectId],
    )).rows as MaterialSqlRow[];
    for (const row of rows) {
      const base = {
        id: row.id, objectType: row.object_type, objectId: row.object_id, objectTitle: ref.title, fileName: row.file_name,
        format: row.format, version: row.current_version, updatedAt: row.updated_at.toISOString(), owner: name(row.owner_id),
        revisionSummary: row.summary, sourceRef: groupMaterialRef(row.id, row.current_version), url: row.url,
      };
      if (row.format === "link") {
        materials.push({ ...base, state: "link_only", text: null, paragraphCount: 0, truncated: false });
        continue;
      }
      if (!withContent) {
        materials.push({ ...base, state: "used", text: null, paragraphCount: 0, truncated: false });
        continue;
      }
      const plain = row.format === "html" ? htmlToText(row.body ?? "") : (row.body ?? "").trim();
      if (!plain) {
        materials.push({ ...base, state: "unreadable", text: null, paragraphCount: 0, truncated: false });
        continue;
      }
      const cut = paragraphs(plain, row.format, Math.min(EVIDENCE_MATERIAL_MAX_CHARS, Math.max(budget, 0)));
      if (!cut.count) {
        // 预算已用完：仍算可读，但这一版没有正文进入输入，如实标截断。
        materials.push({ ...base, state: "used", text: "", paragraphCount: 0, truncated: true });
        continue;
      }
      budget -= cut.text.length;
      materials.push({ ...base, state: "used", text: cut.text, paragraphCount: cut.count, truncated: cut.truncated });
    }
  }

  let discussions: EvidenceDiscussion[] = [];
  let discussionMaxId = 0;
  let discussionTotal = 0;
  let discussionSinceCount = 0;
  if (discussionObjects.length) {
    const where = discussionObjects.map((_, index) => `(object_type = $${index * 2 + 1} AND object_id = $${index * 2 + 2})`).join(" OR ");
    const params = discussionObjects.flatMap((ref) => [ref.objectType, ref.objectId]);
    const since = Math.max(0, Math.trunc(options.discussionSince ?? 0));
    const stats = (await q(
      `SELECT COALESCE(max(id), 0)::bigint AS max_id, count(*)::int AS n, count(*) FILTER (WHERE id > ${since})::int AS since_n
         FROM thread_messages WHERE kind = 'member' AND (${where})`,
      params,
    )).rows[0] as { max_id: string | number; n: number; since_n: number };
    discussionMaxId = Number(stats.max_id);
    discussionTotal = stats.n;
    discussionSinceCount = stats.since_n;
    if (withContent && discussionTotal > 0) {
      const titles = new Map(accessible.map((ref) => [`${ref.objectType}:${ref.objectId}`, ref.title]));
      const rows = (await q(
        `SELECT * FROM (
           SELECT id, object_type, object_id, author_id, content, quote, stance, created_at FROM thread_messages
            WHERE kind = 'member' AND (${where}) ORDER BY id DESC LIMIT ${EVIDENCE_DISCUSSION_MAX_MESSAGES}
         ) recent ORDER BY id`,
        params,
      )).rows as { id: string | number; object_type: "meeting" | "issue"; object_id: string; author_id: string; content: string; quote: unknown; stance: string | null; created_at: Date }[];
      discussions = rows.map((row) => ({
        id: Number(row.id), sourceRef: discussionRef(Number(row.id)), objectType: row.object_type, objectId: row.object_id,
        objectTitle: titles.get(`${row.object_type}:${row.object_id}`) ?? "", author: name(row.author_id),
        at: row.created_at.toISOString(), content: row.content, quote: row.quote ?? null, stance: row.stance ?? null,
      }));
    }
  }
  return { viewerId: viewer.personId, collectedAt: new Date().toISOString(), objects: accessible, skippedObjects,
    materials, discussions, discussionMaxId, discussionTotal, discussionSinceCount };
}

/**
 * 一场会议的预审/Chat 证据：会议本身 + 关联议题（按会议 issue_ids 顺序）+ 去重后的旧会前材料。
 * 会议不存在返回 null。viewer 通常是会议的 CEO 参会人（role ceo）。
 */
export async function collectMeetingEvidence(
  q: Query,
  meetingId: string,
  viewer: MaterialViewer,
  options: { names: Map<string, string>; withContent?: boolean; discussionSince?: number },
): Promise<MeetingEvidence | null> {
  const meeting = await getMeetingRow(q, meetingId);
  if (!meeting) return null;
  const issueTitles = meeting.issue_ids.length
    ? (await q("SELECT id::text AS id, title FROM issues WHERE id = ANY($1::uuid[])", [meeting.issue_ids])).rows as { id: string; title: string }[]
    : [];
  const titles = new Map<string, string>([[`meeting:${meeting.id}`, meeting.title], ...issueTitles.map((row) => [`issue:${row.id}`, row.title] as [string, string])]);
  const objects: ThreadRef[] = [{ objectType: "meeting", objectId: meeting.id }, ...meeting.issue_ids.map((id) => ({ objectType: "issue" as const, objectId: id }))];
  const evidence = await collectObjectEvidence(q, objects, viewer, { ...options, titles });

  // 旧会前材料与群材料（本会议上的）同名或同内容时，只用群材料最新版。
  const meetingMaterials = evidence.materials.filter((material) => material.objectType === "meeting");
  const legacyMaterials: EvidenceLegacyMaterial[] = meeting.materials.map((material) => {
    const sameName = meetingMaterials.find((group) => normalizeName(group.fileName) === normalizeName(material.fileName));
    const sameBody = meetingMaterials.find((group) => group.text !== null && options.withContent !== false
      && normalizeBody(group.text.replace(/\[p\d+\] /g, "")) === normalizeBody(material.extractedText));
    const duplicate = sameName ?? sameBody;
    return {
      id: material.id, fileName: material.fileName, mimeType: material.mimeType, providedBy: material.providedBy,
      uploadedAt: material.uploadedAt, extractedText: material.extractedText, sourceRef: `material:${material.id}`,
      state: duplicate ? "duplicate" as const : "used" as const, ...(duplicate ? { duplicateOf: duplicate.sourceRef } : {}),
    };
  });
  return { ...evidence, meetingId: meeting.id, legacyMaterials };
}

/**
 * 证据的版本快照，形状与 meetingStore 的 group_inputs 一致，用于 computeStaleInputs。
 * newDiscussionCount 取 collect 时 discussionSince 之后的条数，调用方应传入快照里的 discussionMaxId。
 */
export function evidenceVersions(evidence: ObjectEvidence): GroupInputVersions {
  return {
    materials: evidence.materials.map((material) => ({ id: material.id, objectType: material.objectType, objectId: material.objectId,
      fileName: material.fileName, version: material.version })),
    discussionMaxId: evidence.discussionMaxId,
    newDiscussionCount: evidence.discussionSinceCount,
  };
}
