import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { TMeetingCardView, TMeetingWorldResponse } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createJobWorker } from "../src/jobs.js";
import { hashSecret } from "../src/session.js";
import { worldEnv } from "./worldFixture.js";
import type { AppEnv } from "../src/app.js";
import type { FeishuMinutesApi } from "../src/feishu/minutes.js";

// 会议卡测试共用：建会、导入逐字稿生成草稿、确认和读卡的请求。假本体各测试文件自己 stubWorld。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
export const CEO = TEST_CEO.personId;
export const HOST = TEST_MEMBER.personId;
export const OWNER = "person-fixture-003";
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };
export const OCCURRED = "2026-06-01T10:02:00+08:00";

const TURNS = [
  { id: "turn-001", speakerId: CEO, text: "渠道预算这个月先不动，下周再看数据。" },
  { id: "turn-002", speakerId: HOST, text: "接口统一改成 v2，验收标准改成十月底前 4 家客户上线。" },
  { id: "turn-003", speakerId: OWNER, text: "好，我月底前把渠道看板接到 v2。" },
];

type CandidateChange = { targetRef: string; after: { text: string }; basisSections: number[] };
/**
 * 一条决策（「接口统一改成 v2」，责任人测试丙），一条行动项（测试丙）。objectChanges 是 10/28 之前的会议卡上的修改：
 * 会后整理不再拟修改（候选里给空数组），setup 造老会议卡时放进草稿。
 */
export function cardAgent(objectChanges: CandidateChange[] = [{ targetRef: "obj-po-1#target/acc-1", after: { text: "十月底前 4 家客户上线" }, basisSections: [1] }],
  decisions = [{ text: "接口统一改成 v2", ownerPersonId: OWNER as string | null, basisSections: [1] }]): PostMeetingAgent & { objectChanges: CandidateChange[] } {
  return {
    objectChanges,
    async generate() {
      return { candidate: {
        summary: "接口统一切到 v2，渠道预算下周再定。",
        sections: [
          { heading: "接口切换", body: "已定：接口统一改成 v2。", turnIds: ["turn-002", "turn-003"] },
          { heading: "渠道预算", body: "未定：渠道预算下周看数据再定。", turnIds: ["turn-001"] },
        ],
        decisions,
        objectChanges: [],
        actionItems: [{ text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSections: [1] }],
      } };
    },
  };
}
const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

/**
 * 建会、导入逐字稿、生成会议卡。缺省造一张 10/28 之前的会议卡（整卡确认、带对象修改）：去掉逐条确认，主持人把 agent 的修改加到草稿上
 * （目标不在候选里的当未定）；extra.v2 留着生成出来的逐条确认会议卡。
 */
export async function setup(agent: PostMeetingAgent = cardAgent(), env: Pick<AppEnv, "internalChatToken" | "feishu" | "meetingRecordText" | "meetingWorldWritesOff"> = {},
  extra: { meetingFollowThroughAgents?: { minutesApi?: FeishuMinutesApi }; v2?: boolean } = {}) {
  const { v2, ...agents } = extra;
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, ...worldEnv, ...env }, undefined, { preflightAgent, outcomeAgent: agent, ...agents });
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: { actionType: string; actionId: string }[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  const meetingId = created.json().cards[0].objectRef.id as string;
  await t.pool.query("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([{ kind: "po", id: "obj-po-1", title: "十月交付" }])]);
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)]);
  const ownerLogin = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  const owner = String(ownerLogin.headers["set-cookie"]).split(";")[0];
  const imported = await t.app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS } });
  expect(imported.statusCode).toBe(200);
  const host = await t.memberCookie();
  const worker = createJobWorker({ pool: t.pool, handlers: t.app.meetingFollowThrough.jobs().handlers });
  const run = async () => { while (await worker.tick() > 0); };
  if (!v2) await legacyCard(t, host, meetingId, (agent as { objectChanges?: CandidateChange[] }).objectChanges ?? []);
  return { t, ceo, host, owner, meetingId, run };
}

/**
 * 生成好的会议卡改成 10/28 之前的样子：没有逐条确认（decisions、行动项的 review 去掉），修改像当时模型生成的一样在草稿里
 * （经存草稿由服务填目标标题、原内容和版本，再把草稿版本拨回生成时的，当作没人存过）。
 */
async function legacyCard(t: TestApp, host: string, meetingId: string, changes: CandidateChange[]) {
  const generated = (await t.pool.query(
    `UPDATE meeting_cards SET decisions = NULL,
            action_items = (SELECT coalesce(jsonb_agg(item - 'review' ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(action_items) WITH ORDINALITY AS a(item, ord))
      WHERE meeting_id = $1 AND draft IS NOT NULL RETURNING draft_version`, [meetingId])).rows[0] as { draft_version: number } | undefined;
  if (!generated || !changes.length) return;
  const view = await getCard(t, host, meetingId);
  const options = new Set(view.targetOptions.map((option) => option.targetRef));
  await edit(t, host, meetingId, (draft) => {
    draft.objectChanges = changes.map((change, index) => ({
      id: `chg-${index + 1}`, targetRef: options.has(change.targetRef) ? change.targetRef : null, targetTitle: null, expectedVersion: null, before: null,
      after: change.after, basisSectionIds: change.basisSections.map((n) => `sec-${n}`), stale: false,
    }));
  });
  await t.pool.query("UPDATE meeting_cards SET draft_version = $2 WHERE meeting_id = $1", [meetingId, generated.draft_version]);
}

export const getCard = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingCardView> => {
  const res = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/card`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
};
export const putDraft = (t: TestApp, cookie: string, meetingId: string, payload: unknown) =>
  t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/card/draft`, headers: { cookie, origin: t.publicOrigin }, payload });
export const confirm = (t: TestApp, cookie: string, meetingId: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/card/confirm`, headers: { cookie, origin: t.publicOrigin }, payload });
export const retry = (t: TestApp, cookie: string, meetingId: string) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/card/retry`, headers: { cookie, origin: t.publicOrigin } });
export const worldOf = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingWorldResponse> =>
  (await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world`, headers: { cookie } })).json();

/** 改草稿（edit 改一份拷贝），返回保存后的视图。 */
export async function edit(t: TestApp, cookie: string, meetingId: string, change: (draft: NonNullable<TMeetingCardView["draft"]>) => void): Promise<TMeetingCardView> {
  const view = await getCard(t, cookie, meetingId);
  const draft = structuredClone(view.draft!);
  change(draft);
  const res = await putDraft(t, cookie, meetingId, { draftVersion: view.draftVersion, draft, actionItems: view.actionItems });
  expect(res.statusCode).toBe(200);
  return res.json();
}
/** 填上实际开始（服务导入的逐字稿没有），返回可确认的草稿版本。 */
export const ready = async (t: TestApp, host: string, meetingId: string) => (await edit(t, host, meetingId, (draft) => { draft.occurredAt = OCCURRED; })).draftVersion;
