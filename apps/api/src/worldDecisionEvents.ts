import type { Query } from "./meetingStore.js";
import { isEoMeeting, selectMeetingSubjects } from "./worldMeetingEvents.js";
import { WorldClient, WorldError, worldErrorCode, worldRef, type WorldAction, type WorldHead } from "./worldClient.js";

/**
 * 写本体（方案 A）：一条会后决定记一条外部事件（category meeting），subject_refs 指到受影响的对象——
 * Task 在 Mission 执行计划里有组件（id todo:<执行事项 id>）时指到那个组件，否则指到 Task / Mission 对象；
 * 一个都对不上时，E&O 的会退回 E&O 责任单元，其他会不写（skipped）。
 * 正文第一行写明谁拍的板（「Host 已确认」「CEO 已确认」「Agent 代判，Host 尚未确认」）；主持人之后改判，记一条 correction，supersedes 原事件。
 * 写入复用 WorldClient：按对象当前契约声明 0.2 / 0.3，prepare → commit，幂等键与台账在 world_sync_ledger。
 */
export type DecisionEventInput = {
  decision: { id: string; revision: number; statement: string; decidedBy: "host" | "ceo" | "agent"; quote: string | null; speaker: string | null };
  meeting: { id: string; title: string; scheduledAt: Date; leadDriId: string };
  /** 受影响的对象（来自这一版的影响卡）。 */
  targets: { type: "task" | "mission" | "acceptance"; id: string }[];
  /** 上一版事件；有就记 correction。 */
  supersedesEventId: string | null;
  /** 改判说明（correction 才有）。 */
  correctionNote: string | null;
  /** 这一版不再生效（主持人确认其实没定）。 */
  withdrawn: boolean;
};
export type DecisionEventResult = { status: "committed"; eventId: string } | { status: "skipped" };

const DECIDED_BY = { host: "Host 已确认", ceo: "CEO 已确认", agent: "Agent 代判，Host 尚未确认" } as const;
const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");

type ObjectBlocks = { business: { blocks?: { id: string; components?: { id?: string }[] }[] } };

export function createDecisionWorldSync({ q, client, publicOrigin, now = () => new Date() }: { q: Query; client: WorldClient; publicOrigin: string; now?: () => Date }) {
  const origin = publicOrigin.replace(/\/+$/, "");

  /** 受影响对象 → 本体引用（组件形式优先）与声明里的场景对象。 */
  async function subjects(input: DecisionEventInput): Promise<{ refs: string[]; scene: WorldHead } | null> {
    const refs: string[] = [];
    let scene: WorldHead | null = null;
    const taskIds = [...new Set(input.targets.filter((target) => target.type !== "mission").map((target) => target.id))];
    const missionIds = [...new Set(input.targets.filter((target) => target.type === "mission").map((target) => target.id))];
    for (const taskId of taskIds) {
      const row = (await q("SELECT m.code FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id WHERE t.id::text = $1", [taskId])).rows[0] as { code: string | null } | undefined;
      const mission = row?.code ? await client.byExternalRef(`mission:${row.code}`) : null;
      if (mission) {
        const object = await client.getObject(mission.object_id) as unknown as ObjectBlocks;
        const block = (object.business.blocks ?? []).find((item) => (item.components ?? []).some((component) => component.id === `todo:${taskId}`));
        if (block) {
          refs.push(`${worldRef(mission)}#${block.id}/todo:${taskId}`);
          scene ??= mission;
          continue;
        }
      }
      const task = await client.byExternalRef(`todo:${taskId}`);
      if (task) { refs.push(worldRef(task)); scene ??= task; continue; }
      if (mission) { refs.push(worldRef(mission)); scene ??= mission; }
    }
    for (const missionId of missionIds) {
      const code = (await q("SELECT code FROM missions WHERE id = $1", [missionId])).rows[0]?.code as string | undefined;
      const mission = code ? await client.byExternalRef(`mission:${code}`) : null;
      if (mission) { refs.push(worldRef(mission)); scene ??= mission; }
    }
    if (scene) return { refs: [...new Set(refs)], scene };
    if (!await isEoMeeting(q, { lead_dri_id: input.meeting.leadDriId })) return null;
    const [unit] = await selectMeetingSubjects(client, []);
    return { refs: [worldRef(unit)], scene: unit };
  }

  return {
    async record(input: DecisionEventInput): Promise<DecisionEventResult> {
      const found = await subjects(input);
      if (!found) return { status: "skipped" };
      const key = `tianshu:meeting-decision:${input.decision.id}:${input.decision.revision}`;
      const lines = [
        input.withdrawn ? "Host 已确认：会上其实没定" : DECIDED_BY[input.decision.decidedBy],
        `会上定了：${input.decision.statement}`,
        ...(input.correctionNote ? [`更正：${input.correctionNote}`] : []),
        `会议：${input.meeting.title}（${shanghai(input.meeting.scheduledAt).slice(0, 16).replace("T", " ")}）`,
        ...(input.decision.quote ? [`原话（${input.decision.speaker ?? "参会人"}）：「${input.decision.quote.slice(0, 300)}」`] : []),
      ];
      const receipt = await client.write(key, async () => {
        // 重建请求时（版本过期、契约升级）重新取引用，版本号跟着当前对象走。
        const fresh = (await subjects(input)) ?? found;
        const scene = await client.getHead(fresh.scene.object_id);
        return {
          action_type: "world_record_event", contract_version: scene.contract_version, target: null, expected_versions: [], idempotency_key: key,
          reason: "天枢同步会后决定",
          params: {
            category: input.supersedesEventId ? "correction" : "meeting",
            subject_refs: fresh.refs,
            // 记下的时刻不能在未来：取会议开始和现在里早的那个。
            occurred_at: shanghai(new Date(Math.min(input.meeting.scheduledAt.getTime(), now().getTime() - 60_000))),
            content: { text: lines.join("\n"), artifacts: [`${origin}/meetings/${input.meeting.id}`] },
            ...(input.supersedesEventId ? { supersedes_event_id: input.supersedesEventId } : {}),
            declaration: { scene: worldRef(scene), trigger: "天枢会后决定生效", human_acceptance: { required: false } },
          },
        } satisfies WorldAction;
      });
      const eventId = receipt.result.event_id;
      if (!eventId) throw new WorldError(502, "INVALID_RESPONSE", "会后决定事件回执缺少 event_id");
      return { status: "committed", eventId };
    },
    errorCode: worldErrorCode,
  };
}
export type DecisionWorldSync = ReturnType<typeof createDecisionWorldSync>;
