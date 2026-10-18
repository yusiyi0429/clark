import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { citationsIn } from "./personalReviewGeneration.js";
import { CITATION_SCHEME } from "./sourceCitations.js";
import { addDays, getWeeklyReviewRow, weeklyReviewHref, type WeeklyReviewRow } from "./weeklyReviews.js";
import {
  WorldClient, WorldError, worldErrorCode, worldRef,
  type WorldAction, type WorldHead, type WorldReadComponent, type WorldStateSnapshot,
} from "./worldClient.js";

/**
 * 周复盘提交后写本体（D-01）：按「关键进展与 Evidence」一段里引用到的 Task、Mission，各记一条外部事件，再写一条引用它的执行状态快照。
 * 只写进展和证据链接，不写全文。快照是对象的完整状态：上一条快照里别人的组件、问题、材料原样带上，只换本人的周复盘条目 weekly:<personId>。
 * Mission 按外部引用 mission:<编号> 找，Task 按 todo:<执行事项 id> 找；本体里没有的记 skipped。
 * 写入复用 WorldClient（按对象当前契约声明 0.2 / 0.3，prepare → commit，幂等键与台账在 world_sync_ledger）。
 */

type Target = { key: string; kind: "mission" | "task"; externalId: string; lines: string[]; links: string[]; status: string };
export type WorldSyncResult = { target: string; status: "committed" | "skipped" | "failed" | "pending"; code?: string; eventId?: string; snapshotRef?: string };

const TASK_STATUS: Record<string, string> = { not_started: "未开始", in_progress: "进行中", done: "已完成", returned: "已退回" };
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
/** 去掉出处标记，只留句子。 */
const plain = (line: string) => line.replace(LINK, "").trim().replace(/^(?:[-*•]\s+|\d+[.、)]\s*(?=\D))/, "").trim();
const http = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//.test(url) && url.length <= 2000;
const linksOf = (value: unknown): string[] => Array.isArray(value) ? value.map((item) => (item as { url?: unknown })?.url).filter(http) : [];
/** 上海时间、精确到秒、带 +08:00。 */
const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");

/** 「关键进展与 Evidence」里每一行引用到的 Task、Mission，以及每个对象对应的那几行和证据链接。 */
export async function weeklyReviewTargets(q: Query, row: WeeklyReviewRow): Promise<Target[]> {
  const targets = new Map<string, Target>();
  const add = (kind: Target["kind"], externalId: string, status: string, line: string, links: string[]) => {
    const key = `${kind}:${externalId}`;
    const target = targets.get(key) ?? { key, kind, externalId, lines: [], links: [], status };
    if (!target.lines.includes(line)) target.lines.push(line);
    for (const link of links) if (!target.links.includes(link)) target.links.push(link);
    targets.set(key, target);
  };
  const missionOf = async (id: string | null) => id ? (await q("SELECT code FROM missions WHERE id=$1", [id])).rows[0]?.code as string | undefined : undefined;
  for (const raw of (row.body?.progress.text ?? "").split("\n")) {
    const line = plain(raw);
    if (!line) continue;
    for (const href of citationsIn(raw)) {
      if (!href.startsWith(CITATION_SCHEME)) continue;
      const [kind, id] = [href.slice(CITATION_SCHEME.length).split(":")[0], href.slice(CITATION_SCHEME.length).split(":").slice(1).join(":")];
      let task: { id: string; status: string; mission_id: string | null } | undefined, links: string[] = [], missionId: string | null = null;
      if (kind === "progress") {
        const found = (await q(`SELECT t.id::text AS id, t.status, t.mission_id, p.links FROM task_progress p JOIN tasks t ON t.id=p.task_id WHERE p.id::text=$1`, [id])).rows[0];
        if (found) { task = found; links = linksOf(found.links); }
      } else if (kind === "collector") {
        const found = (await q(`SELECT c.task_id::text AS task_id, c.mission_id, c.placement, c.links, t.status, t.mission_id AS task_mission
          FROM collector_progress c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.id::text=$1`, [id])).rows[0];
        if (found) {
          links = linksOf(found.links);
          if (found.task_id && found.placement === "task") task = { id: found.task_id, status: found.status, mission_id: found.task_mission };
          else missionId = found.mission_id;
        }
      } else if (kind === "task") {
        task = (await q("SELECT id::text AS id, status, mission_id FROM tasks WHERE id::text=$1", [id])).rows[0];
      } else if (kind === "mission") missionId = id;
      if (task) {
        add("task", task.id, TASK_STATUS[task.status] ?? "进行中", line, links);
        missionId = task.mission_id;
      }
      const code = await missionOf(missionId);
      if (code) add("mission", code, "进行中", line, links);
    }
  }
  return [...targets.values()];
}

/** 读回的组件换回写入的样子：只留七项，refs、scope 换成 ref 字符串，条目里空的 url 去掉。 */
function writable(component: WorldReadComponent): Record<string, unknown> {
  const attributes = component.attributes ? { ...component.attributes } : undefined;
  if (attributes && Array.isArray(attributes.entries)) {
    attributes.entries = (attributes.entries as Record<string, unknown>[]).map(({ url, ...entry }) => (url ? { ...entry, url } : entry));
  }
  return {
    id: component.id, type: component.type,
    ...(component.scope ? { scope: component.scope.ref } : {}),
    ...(component.text ? { text: component.text } : {}),
    ...(component.refs?.length ? { refs: component.refs.map((ref) => ref.ref) } : {}),
    ...(component.artifacts?.length ? { artifacts: component.artifacts } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

/** 新快照 = 上一条执行状态快照的全部块 + 本人这条周复盘条目（同 id 的旧条目换掉）。 */
export function carryBlocks(previous: WorldStateSnapshot | null, own: Record<string, unknown>): Record<string, unknown> {
  const blocks: Record<string, unknown> = {};
  const type = typeof previous?.payload_type === "string" ? previous.payload_type : previous?.payload_type.id;
  if (previous && type === "execution_state") {
    for (const block of previous.blocks) {
      if (!block.value) continue;
      const value: Record<string, unknown> = {};
      if (block.value.text) value.text = block.value.text;
      if (block.value.refs?.length) value.refs = block.value.refs.map((ref) => ref.ref);
      if (block.value.artifacts?.length) value.artifacts = block.value.artifacts;
      if (block.value.components?.length) value.components = block.value.components.map(writable);
      if (Object.keys(value).length) blocks[block.id] = value;
    }
  }
  const progress = (blocks.progress as { components?: Record<string, unknown>[] } | undefined) ?? {};
  blocks.progress = { ...progress, components: [...(progress.components ?? []).filter((item) => item.id !== own.id), own] };
  return blocks;
}

export function createWeeklyReviewWorldSync({ pool, client, publicOrigin, names, now = () => new Date() }: {
  pool: Pool; client: WorldClient; publicOrigin: string; names: () => Map<string, string>; now?: () => Date;
}) {
  const q: Query = pool.query.bind(pool);
  const origin = publicOrigin.replace(/\/+$/, "");

  async function lookup(target: Target): Promise<WorldHead | null> {
    const head = await client.byExternalRef(target.kind === "mission" ? `mission:${target.externalId}` : `todo:${target.externalId}`);
    if (head && head.object_type !== (target.kind === "mission" ? "Mission" : "Task")) throw new WorldError(409, "INVALID_STATE", `${target.key} 指向的不是 ${target.kind === "mission" ? "Mission" : "Task"}`);
    return head;
  }

  async function syncTarget(row: WeeklyReviewRow, target: Target): Promise<WorldSyncResult> {
    const head = await lookup(target);
    if (!head) return { target: target.key, status: "skipped", code: "NOT_IN_WORLD" };
    const name = names().get(row.person_id) ?? row.person_id;
    const week = `${row.week_start.slice(5).replace("-", "/")}–${addDays(row.week_start, 6).slice(5).replace("-", "/")}`;
    const reviewUrl = `${origin}${weeklyReviewHref(row.id, false)}`;
    const artifacts = [...target.links, reviewUrl].slice(0, 20);
    const declaration = { scene: worldRef(head), trigger: "天枢周复盘提交", human_acceptance: { required: false } };
    const eventKey = `tianshu:weekly-review:${row.id}:event:${head.object_id}`;
    const event = await client.write(eventKey, async () => {
      const current = await client.getHead(head.object_id);
      return {
        action_type: "world_record_event", contract_version: current.contract_version, target: null, expected_versions: [], idempotency_key: eventKey,
        reason: "天枢周复盘提交后同步进展",
        params: { category: "other", subject_refs: [worldRef(current)], occurred_at: shanghai(new Date(now().getTime() - 60_000)),
          content: { text: [`【周复盘】${name} ${week}`, ...target.lines.map((line) => `- ${line}`)].join("\n"), artifacts },
          declaration: { ...declaration, scene: worldRef(current) } },
      } satisfies WorldAction;
    });
    const eventId = event.result.event_id;
    if (!eventId) throw new WorldError(502, "INVALID_RESPONSE", "外部事件回执缺少 event_id");
    const stateKey = `tianshu:weekly-review:${row.id}:state:${head.object_id}`;
    const state = await client.write(stateKey, async () => {
      const current = await client.getHead(head.object_id);
      const previous = (await client.getState(head.object_id)).snapshot;
      const asOf = new Date(now().getTime() - 60_000);
      const principal = client.config.people[row.person_id];
      const own = {
        id: `weekly:${row.person_id}`, type: "progress_item", text: `${name} ${week} 周复盘：${target.lines[0]}`.slice(0, 500),
        artifacts,
        attributes: {
          ...(principal ? { principal_id: principal } : {}), principal_name: name, external_status: target.status,
          entries: target.lines.map((line) => ({ at: shanghai(row.submitted_at ?? asOf), source: "web", text: line.slice(0, 500) })),
        },
      };
      return {
        action_type: "world_refresh_state", contract_version: current.contract_version, target: null, expected_versions: [], idempotency_key: stateKey,
        reason: "天枢周复盘提交后同步进展",
        params: {
          declaration: { ...declaration, scene: worldRef(current) },
          payload: { title: `${current.title} · ${name} ${week} 周复盘`, subject_ref: worldRef(current), as_of: shanghai(asOf),
            period: previous?.period ?? addDays(row.week_start, 4).slice(0, 7), payload_type: "execution_state", source_event_refs: [`event:${eventId}`],
            blocks: carryBlocks(previous, own) },
        },
      } satisfies WorldAction;
    });
    return { target: target.key, status: "committed", eventId, snapshotRef: typeof state.result.ref === "string" ? state.result.ref : undefined };
  }

  /** 一份周复盘：逐个对象写；网络错误留 pending 下次重放（同一幂等键），其余错误记 failed。 */
  async function syncReview(id: string): Promise<void> {
    const row = await getWeeklyReviewRow(q, id);
    if (!row || row.status !== "submitted" || row.world_sync_status !== "pending") return;
    const results: WorldSyncResult[] = [];
    for (const target of await weeklyReviewTargets(q, row)) {
      try { results.push(await syncTarget(row, target)); }
      catch (error) {
        const code = worldErrorCode(error);
        results.push({ target: target.key, status: code === "NETWORK_ERROR" ? "pending" : "failed", code });
        logEvent({ event: "world.weekly_review", objectRef: `weekly-review:${row.id}`, status: "failed", errorCode: code });
      }
    }
    const status = results.some((item) => item.status === "pending") ? "pending" : results.some((item) => item.status === "failed") ? "failed" : "done";
    await q("UPDATE weekly_reviews SET world_sync_status=$2, world_sync=$3::jsonb WHERE id=$1 AND world_sync_status='pending'", [row.id, status, JSON.stringify(results)]);
  }

  let tail = Promise.resolve();
  let closed = false;
  const submit = (run: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(run).catch((error) => logEvent({ event: "world.weekly_review", status: "failed", errorCode: worldErrorCode(error) }));
  };
  async function drain() {
    const pending = await q("SELECT id FROM weekly_reviews WHERE world_sync_status='pending' ORDER BY submitted_at LIMIT 50");
    for (const { id } of pending.rows as { id: string }[]) await syncReview(id);
  }
  const timer = setInterval(() => submit(drain), 5 * 60_000);
  timer.unref();
  submit(drain);
  return {
    schedule(id: string) { submit(() => syncReview(id)); },
    async idle() { await tail; },
    async close() { closed = true; clearInterval(timer); await tail; },
  };
}
export type WeeklyReviewWorldSync = ReturnType<typeof createWeeklyReviewWorldSync>;
