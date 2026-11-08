import type { Query } from "./meetingStore.js";

/**
 * 子会话的字母（18 节第 10 条，契约 SubSessionLetter）：每个项目里的卡和专题按建立先后编号 A、B……Z、AA、AB……，存在 sub_session_letters。
 * 建了不变、不复用：行不删，新的序号取这个项目最大的往下编。读到还没编号的（新建的卡、专题，换到这个项目的）当场按建立先后补上。
 */

export type SubKind = "card" | "topic";
export type LetterSubject = { projectId: string; kind: SubKind; id: string };

/** 序号 → 字母：1 = A，26 = Z，27 = AA。 */
export function letterOf(seq: number): string {
  let letter = "";
  for (let n = seq; n > 0; n = Math.floor((n - 1) / 26)) letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  return letter;
}

/** 字母 → 序号；不是 1–3 个大写字母为 null。 */
export function seqOf(letter: string): number | null {
  if (!/^[A-Z]{1,3}$/.test(letter)) return null;
  return [...letter].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
}

const key = (kind: SubKind, id: string) => `${kind}:${id}`;

/**
 * 这几个子会话在各自项目里的字母（key 是 kind:id），没编号的先补上。同时有两处在补时，撞了序号的那几个再补一次。
 * 卡、专题已经不在库里的不补。
 */
export async function lettersFor(q: Query, subjects: LetterSubject[]): Promise<Map<string, string>> {
  const letters = new Map<string, string>();
  const byProject = new Map<string, LetterSubject[]>();
  for (const subject of subjects) byProject.set(subject.projectId, [...(byProject.get(subject.projectId) ?? []), subject]);
  for (const [projectId, group] of byProject) {
    const cards = group.filter((subject) => subject.kind === "card").map((subject) => subject.id);
    const topics = group.filter((subject) => subject.kind === "topic").map((subject) => subject.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = (await q(`SELECT kind,subject_id::text AS id,seq FROM sub_session_letters
        WHERE project_id=$1 AND (kind='card' AND subject_id=ANY($2::uuid[]) OR kind='topic' AND subject_id=ANY($3::uuid[]))`, [projectId, cards, topics])).rows as
        { kind: SubKind; id: string; seq: number }[];
      for (const row of rows) letters.set(key(row.kind, row.id), letterOf(row.seq));
      const missing = group.filter((subject) => !letters.has(key(subject.kind, subject.id)));
      if (!missing.length) break;
      await q(`WITH s AS (SELECT 'card'::text AS kind,id,created_at FROM tasks WHERE id=ANY($2::uuid[])
          UNION ALL SELECT 'topic',id,created_at FROM research_topics WHERE id=ANY($3::uuid[]))
        INSERT INTO sub_session_letters(project_id,kind,subject_id,seq)
        SELECT $1,s.kind,s.id,m.n+row_number() OVER (ORDER BY s.created_at,s.id) FROM s
          CROSS JOIN (SELECT COALESCE(max(seq),0) AS n FROM sub_session_letters WHERE project_id=$1) m
        ON CONFLICT DO NOTHING`, [projectId, missing.filter((subject) => subject.kind === "card").map((subject) => subject.id),
        missing.filter((subject) => subject.kind === "topic").map((subject) => subject.id)]);
    }
  }
  return letters;
}

/** 一个子会话在它现在所在项目里的字母；不在项目里为 null。 */
export async function letterOfSub(q: Query, kind: SubKind, id: string): Promise<{ projectId: string; letter: string } | null> {
  const projectId = await subProject(q, kind, id);
  if (!projectId) return null;
  const letter = (await lettersFor(q, [{ projectId, kind, id }])).get(key(kind, id));
  return letter ? { projectId, letter } : null;
}

/** 子会话现在所在的项目（同首页：挂着的 Task 在哪个项目，没挂 Task 的看自己的 project_id）；不在项目里、没有为 null。 */
export async function subProject(q: Query, kind: SubKind, id: string): Promise<string | null> {
  const table = kind === "card" ? "tasks" : "research_topics";
  const row = (await q(`SELECT COALESCE(g.project_id,s.project_id)::text AS project_id FROM ${table} s
    LEFT JOIN project_goals g ON g.task_id=s.plan_task_id AND g.owner_id=s.owner_id WHERE s.id=$1`, [id])).rows[0] as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

/** 这个项目里这个字母是哪个子会话（还在库里的）；没有为 null。 */
export async function subByLetter(q: Query, projectId: string, letter: string): Promise<{ kind: SubKind; id: string } | null> {
  const seq = seqOf(letter);
  if (seq === null) return null;
  const row = (await q(`SELECT l.kind,l.subject_id::text AS id FROM sub_session_letters l WHERE l.project_id=$1 AND l.seq=$2
    AND (l.kind='card' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=l.subject_id) OR l.kind='topic' AND EXISTS (SELECT 1 FROM research_topics r WHERE r.id=l.subject_id))`,
  [projectId, seq])).rows[0] as { kind: SubKind; id: string } | undefined;
  return row ?? null;
}
