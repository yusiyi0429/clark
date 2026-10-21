import type { TMeetingCardDraft, TMeetingConfirmedObjectChange, TMeetingObjectChange, TMeetingObjectResult } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { WorldError, worldErrorCode, worldRef, type WorldClient, type WorldObject } from "./worldClient.js";

/**
 * 对象修改（FR-5.3、5.4）：一个确认版本的会议事件写成后，确认版里的修改按顺序各提交一次 world_revise_object，读回核对，回执逐条记在同步表 objects 里。
 * - 确认时就排好回执：上一版已改成、这次没动的沿用结果（appliedChanges）；目标未定（或改后内容为空）的 blocked，选了不写入的 blocked「不写入」，其余 pending；
 *   新版确认后旧版还 pending 的改 superseded。
 * - 以天枢服务主体提交（本期不代人），声明的 scene 是目标对象，trigger「会议记录整卡确认」，不要求人工验收；正式块要不要验收、有没有权限由本体判。
 * - target 用对象当前 revision_id 和冻结的 expectedVersion；同一确认版里前面的修改已经把同一对象改成新版本的，接着那个版本提交（天枢自己的修改不算冲突）。
 *   本体上的版本已经不是期望的版本就不提交，直接按冲突记。
 * - 提交成功后取对象读回，组件文字等于改后内容才算 updated；改出的版本（actualVersion，也是同一对象下一条接着提交的版本）取回执的 object_versions，
 *   不取读回时的版本（提交和读回之间别人的修改不能被接上覆盖）。改成后当前草稿跟上这次的结果，不显示「目标已变」。冲突记「目标已变」，并让当前草稿按对象当前值刷新重看；403 和状态、契约不允许记 not_allowed；
 *   其他错误记 failed 和错误码。网络错误抛出交给任务按原幂等键重跑，任务最后一次仍是网络错误时记 failed。本期不提供失败项重试（拍板 5）。
 */
export type MeetingObjectWorld = Pick<WorldClient, "write" | "getObject">;

const TRIGGER = "会议记录整卡确认";
const objectKey = (meetingId: string, revision: number, changeId: string) => `tianshu-meeting:${meetingId}:v${revision}:obj:${changeId}`;
const NOT_ALLOWED = new Set(["INVALID_STATE", "PROTOCOL_BINDING_CONFLICT"]);
const ERROR_LABELS: Record<string, string> = {
  NETWORK_ERROR: "连不上本体", READBACK_MISMATCH: "读回不一致", VERSION_CONFLICT: "目标已变", INVALID_STATE: "对象状态不允许", PROTOCOL_BINDING_CONFLICT: "契约版本不对",
};
/** 回执里给人看的短标签（会议事件和对象修改共用）；本体的原话只进日志，没列的错误码都记「写入失败」。 */
export const worldErrorLabel = (code: string) => ERROR_LABELS[code] ?? "写入失败";

/** 已改成的修改：同一处修改（id、目标、改后文字都相同）→ 改成时的回执；不是的为 undefined。 */
export type AppliedChanges = (change: Pick<TMeetingObjectChange, "id" | "targetRef" | "after">) => TMeetingObjectResult | undefined;
const appliedKey = (change: Pick<TMeetingObjectChange, "id" | "targetRef" | "after">) => JSON.stringify([change.id, change.targetRef, change.after.text]);
/**
 * 当前确认版里已改成（回执 updated）的修改。新版确认时同一处修改沿用回执、不再提交（不覆盖之后别人的改动、不发空修订）；
 * 读卡和存草稿也不再按对象版本把它标成目标已变、不挪它的基准。改后文字改过的不算，照常提交。
 */
export function appliedChanges(current: { payload: { objectChanges: TMeetingConfirmedObjectChange[] }; objects: TMeetingObjectResult[] } | null): AppliedChanges {
  const applied = new Map<string, TMeetingObjectResult>();
  current?.payload.objectChanges.forEach((change, index) => {
    if (change.targetRef && current.objects[index]?.status === "updated") applied.set(appliedKey(change), current.objects[index]);
  });
  return (change) => applied.get(appliedKey(change));
}

/** 确认时排好的回执；上一版已改成的同一处修改沿用结果（已更新、同一个实际版本）。 */
export function initialObjectResults(changes: TMeetingConfirmedObjectChange[], writeToWorld: boolean, applied: AppliedChanges = () => undefined): TMeetingObjectResult[] {
  return changes.map((change) => {
    const carried = applied(change);
    if (carried) return { changeId: change.id, title: change.targetTitle ?? "", status: "updated", actualVersion: carried.actualVersion, error: null };
    const error = !writeToWorld ? "不写入" : !change.targetRef ? "目标未定" : !change.after.text.trim() ? "改后内容为空" : null;
    return { changeId: change.id, title: change.targetTitle ?? "", status: error ? "blocked" : "pending", actualVersion: null, error };
  });
}

/** 新版确认后：更早版本还 pending 的修改作废（已提交的结果保留）。一条 UPDATE 改整行，和逐条写回执互不覆盖。 */
export async function supersedeObjects(q: Query, meetingId: string, revision: number): Promise<void> {
  await q(
    `UPDATE meeting_card_syncs SET objects = (
        SELECT jsonb_agg(CASE WHEN item->>'status' = 'pending' THEN item || '{"status":"superseded"}'::jsonb ELSE item END ORDER BY position)
          FROM jsonb_array_elements(objects) WITH ORDINALITY AS t(item, position)), updated_at = now()
      WHERE meeting_id = $1 AND revision < $2 AND objects @> '[{"status":"pending"}]'::jsonb`,
    [meetingId, revision],
  );
}

/** 组件当前文字（<块 id>/<组件 id>）。 */
function componentOf(object: WorldObject, blockId: string, componentId: string): { type: string; text?: string } | undefined {
  const blocks = (object.business as { blocks?: { id: string; components?: { id?: string; type: string; text?: string }[] }[] }).blocks ?? [];
  return blocks.find((block) => block.id === blockId)?.components?.find((item) => item.id === componentId);
}

export function createMeetingObjectSync({ q, world, refreshDraft }: {
  q: Query;
  world: MeetingObjectWorld;
  /** 冲突后让当前草稿按对象当前值刷新（标 stale、草稿版本加一）。 */
  refreshDraft: (meetingId: string) => Promise<void>;
}) {
  /** 写回一条回执（按位置改这一项，不碰别的项）。 */
  const record = (meetingId: string, revision: number, index: number, result: TMeetingObjectResult) =>
    q(`UPDATE meeting_card_syncs SET objects = jsonb_set(objects, ARRAY[$3::text], $4::jsonb), updated_at = now() WHERE meeting_id = $1 AND revision = $2`,
      [meetingId, revision, index, JSON.stringify(result)]);
  const stillPending = async (meetingId: string, revision: number, index: number) =>
    (await q("SELECT objects->$3::int->>'status' AS status FROM meeting_card_syncs WHERE meeting_id = $1 AND revision = $2", [meetingId, revision, index])).rows[0]?.status === "pending";

  /** 提交一条修改并读回文字；返回回执里这次改出的对象版本（回执没给为 null）。 */
  async function revise(meetingId: string, revision: number, change: TMeetingConfirmedObjectChange, expectedVersion: number): Promise<number | null> {
    const at = change.targetRef!.indexOf("#");
    const objectId = change.targetRef!.slice(0, at);
    const [blockId, componentId] = change.targetRef!.slice(at + 1).split("/");
    const key = objectKey(meetingId, revision, change.id);
    const receipt = await world.write(key, async () => {
      const object = await world.getObject(objectId);
      const component = componentOf(object, blockId, componentId);
      if (object.business.object_version !== expectedVersion || !component) throw new WorldError(409, "VERSION_CONFLICT", "目标已变");
      return {
        action_type: "world_revise_object", contract_version: object.protocol.contract_version,
        target: { object_id: objectId, revision_id: object.business.revision_id, expected_version: expectedVersion }, expected_versions: [],
        idempotency_key: key, reason: `天枢${TRIGGER}`,
        params: {
          payload: { blocks: { [blockId]: { components: [{ id: componentId, type: component.type, text: change.after.text }] } } },
          declaration: { scene: worldRef(object.business), trigger: TRIGGER, human_acceptance: { required: false } },
        },
      };
    });
    const read = await world.getObject(objectId);
    if (componentOf(read, blockId, componentId)?.text !== change.after.text) throw new WorldError(502, "READBACK_MISMATCH", "读回不一致");
    return receipt.object_versions?.find((item) => item.object_id === objectId)?.object_version ?? null;
  }

  /**
   * 改成以后当前草稿跟上（不加草稿版本，只动服务填的字段，记录状态不因此变成修改待确认）：
   * 目标在这个对象上、基于提交前版本的修改，版本换成改出的版本；同一组件的原内容换成改后内容；同一条修改不再标 stale。
   * 读卡已经把同一条修改刷到改出的版本、标了 stale（刷的就是这次提交）的，也清掉 stale、原内容换成改后内容。
   * 草稿版本在读和写之间变了（有人刚存过、读卡刚刷新）就重读再来，最多 3 次；还不行记日志，交给读卡时按版本刷新。
   */
  async function rebaseline(meetingId: string, change: TMeetingConfirmedObjectChange, objectId: string, from: number, to: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = (await q("SELECT draft, draft_version FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
        { draft: TMeetingCardDraft | null; draft_version: number } | undefined;
      if (!row?.draft) return;
      let changed = false;
      const changes = row.draft.objectChanges.map((item) => {
        if (!item.targetRef?.startsWith(`${objectId}#`)) return item;
        const same = item.targetRef === change.targetRef;
        const own = same && item.id === change.id;
        if (item.expectedVersion === from) {
          changed = true;
          return { ...item, expectedVersion: to, ...(same ? { before: { text: change.after.text } } : {}), ...(own ? { stale: false } : {}) };
        }
        if (own && item.expectedVersion === to && (item.stale || item.before?.text !== change.after.text)) {
          changed = true;
          return { ...item, before: { text: change.after.text }, stale: false };
        }
        return item;
      });
      if (!changed) return;
      const updated = await q("UPDATE meeting_cards SET draft = jsonb_set(draft, '{objectChanges}', $3::jsonb), updated_at = now() WHERE meeting_id = $1 AND draft_version = $2",
        [meetingId, row.draft_version, JSON.stringify(changes)]);
      if (updated.rowCount) return;
    }
    logEvent({ event: "meeting.world_object_rebaseline", objectRef: `meeting:${meetingId}`, status: "skipped", errorCode: "DRAFT_CHANGED" });
  }

  /** 按顺序提交这一版还 pending 的修改。lastAttempt：任务最后一次重跑，网络错误也记失败。 */
  async function run(meetingId: string, revision: number, changes: TMeetingConfirmedObjectChange[], results: TMeetingObjectResult[], lastAttempt: boolean): Promise<void> {
    // 同一对象：冻结的版本 → 天枢这一版前面的修改改出来的版本（只取回执里的；回执没给就不接，后面的修改按冻结版本提交、过不了版本核对）。
    const own = new Map<string, { from: number; to: number }>();
    for (const [index, change] of changes.entries()) {
      const result = results[index];
      const objectId = change.targetRef?.slice(0, change.targetRef.indexOf("#")) ?? "";
      // 沿用上一版结果的（实际版本不比冻结的新）不是这一版改的，不接。
      if (result.status === "updated" && result.actualVersion !== null && change.expectedVersion !== null && result.actualVersion > change.expectedVersion) {
        own.set(objectId, { from: change.expectedVersion, to: result.actualVersion });
      }
      if (result.status !== "pending" || !await stillPending(meetingId, revision, index)) continue;
      const chained = own.get(objectId);
      const expected = chained && chained.from === change.expectedVersion ? chained.to : change.expectedVersion!;
      let next: TMeetingObjectResult;
      let code: string | undefined;
      let message: string | undefined;
      try {
        const actualVersion = await revise(meetingId, revision, change, expected);
        if (actualVersion !== null) own.set(objectId, { from: change.expectedVersion!, to: actualVersion });
        next = { ...result, status: "updated", actualVersion, error: null };
      } catch (error) {
        code = worldErrorCode(error);
        if (code === "NETWORK_ERROR" && !lastAttempt) throw error;
        const status = error instanceof WorldError ? error.status : 0;
        next = code === "VERSION_CONFLICT" ? { ...result, status: "conflict", error: worldErrorLabel(code) }
          : status === 403 ? { ...result, status: "not_allowed", error: "没有修改权限" }
          : NOT_ALLOWED.has(code) ? { ...result, status: "not_allowed", error: worldErrorLabel(code) }
          : { ...result, status: "failed", error: worldErrorLabel(code) };
        message = error instanceof Error ? error.message : undefined;
      }
      await record(meetingId, revision, index, next);
      logEvent({ event: "meeting.world_object", objectRef: `meeting:${meetingId}`, status: next.status, errorCode: code, message });
      if (next.status === "conflict") await refreshDraft(meetingId);
      if (next.status === "updated" && next.actualVersion !== null) await rebaseline(meetingId, change, objectId, expected, next.actualVersion);
    }
  }

  return { run };
}

export type MeetingObjectSync = ReturnType<typeof createMeetingObjectSync>;
