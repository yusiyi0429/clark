import type { TPreflightEvidenceRecord, TPreflightStaleInputs, TPreflightStaleMaterial } from "@warmap/contracts";

/**
 * 当前可见群输入的轻量快照：只有版本和讨论游标，不含正文。
 * 由 meetingStore 的 group_inputs 子查询或 meetingEvidence 的无正文读取产生，二者按同一权限规则取数。
 */
export type GroupInputVersions = {
  materials: { id: string; objectType: "meeting" | "issue"; objectId: string; fileName: string; version: number }[];
  discussionMaxId: number;
  /** 比 evidence.discussionMaxId 新的可见成员消息数；无快照时为全部可见消息数。 */
  newDiscussionCount: number;
};

/**
 * 报告所用输入与当前输入的差异：材料新版本、新增、删除，以及新的群讨论。
 * 没有差异返回 null。没有 evidence 记录的旧报告（H04 之前生成）视为未读过任何群材料。
 * 纯函数：不查库，不读正文；meetingStore 投影与 runPreflight 生成后检查共用。
 */
export function computeStaleInputs(
  evidence: TPreflightEvidenceRecord | undefined,
  current: GroupInputVersions,
): TPreflightStaleInputs | null {
  const used = new Map((evidence?.materials ?? []).map((material) => [material.id, material]));
  const materials: TPreflightStaleMaterial[] = [];
  for (const material of current.materials) {
    const before = used.get(material.id);
    if (!before) {
      materials.push({ id: material.id, fileName: material.fileName, objectType: material.objectType, objectId: material.objectId,
        usedVersion: null, currentVersion: material.version, change: "added" });
    } else if (before.version !== material.version) {
      materials.push({ id: material.id, fileName: material.fileName, objectType: material.objectType, objectId: material.objectId,
        usedVersion: before.version, currentVersion: material.version, change: "updated" });
    }
  }
  const currentIds = new Set(current.materials.map((material) => material.id));
  for (const before of evidence?.materials ?? []) {
    if (currentIds.has(before.id)) continue;
    materials.push({ id: before.id, fileName: before.fileName, objectType: before.objectType, objectId: before.objectId,
      usedVersion: before.version, currentVersion: null, change: "removed" });
  }
  const newDiscussionCount = evidence
    ? (current.discussionMaxId > evidence.discussionMaxId ? Math.max(current.newDiscussionCount, 1) : 0)
    : current.newDiscussionCount;
  if (!materials.length && newDiscussionCount === 0) return null;
  return { materials, newDiscussionCount };
}
