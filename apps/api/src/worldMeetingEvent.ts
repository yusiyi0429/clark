import { createHash } from "node:crypto";
import type { TWorldAnchor } from "@warmap/contracts";
import { attendeesOf, decisionEffective, decisionStatement, type MeetingDecisionRow } from "./meetingDecisionView.js";
import type { MeetingRow, Query } from "./meetingStore.js";
import { WorldClient, WorldError, worldErrorCode, worldRef, type WorldAction, type WorldHead } from "./worldClient.js";

/**
 * 会议事件（回流设计稿 3.1；架构页「会议链：1 条会议事件（摘要 + 条目 + 挂点）」）：一场会在本体里记一条 category meeting 的外部事件。
 * - 正文是提炼：会议、时间、主持人、参会人、挂到哪、摘要、会上定了；原文留在天枢，artifacts 是会议页地址带 #sha256=<逐字稿摘要>。
 * - 挂点按组回退：取第一组里在本体对得上的对象（Mission 按 mission:<code>，责任单元按 capability:<code>，公司按实例配置或类型 Company）。
 * - 之后挂点、摘要、生效的决定变了记 correction；标了不写进本体记一条撤回（也是 correction）。
 */
export type ResolvedAnchors = { refs: string[]; sceneId: string; used: TWorldAnchor[] };
export type MeetingEventWrite = {
  meeting: Pick<MeetingRow, "id" | "title" | "scheduled_at">;
  text: string;
  /** 这一版内容的摘要（撤回时是 withdrawn）。 */
  digest: string;
  transcriptDigest: string;
  anchors: ResolvedAnchors;
  /** 这条链上最新的事件；有就记 correction。 */
  supersedesEventId: string | null;
};
export type MeetingEventWorld = {
  resolve(groups: TWorldAnchor[][]): Promise<ResolvedAnchors | null>;
  write(input: MeetingEventWrite): Promise<string>;
  errorCode(error: unknown): string;
};

const DECIDED_BY = { host: "Host 已确认", ceo: "CEO 已确认", agent: "Agent 代判，Host 尚未确认" } as const;
const KIND_LABEL = { lto: "长期目标", po: "本月目标", mission: "Mission", task: "Task", unit: "单元", company: "公司" } as const;
const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const transcriptDigest = (meeting: Pick<MeetingRow, "transcript">): string => sha(meeting.transcript?.turns ?? []).slice(0, 16);

/** 正文：头几行说清是哪场会、挂到哪；然后摘要和生效的决定（没定的不列）。 */
export function meetingEventText(meeting: MeetingRow, decisions: MeetingDecisionRow[], anchors: TWorldAnchor[], names: Map<string, string>): string {
  const name = (id: string) => meeting.participants.find((person) => person.personId === id)?.displayName ?? names.get(id) ?? id;
  const start = shanghai(new Date(meeting.scheduled_at));
  const end = shanghai(new Date(meeting.ends_at));
  const effective = decisions.filter(decisionEffective);
  return [
    `会议：${meeting.title}`,
    `时间：${start.slice(0, 10)} ${start.slice(11, 16)}–${end.slice(11, 16)}（北京时间）`,
    `主持人：${name(meeting.lead_dri_id)}`,
    `参会人：${attendeesOf(meeting).personIds.map(name).join("、")}`,
    `天枢会议：${meeting.id}`,
    `挂到：${anchors.map((anchor) => `${KIND_LABEL[anchor.kind]}「${anchor.title}」`).join("、")}`,
    "",
    "摘要：",
    meeting.outcome?.summary?.trim() || "（无）",
    ...(effective.length ? ["", "会上定了：", ...effective.map((row, index) =>
      `${index + 1}. ${decisionStatement(row)}（${DECIDED_BY[row.tier === "strategic" ? "ceo" : row.status === "agent_judged" ? "agent" : "host"]}）`)] : []),
  ].join("\n");
}

/** 内容摘要：挂点、摘要、逐字稿、生效的决定任一变了就要记 correction。 */
export function meetingEventDigest(meeting: MeetingRow, decisions: MeetingDecisionRow[], anchors: ResolvedAnchors): string {
  return sha({
    refs: anchors.refs, summary: meeting.outcome?.summary ?? "", transcript: transcriptDigest(meeting),
    decisions: decisions.filter(decisionEffective).map((row) => [row.id, decisionStatement(row), row.status]),
  }).slice(0, 16);
}

export function createMeetingEventWorld({ q, client, publicOrigin, now = () => new Date() }: { q: Query; client: WorldClient; publicOrigin: string; now?: () => Date }): MeetingEventWorld {
  const origin = publicOrigin.replace(/\/+$/, "");

  async function headOf(anchor: TWorldAnchor): Promise<WorldHead | null> {
    if (anchor.kind === "task") return null;
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

  return {
    async resolve(groups) {
      for (const group of groups) {
        const found: { head: WorldHead; anchor: TWorldAnchor }[] = [];
        for (const anchor of group) {
          const head = await headOf(anchor);
          if (head && !found.some((item) => item.head.object_id === head.object_id)) found.push({ head, anchor });
        }
        if (found.length) {
          return {
            refs: found.map((item) => worldRef(item.head)), sceneId: found[0].head.object_id,
            // 公司和单元用本体里的名字；Mission 用天枢里的名字（和卡上一致）。
            used: found.map(({ head, anchor }) => ({ ...anchor, title: anchor.kind === "mission" ? anchor.title : head.title || anchor.title })),
          };
        }
      }
      return null;
    },
    async write(input) {
      const key = `tianshu:meeting:${input.meeting.id}:${input.digest}${input.supersedesEventId ? `:${input.supersedesEventId.slice(-12)}` : ""}`;
      const receipt = await client.write(key, async () => {
        const scene = await client.getHead(input.anchors.sceneId);
        return {
          action_type: "world_record_event", contract_version: scene.contract_version, target: null, expected_versions: [], idempotency_key: key,
          reason: "天枢同步会议事件",
          params: {
            category: input.supersedesEventId ? "correction" : "meeting",
            subject_refs: input.anchors.refs,
            // 记下的时刻不能在未来：取会议开始和现在里早的那个。
            occurred_at: shanghai(new Date(Math.min(new Date(input.meeting.scheduled_at).getTime(), now().getTime() - 60_000))),
            content: { text: input.text, artifacts: [`${origin}/meetings/${input.meeting.id}#sha256=${input.transcriptDigest}`] },
            ...(input.supersedesEventId ? { supersedes_event_id: input.supersedesEventId } : {}),
            declaration: { scene: worldRef(scene), trigger: "天枢会议入本体", human_acceptance: { required: false } },
          },
        } satisfies WorldAction;
      });
      const eventId = receipt.result.event_id;
      if (!eventId) throw new WorldError(502, "INVALID_RESPONSE", "会议事件回执缺少 event_id");
      return eventId;
    },
    errorCode: worldErrorCode,
  };
}
