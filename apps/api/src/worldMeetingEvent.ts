import type { TMeetingCardConfirmation, TMeetingCardFrozenPayload, TMeetingCardKind, TWorldAnchor } from "@warmap/contracts";
import { payloadHash } from "./meetingCardHash.js";
import type { MeetingRow, Query } from "./meetingStore.js";
import { WorldClient, WorldError, worldErrorCode, worldRef, type WorldAction, type WorldHead } from "./worldClient.js";

/**
 * 会议事件（B 方案，D-58；会议卡 FR-5）：主持人或创建人整卡确认后，一个确认版本在本体里记一条外部事件。
 * - 正文 content.text 是 JSON.stringify({ payload, confirmation })，Card 和 Event 共用同一份结构；content 只放 text、refs、artifacts（拍板 13），
 *   artifacts 是来源地址去重。写入声明三项都带，trigger「会议记录整卡确认」，reason 写真实确认人的名字（confirmation.confirmedBy 是 personId）。
 * - first：category meeting，subject_refs 是 payload.relatedObjectRefs 去重，occurred_at 是会议实际开始。
 * - followup（会后新决定）：category meeting，content.refs 指回前次写成的事件，occurred_at 取确认时刻减 60 秒（服务端不收将来时刻）。
 * - 对象修改先写、事件最后写（斯一 10/21）：content.refs 再列这一版真正写成的修改 <对象>@<新版本>#<块>/<组件>；没写成的不列。
 * - correction（更正原记录）：category correction，supersedes_event_id 是前次写成的事件，subject_refs 和 occurred_at 沿用被更正那条
 *   （同步回执里记下的；更早写成、回执里没记的，退回台账里的原请求）。
 * - 前次没有写成的事件就按 first 写。幂等键 tianshu-meeting:<会议 ID>:v<revision>:event（10/21 起；更早写成的用的是不带 :event 的旧键）；
 *   结果未知时同键重放台账里的原请求（拍板 3）。
 * - 写完按挂点对象取事件读回：找到这条，正文解析出的 confirmation.payloadHash 和确认的一致、并且按解析出的 payload 重算也一致，才算写成。
 * - 任务最后一次仍连不上本体：台账记待核验（unverified），之后同键重放台账里的原请求核验（本体同键同请求体回原回执，不会多记一条）。
 * - v2（10/28 决策逐条确认）自动冻结的（confirmedBy 为 null）：trigger「会议决策逐条确认」（没有决策、只写记录时「会议记录生成」），reason 写逐条确认的人；
 *   主持人自己整卡确认的版本照旧「会议记录整卡确认」。
 *   记录正文不能写进本体时（recordText 为 false，等斯一答复）：事件里的 payload 去掉 summary 和 sections，只带已确认的决策和行动项（出处见各条的 sourceRefs 和原文链接），
 *   confirmation.payloadHash 换成事件里这份 payload 的摘要值（天枢存的确认版仍是全文的摘要值）。
 */
export type MeetingEventWrite = {
  meetingId: string;
  kind: TMeetingCardKind;
  payload: TMeetingCardFrozenPayload;
  confirmation: TMeetingCardConfirmation;
  /** 确认人的显示名（写进 reason；几个人时用顿号连）。 */
  confirmerName: string;
  /** 记录正文（摘要、正文段落）能不能写进本体；只对 v2 起作用。 */
  recordText?: boolean;
  /** 前次写成的会议事件（同一会议更早的确认版本）和它实际写进去的 subject_refs、occurred_at（没记下为 null）；没有前次就按 first 写。 */
  previous: { eventId: string; revision: number; subjectRefs: string[] | null; occurredAt: string | null } | null;
  /** 这一版真正写成的对象修改（writtenRevisionRefs）；没有为空。 */
  revisionRefs?: string[];
};
export type MeetingEventWorld = {
  /** 写入并读回；返回事件 id 和实际写进去的 subject_refs、occurred_at。 */
  write(input: MeetingEventWrite): Promise<{ eventId: string; subjectRefs: string[]; occurredAt: string }>;
  /** 这一版最近一次写入是网络错时台账改记待核验；返回这一版的幂等键。 */
  markUnverified(meetingId: string, revision: number): Promise<string>;
  errorCode(error: unknown): string;
};

const meetingEventKey = (meetingId: string, revision: number) => `tianshu-meeting:${meetingId}:v${revision}:event`;
/** 10/21 之前写成的会议事件用的键（更正时查它的台账）。 */
const legacyEventKey = (meetingId: string, revision: number) => `tianshu-meeting:${meetingId}:v${revision}`;
const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");

/** 逐字稿记下的实际开始：来自飞书妙记或录音时，它记下的开始时刻是实际开会时刻（transcriptCandidate 同一规则）；没有为 null。 */
export function recordedStart(meeting: Pick<MeetingRow, "transcript">): Date | null {
  const source = meeting.transcript?.source;
  const absolute = source && (source.format === "feishu_minutes" || source.format === "volc_asr") && source.timeAnchor;
  return absolute ? new Date(absolute) : null;
}

/** 读挂点要用的本体接口（会议卡用）。 */
export type AnchorHeadClient = Pick<WorldClient, "getHead" | "byExternalRef" | "listObjects" | "config">;

/** 挂点在本体里的对象：LTO、PO 按本体编号，Mission 按 mission:<code>，单元按 capability:<code>，公司按实例配置或类型 Company；对不上为 null。 */
export async function anchorHead(q: Query, client: AnchorHeadClient, anchor: TWorldAnchor): Promise<WorldHead | null> {
  if (anchor.kind === "task") return null;
  if (anchor.kind === "lto" || anchor.kind === "po") {
    // LTO、PO 存的就是本体编号（裁定 1）；本体里已经没有了就跳过，退到下一组。
    try {
      return await client.getHead(anchor.id);
    } catch (error) {
      if (error instanceof WorldError && error.status === 404) return null;
      throw error;
    }
  }
  if (anchor.kind === "mission") {
    const code = (await q("SELECT code FROM missions WHERE id = $1", [anchor.id])).rows[0]?.code as string | undefined;
    return code ? client.byExternalRef(`mission:${code}`) : null;
  }
  if (anchor.kind === "unit") {
    const code = (await q("SELECT code FROM capability_config WHERE id = $1", [anchor.id])).rows[0]?.code as string | undefined;
    return code ? client.byExternalRef(`capability:${code}`) : null;
  }
  const id = client.config.anchors?.company ?? (await client.listObjects({ type: "Company", limit: 1 }))[0]?.object_id;
  return id ? client.getHead(id) : null;
}

/** 读回的事件正文和确认的一致：confirmation.payloadHash 相同，并且按解析出的 payload 重算也相同；解析不了算不一致。 */
function readBackMatches(event: Record<string, unknown>, expected: string): boolean {
  const text = (event.content as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") return false;
  try {
    const parsed = JSON.parse(text) as { payload?: Record<string, unknown>; confirmation?: { payloadHash?: unknown } };
    return parsed.confirmation?.payloadHash === expected && Boolean(parsed.payload) && payloadHash(parsed.payload!) === expected;
  } catch {
    return false;
  }
}

export function createMeetingEventWorld({ client }: { client: WorldClient }): MeetingEventWorld {
  return {
    async write({ meetingId, kind: requested, payload, confirmation: confirmed, confirmerName, recordText = false, previous, revisionRefs = [] }) {
      const v2 = payload.schemaVersion === "meeting-card.v2";
      const withheld = v2 && !recordText;
      const { summary: _summary, sections: _sections, ...decisionsOnly } = payload;
      const eventPayload = withheld ? decisionsOnly : payload;
      const confirmation = withheld ? { ...confirmed, payloadHash: payloadHash(eventPayload) } : confirmed;
      // 主持人整卡确认的（v1，或冻结前后主持人自己确认的版本）照旧；自动冻结的按有没有已确认的决策。
      const trigger = confirmed.confirmedBy ? "会议记录整卡确认" : payload.decisions?.length ? "会议决策逐条确认" : "会议记录生成";
      const kind = previous ? requested : "first";
      let subjectRefs = [...new Set(payload.relatedObjectRefs)];
      let occurredAt = shanghai(new Date(payload.occurredAt!));
      if (kind === "correction") {
        // 沿用被更正那条实际写进去的：同步回执里记下的；没记下的（更早写成的）退回台账里的原请求。
        const ledger = previous!.subjectRefs?.length && previous!.occurredAt ? undefined
          : ((await client.savedRequest(meetingEventKey(meetingId, previous!.revision))) ?? (await client.savedRequest(legacyEventKey(meetingId, previous!.revision))))
            ?.params as { subject_refs?: string[]; occurred_at?: string } | undefined;
        const corrected = previous!.subjectRefs?.length ? previous!.subjectRefs : ledger?.subject_refs;
        if (corrected?.length) subjectRefs = corrected;
        occurredAt = previous!.occurredAt ?? ledger?.occurred_at ?? occurredAt;
      }
      if (kind === "followup") occurredAt = shanghai(new Date(new Date(confirmation.confirmedAt).getTime() - 60_000));
      const sceneId = subjectRefs[0]?.replace(/@\d+$/, "");
      if (!sceneId) throw new WorldError(409, "NO_SUBJECT", "会议事件没有挂点对象");
      const key = meetingEventKey(meetingId, payload.revision);
      const refs = [...(kind === "followup" ? [`event:${previous!.eventId}`] : []), ...revisionRefs];
      const receipt = await client.write(key, async () => {
        const scene = await client.getHead(sceneId);
        return {
          action_type: "world_record_event", contract_version: scene.contract_version, target: null, expected_versions: [], idempotency_key: key,
          reason: confirmerName ? `天枢${trigger}（${confirmerName}）` : `天枢${trigger}`,
          params: {
            category: kind === "correction" ? "correction" : "meeting",
            subject_refs: subjectRefs,
            occurred_at: occurredAt,
            ...(kind === "correction" ? { supersedes_event_id: previous!.eventId } : {}),
            content: {
              text: JSON.stringify({ payload: eventPayload, confirmation }),
              ...(refs.length ? { refs } : {}),
              artifacts: [...new Set(payload.sources.map((source) => source.url))],
            },
            declaration: { scene: worldRef(scene), trigger, human_acceptance: { required: false } },
          },
        } satisfies WorldAction;
      });
      const eventId = receipt.result.event_id;
      if (!eventId) throw new WorldError(502, "INVALID_RESPONSE", "会议事件回执缺少 event_id");
      const read = await client.getEvents(sceneId, occurredAt);
      const event = (read.events ?? read.items ?? []).find((item) => item.event_id === eventId);
      if (!event || !readBackMatches(event, confirmation.payloadHash)) {
        throw new WorldError(502, "READBACK_MISMATCH", "写入后在挂点对象上没读回这条会议事件，或正文摘要值对不上");
      }
      return { eventId, subjectRefs, occurredAt };
    },
    async markUnverified(meetingId, revision) {
      const key = meetingEventKey(meetingId, revision);
      await client.markUnverified(key);
      return key;
    },
    errorCode: worldErrorCode,
  };
}
