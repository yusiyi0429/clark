import type { Pool } from "pg";
import { getMeetingRow, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { requestDigest, WorldClient, WorldError, worldErrorCode, worldRef, type WorldAction, type WorldHead } from "./worldClient.js";
import { createWorldMissionLookup } from "./worldMissions.js";

export async function isEoMeeting(q: Query, meeting: Pick<MeetingRow, "lead_dri_id">): Promise<boolean> {
  const result = await q("SELECT owner_id FROM capability_config WHERE code = '05'");
  return result.rows.some((row) => row.owner_id && row.owner_id === meeting.lead_dri_id);
}

export async function selectMeetingSubjects(client: WorldClient, missionCodes: string[]): Promise<WorldHead[]> {
  const lookup = createWorldMissionLookup(client);
  const subjects = new Map<string, WorldHead>();
  for (const code of new Set(missionCodes)) {
    const mission = await lookup(code);
    if (mission) subjects.set(worldRef(mission), mission);
  }
  if (subjects.size) return [...subjects.values()];
  const unit = await client.byExternalRef("capability:05");
  if (!unit || unit.object_type !== "ResponsibilityUnit") throw new WorldError(409, "INVALID_STATE", "capability:05 未查回 E&O 责任单元");
  return [unit];
}

type MeetingSnapshot = { id: string; version: number; scheduledAt: string; text: string };
type MeetingDelivery = {
  id: string; meeting_id: string; meeting_version: number; snapshot: MeetingSnapshot;
  content_digest: string; status: "pending" | "committed" | "failed"; event_id: string | null;
};

export function meetingEventAction(snapshot: MeetingSnapshot, subjectHeads: Pick<WorldHead, "object_id" | "version" | "contract_version">[], publicOrigin: string, originalEventId?: string): WorldAction {
  const occurredAt = new Date(new Date(snapshot.scheduledAt).getTime() + 8 * 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
  const subjects = subjectHeads.map(worldRef);
  return {
    // 记外部事件没有目标；scope 整体切换契约，按首主体当前绑定的契约声明。
    action_type: "world_record_event", contract_version: subjectHeads[0].contract_version, target: null, expected_versions: [],
    idempotency_key: `tianshu:meeting:${snapshot.id}${originalEventId ? `:correction:${snapshot.version}` : ""}`,
    reason: "天枢同步会议纪要",
    params: {
      category: originalEventId ? "correction" : "meeting",
      subject_refs: subjects, occurred_at: occurredAt,
      content: { text: snapshot.text || "已确认的会议结论已全部撤回。", artifacts: [`${publicOrigin.replace(/\/+$/, "")}/meetings/${snapshot.id}`] },
      ...(originalEventId ? { supersedes_event_id: originalEventId } : {}),
      declaration: { scene: subjects[0], trigger: "天枢同步会议纪要", human_acceptance: { required: false } },
    },
  };
}

/** 单进程顺序发送；快照和请求分别持久化，网络失败只重放原键，不阻塞确认接口。 */
export function createWorldMeetingService(pool: Pool, client: WorldClient, publicOrigin: string, now = () => new Date()) {
  const q: Query = pool.query.bind(pool);
  let tail = Promise.resolve();
  let closed = false;
  const submit = (run: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(run).catch((error) => { logEvent({ event: "world.meeting", status: "failed", errorCode: worldErrorCode(error) }); });
  };
  async function drain() {
    const rows = await q("SELECT * FROM world_meeting_events WHERE instance = $1 AND status = 'pending' ORDER BY id", [client.instance]);
    for (const row of rows.rows as MeetingDelivery[]) {
      const history = await q("SELECT * FROM world_meeting_events WHERE instance = $1 AND meeting_id = $2 AND id < $3 ORDER BY id", [client.instance, row.meeting_id, row.id]);
      const previous = history.rows as MeetingDelivery[];
      if (previous.some((entry) => entry.status !== "committed")) continue;
      const last = previous.at(-1);
      if (last?.content_digest === row.content_digest) {
        await q("UPDATE world_meeting_events SET status = 'committed', event_id = $2 WHERE id = $1", [row.id, last.event_id]);
        continue;
      }
      // 会议开始时刻必须真实且不晚于写入；未来会议等到其开始后再发送，不伪造时刻。
      if (new Date(row.snapshot.scheduledAt) > now()) continue;
      try {
        const originalEventId = previous[0]?.event_id ?? undefined;
        const key = `tianshu:meeting:${row.meeting_id}${originalEventId ? `:correction:${row.meeting_version}` : ""}`;
        const receipt = await client.write(key, async () => {
          // 当前 Meeting 只有 issue_ids / origin_ref（issue、dri、manual），没有 Mission 关联。
          const subjects = await selectMeetingSubjects(client, []);
          return meetingEventAction(row.snapshot, subjects, publicOrigin, originalEventId);
        });
        if (!receipt.result.event_id) throw new WorldError(502, "INVALID_RESPONSE", "会议事件回执缺少 event_id");
        await q("UPDATE world_meeting_events SET status = 'committed', event_id = $2, error_code = NULL WHERE id = $1", [row.id, receipt.result.event_id]);
      } catch (error) {
        const code = worldErrorCode(error);
        await q("UPDATE world_meeting_events SET status = $2, error_code = $3 WHERE id = $1", [row.id, code === "NETWORK_ERROR" ? "pending" : "failed", code]);
        logEvent({ event: "world.meeting", objectRef: `meeting:${row.meeting_id}`, status: "failed", errorCode: code });
      }
    }
  }
  const timer = setInterval(() => submit(drain), 30_000);
  timer.unref();
  // 只重放此前已排队的确认，不扫描或补推历史会议。
  submit(drain);
  return {
    schedule(meetingId: string): void {
      submit(async () => {
        const meeting = await getMeetingRow(q, meetingId);
        if (!meeting || meeting.status !== "reviewed" || meeting.outcome?.status !== "ready" || !await isEoMeeting(q, meeting)) return;
        const text = meeting.outcome.items.filter((item) => item.review?.status === "confirmed").map((item) => item.text).join("\n");
        if (!text) {
          const previous = await q("SELECT 1 FROM world_meeting_events WHERE instance = $1 AND meeting_id = $2 LIMIT 1", [client.instance, meeting.id]);
          if (!previous.rowCount) return;
        }
        const snapshot: MeetingSnapshot = { id: meeting.id, version: meeting.version, scheduledAt: meeting.scheduled_at.toISOString(), text };
        await q(
          `INSERT INTO world_meeting_events (instance, meeting_id, meeting_version, snapshot, content_digest)
           VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (instance, meeting_id, meeting_version) DO NOTHING`,
          [client.instance, meeting.id, meeting.version, JSON.stringify(snapshot), requestDigest({ text, scheduledAt: snapshot.scheduledAt })],
        );
        await drain();
      });
    },
    retry(): void { submit(drain); },
    async idle(): Promise<void> { await tail; },
    async close(): Promise<void> { closed = true; clearInterval(timer); await tail; },
  };
}
