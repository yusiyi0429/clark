import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { MaterialAnnotationCandidate, type MaterialAnnotationAgent } from "./materialAnnotationAgent.js";
import { withMaterialLock, validateMaterialReplacements, type AnnotationRow } from "./materialFeedback.js";
import { ObjectMaterialError, editObjectMaterial, readObjectMaterial, type MaterialViewer } from "./objectMaterials.js";

export function createMaterialAnnotationQueue(options: { pool: Pool; agent: MaterialAnnotationAgent;
  viewer: (personId: string) => MaterialViewer; onError: (error: unknown) => void }) {
  const { pool, agent } = options;
  const running = new Map<string, Promise<void>>();
  const requested = new Set<string>();
  const abort = new AbortController();

  async function processNext(id: string): Promise<boolean> {
    const claimed = await withMaterialLock(pool, id, async (q) => {
      const result = await q(`SELECT a.*, a.updated_at < now()-interval '10 minutes' AS expired
        FROM material_annotations a WHERE material_id=$1 AND status IN ('queued','applying') ORDER BY created_at,id LIMIT 1`, [id]);
      const row = result.rows[0] as (AnnotationRow & { expired: boolean }) | undefined;
      if (!row) return null;
      const revision = (await q("SELECT version FROM material_revisions WHERE annotation_id=$1", [row.id])).rows[0];
      if (revision) {
        await q("UPDATE material_annotations SET status='applied',applied_version=$2,note=NULL,updated_at=now() WHERE id=$1", [row.id, revision.version]);
        return true;
      }
      if (row.status === "applying" && !row.expired) return null;
      if (row.status === "applying") await q("UPDATE material_annotations SET status='queued',updated_at=now() WHERE id=$1", [row.id]);
      await q("UPDATE material_annotations SET status='applying',updated_at=now() WHERE id=$1", [row.id]);
      return row;
    });
    if (!claimed) return false;
    if (claimed === true) return true;
    // The committed applying head blocks other workers. Hold the material row lock through the model run and revision commit.
    await withMaterialLock(pool, id, async (q) => {
      // A delayed claimant may resume after recovery on another process has already finished this annotation.
      const current = (await q("SELECT status FROM material_annotations WHERE id=$1", [claimed.id])).rows[0];
      if (current?.status !== "applying") return;
      const ref = { objectType: claimed.object_type, objectId: claimed.object_id };
      let note: string | null = null;
      for (let attempt = claimed.attempts; attempt < 2; attempt++) {
        if (abort.signal.aborted) throw abort.signal.reason;
        await q("UPDATE material_annotations SET attempts=$2,updated_at=now() WHERE id=$1", [claimed.id, attempt + 1]);
        await q("SAVEPOINT annotation_attempt");
        try {
          const viewer = options.viewer(claimed.author_id);
          const material = await readObjectMaterial(q, ref, id, viewer);
          if (material.format !== "markdown" && material.format !== "html") throw new ObjectMaterialError(400, "MATERIAL_READ_ONLY", "材料只读");
          const table = ref.objectType === "issue" ? "issues" : ref.objectType === "task" ? "tasks" : "meetings";
          const title = (await q(`SELECT title FROM ${table} WHERE id::text=$1`, [ref.objectId])).rows[0]?.title as string;
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5 * 60_000)]);
          const generated = await agent.generate({ materialId: id, objectType: ref.objectType, objectId: ref.objectId,
            title, format: material.format, source: material.body, version: material.version, quote: claimed.quote,
            prefix: claimed.prefix, suffix: claimed.suffix, body: claimed.body, author: viewer, previousError: note }, signal, q);
          if (signal.aborted) throw signal.reason;
          if (!Value.Check(MaterialAnnotationCandidate, generated.candidate)) throw new Error("invalid annotation candidate");
          const candidate = generated.candidate;
          if (candidate.noChange !== null) {
            if (candidate.edits.length) throw new Error("noChange conflicts with edits");
            await q("UPDATE material_annotations SET status='no_change',note=$2,updated_at=now() WHERE id=$1", [claimed.id, candidate.noChange]);
          } else {
            validateMaterialReplacements(material.body, candidate.edits);
            const edited = await editObjectMaterial(pool, ref, id, viewer, material.version, candidate.edits,
              `按批注：${Array.from(claimed.body).slice(0, 40).join("")}`, generated.runId ?? null, { query: q, annotationId: claimed.id });
            await q("UPDATE material_annotations SET status='applied',applied_version=$2,note=NULL,updated_at=now() WHERE id=$1", [claimed.id, edited.version]);
          }
          await q("RELEASE SAVEPOINT annotation_attempt");
          return;
        } catch (cause) {
          await q("ROLLBACK TO SAVEPOINT annotation_attempt");
          await q("RELEASE SAVEPOINT annotation_attempt");
          if (abort.signal.aborted) throw cause;
          note = cause instanceof ObjectMaterialError ? cause.message : "Co-Agent 修改失败，请重新批注后再试";
        }
      }
      await q("UPDATE material_annotations SET status='failed',note=$2,updated_at=now() WHERE id=$1", [claimed.id, note ?? "Co-Agent 修改失败，已达到重试次数"]);
    });
    return true;
  }

  function enqueue(id: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    requested.add(id);
    const existing = running.get(id);
    if (existing) return existing;
    const work = (async () => {
      do {
        requested.delete(id);
        while (!abort.signal.aborted && await processNext(id)) { /* Drain oldest first. */ }
      } while (!abort.signal.aborted && requested.has(id));
    })().catch((cause) => { if (!abort.signal.aborted) options.onError(cause); })
      .finally(() => { running.delete(id); if (requested.has(id) && !abort.signal.aborted) void enqueue(id); });
    running.set(id, work);
    return work;
  }
  async function recover(): Promise<void> {
    const rows = await pool.query(`SELECT DISTINCT material_id FROM material_annotations a WHERE status='queued'
      OR (status='applying' AND (updated_at < now()-interval '10 minutes' OR EXISTS(SELECT 1 FROM material_revisions r WHERE r.annotation_id=a.id)))`);
    for (const row of rows.rows) void enqueue(row.material_id);
  }
  return { enqueue, recover, async close() { abort.abort(new Error("material annotation queue closing")); await Promise.all(running.values()); } };
}
