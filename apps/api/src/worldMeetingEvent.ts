import { isDeepStrictEqual } from "node:util";
import type { TWorldAnchor } from "@warmap/contracts";
import { attendeesOf, decisionEffective, decisionStatement, type MeetingDecisionRow } from "./meetingDecisionView.js";
import type { MeetingRow, Query } from "./meetingStore.js";
import { WorldClient, WorldError, worldErrorCode, worldRef, type WorldAction, type WorldHead } from "./worldClient.js";

/**
 * 会议事件（B 方案，D-58）：主持人或创建人整卡确认后，一场会在本体里记一条 category meeting 的外部事件；之后修改要重新确认，另记一条。
 * - 正文是整份记录：会议名、实际起止、主持人、参会人、摘要、条目（决定、分歧、待办、变更提议）、确认人和时间、天枢会议 ID、确认版本；
 *   第 2 版起开头写明接前次哪条事件、改了什么、原因。原文不进正文，artifacts 是飞书妙记链接。
 * - 字段照斯一 10/20：幂等键 tianshu-meeting:<会议 ID>:v<确认版本>；写入声明三项都带；content.refs 指回前次事件；
 *   occurred_at 是实际开始时刻（带时区）；不带契约外的字段。
 * - 挂点按组回退：取第一组里在本体对得上的对象（LTO、PO 按本体编号，Mission 按 mission:<code>，单元按 capability:<code>，公司按实例配置或类型 Company）。
 * - 写完按挂点对象取事件读回，找到这条才算写入。
 */
export type MeetingRecord = {
  title: string;
  /** 实际起止（ISO）：开始取飞书妙记或录音记下的开始时刻，没有就是计划开始；结束取「结束会议」的时刻，没有就是计划结束。 */
  startedAt: string;
  endedAt: string;
  host: string;
  attendees: string[];
  summary: string;
  decisions: string[];
  disagreements: string[];
  todos: string[];
  /** 变更提议（Task 7 填，每条一行）。 */
  proposals: string[];
  /** 挂点候选：建会选的 → 主持人负责的单元 → 公司。 */
  anchors: TWorldAnchor[][];
};

export type MeetingEventWrite = {
  meetingId: string;
  /** 确认版本。 */
  version: number;
  text: string;
  occurredAt: Date;
  anchorGroups: TWorldAnchor[][];
  /** 最近一次写进去的会议事件；有就在 content.refs 里指回它。 */
  previousEventId: string | null;
  minuteToken: string | null;
};
export type MeetingEventWorld = {
  /** 写入并读回；返回事件 id 和实际挂上的对象（界面展示用）。 */
  write(input: MeetingEventWrite): Promise<{ eventId: string; anchors: TWorldAnchor[] }>;
  errorCode(error: unknown): string;
};

const PART_LABEL: [keyof MeetingRecord | "time", string][] = [
  ["title", "会议名"], ["time", "起止"], ["host", "主持人"], ["attendees", "参会人"], ["summary", "摘要"], ["decisions", "决定"],
  ["disagreements", "分歧"], ["todos", "待办"], ["proposals", "变更提议"], ["anchors", "挂点"],
];
const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
const minute = (at: Date) => shanghai(at).slice(0, 16).replace("T", " ");

/** 实际开始：逐字稿来自飞书妙记或录音时，它记下的开始时刻是实际开会时刻（transcriptCandidate 同一规则）。 */
function actualStart(meeting: Pick<MeetingRow, "transcript" | "scheduled_at">): Date {
  const source = meeting.transcript?.source;
  const absolute = source && (source.format === "feishu_minutes" || source.format === "volc_asr") && source.timeAnchor;
  return absolute ? new Date(absolute) : new Date(meeting.scheduled_at);
}

/** 这场会现在的记录（只读天枢）：整卡确认时存下，写入时照它写。 */
export function meetingRecord(meeting: MeetingRow, decisions: MeetingDecisionRow[], anchors: TWorldAnchor[][], names: Map<string, string>): MeetingRecord {
  const name = (id: string) => meeting.participants.find((person) => person.personId === id)?.displayName ?? names.get(id) ?? id;
  const items = (meeting.outcome?.items ?? []).filter((item) => item.review?.status !== "dismissed");
  return {
    title: meeting.title,
    startedAt: actualStart(meeting).toISOString(),
    endedAt: new Date(meeting.ended_at ?? meeting.ends_at).toISOString(),
    host: name(meeting.lead_dri_id),
    attendees: attendeesOf(meeting).personIds.map(name),
    summary: meeting.outcome?.summary?.trim() ?? "",
    decisions: decisions.filter(decisionEffective).map((row) => `${decisionStatement(row)}${row.tier === "strategic" ? "（CEO 已确认）" : ""}`),
    disagreements: items.filter((item) => item.kind === "open").map((item) => item.text),
    todos: items.filter((item) => item.kind === "todo").map((item) => {
      const note = [item.ownerPersonId ? name(item.ownerPersonId) : null, item.dueDate ? `${item.dueDate} 前` : null].filter(Boolean).join("，");
      return note ? `${item.text}（${note}）` : item.text;
    }),
    proposals: [],
    anchors,
  };
}

export const sameRecord = (a: MeetingRecord, b: MeetingRecord): boolean => isDeepStrictEqual(a, b);

/** 和前次写进去的那份比，改了哪几部分。 */
export function changedParts(previous: MeetingRecord, next: MeetingRecord): string[] {
  return PART_LABEL.filter(([key]) => key === "time"
    ? previous.startedAt !== next.startedAt || previous.endedAt !== next.endedAt
    : !isDeepStrictEqual(previous[key], next[key])).map(([, label]) => label);
}

/** 正文（以后改口只动这里）。previous：第 2 版起接前次哪条、改了什么、原因。 */
export function meetingEventText(record: MeetingRecord, meta: {
  meetingId: string; version: number; confirmedBy: string; confirmedAt: Date;
  previous: { eventId: string; changed: string[]; reason: string | null } | null;
}): string {
  const start = new Date(record.startedAt);
  const end = new Date(record.endedAt);
  const sameDay = minute(start).slice(0, 10) === minute(end).slice(0, 10);
  const lines: string[] = [];
  if (meta.previous) {
    lines.push(`修改：第 ${meta.version} 版，接前次事件 ${meta.previous.eventId}`);
    if (meta.previous.changed.length) lines.push(`改了：${meta.previous.changed.join("、")}`);
    if (meta.previous.reason) lines.push(`原因：${meta.previous.reason}`);
    lines.push("");
  }
  lines.push(
    `会议：${record.title}`,
    `时间：${minute(start)}–${sameDay ? minute(end).slice(11) : minute(end)}（北京时间）`,
    `主持人：${record.host}`,
    `参会人：${record.attendees.join("、")}`,
    "", "摘要：", record.summary || "（无）",
  );
  const sections: [string, string[]][] = [["决定", record.decisions], ["分歧", record.disagreements], ["待办", record.todos], ["变更提议", record.proposals]];
  for (const [label, entries] of sections) {
    if (entries.length) lines.push("", `${label}：`, ...entries.map((entry, index) => `${index + 1}. ${entry}`));
  }
  lines.push("", `确认：${meta.confirmedBy} ${minute(meta.confirmedAt)}（北京时间）`, `天枢会议：${meta.meetingId}`, `确认版本：v${meta.version}`);
  return lines.join("\n");
}

export function createMeetingEventWorld({ q, client, feishuWebOrigin }: { q: Query; client: WorldClient; feishuWebOrigin?: string }): MeetingEventWorld {
  const feishu = feishuWebOrigin?.replace(/\/+$/, "");

  async function headOf(anchor: TWorldAnchor): Promise<WorldHead | null> {
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

  async function resolve(groups: TWorldAnchor[][]) {
    for (const group of groups) {
      const found: { head: WorldHead; anchor: TWorldAnchor }[] = [];
      for (const anchor of group) {
        const head = await headOf(anchor);
        if (head && !found.some((item) => item.head.object_id === head.object_id)) found.push({ head, anchor });
      }
      if (found.length) {
        return {
          refs: found.map((item) => worldRef(item.head)), sceneId: found[0].head.object_id,
          // Mission 用天枢里的名字（和卡上一致），其余用本体里的名字。
          used: found.map(({ head, anchor }) => ({ ...anchor, title: anchor.kind === "mission" ? anchor.title : head.title || anchor.title })),
        };
      }
    }
    return null;
  }

  return {
    async write(input) {
      const anchors = await resolve(input.anchorGroups);
      if (!anchors) throw new WorldError(409, "NO_ANCHOR", "挂点在本体里一个都对不上");
      const key = `tianshu-meeting:${input.meetingId}:v${input.version}`;
      const occurredAt = shanghai(input.occurredAt);
      const receipt = await client.write(key, async () => {
        const scene = await client.getHead(anchors.sceneId);
        return {
          action_type: "world_record_event", contract_version: scene.contract_version, target: null, expected_versions: [], idempotency_key: key,
          reason: "天枢会议记录确认",
          params: {
            category: "meeting",
            // Task 7：确认后的修改目标（带版本的引用）追加在这里。
            subject_refs: anchors.refs,
            occurred_at: occurredAt,
            content: {
              text: input.text,
              artifacts: feishu && input.minuteToken ? [`${feishu}/minutes/${encodeURIComponent(input.minuteToken)}`] : [],
              // Task 7：被修改组件的引用（<对象 id>@<版本>#<块 id>/<组件 id>）追加在这里。
              ...(input.previousEventId ? { refs: [`event:${input.previousEventId}`] } : {}),
            },
            declaration: { scene: worldRef(scene), trigger: "天枢会议记录确认", human_acceptance: { required: false } },
          },
        } satisfies WorldAction;
      });
      const eventId = receipt.result.event_id;
      if (!eventId) throw new WorldError(502, "INVALID_RESPONSE", "会议事件回执缺少 event_id");
      const read = await client.getEvents(anchors.sceneId, occurredAt);
      if (!(read.events ?? read.items ?? []).some((event) => event.event_id === eventId)) {
        throw new WorldError(502, "READBACK_MISMATCH", "写入后在挂点对象上没读回这条会议事件");
      }
      return { eventId, anchors: anchors.used };
    },
    errorCode: worldErrorCode,
  };
}
