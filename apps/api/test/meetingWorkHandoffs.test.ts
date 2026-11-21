import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { TMeetingWorkFeedItem, TMeetingWorkReceipt, TMeetingWorkTarget, TNexusDriRequest } from "@warmap/contracts";
import { boardFixture, BOARD_NOW, THIRD, type BoardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

const source: TNexusDriRequest = JSON.parse(readFileSync(new URL("./fixtures/nexus-dri-contract-examples.json", import.meta.url), "utf8")).request;
const base = "/api/me/meeting-work-handoffs";
let f: BoardFixture;
afterEach(async () => { if (f) await f.close(); });

async function addRequest(revision = 1, quote?: string) {
  const id = randomUUID();
  const body = { ...source, revision, source: { ...source.source, quote } };
  await f.t.sql(`INSERT INTO nexus_dri_requests(id,request_id,revision,item_id,meeting_id,fingerprint,body,confirmer_world_id,confirmer_person_id,expires_at,received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::json,$8,$9,$10,$11)`, [id, source.requestId, revision, source.itemId, source.meetingId, source.fingerprint,
    JSON.stringify(body), source.proposedConfirmers[0], TEST_MEMBER.personId, new Date(BOARD_NOW.getTime() + 86400_000), BOARD_NOW]);
  return id;
}
const projectFeed = async (id: string) => {
  const res = await f.call("GET", `/api/me/projects/${id}/feed`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { kind: string }[]).filter((i): i is TMeetingWorkFeedItem => i.kind === "meeting_handoff");
};
const makeProject = async (name: string, taskId?: string) => {
  const res = await f.call("POST", "/api/me/projects", { name, taskId });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().projectId as string;
};
const post = (ref: string, targets: (TMeetingWorkTarget & { instruction?: string })[], revision = 1, cookie?: string) =>
  f.call("POST", `${base}/${ref}`, { authorization: "continue", revision, targets }, cookie);
const node = (projectId: string, kind: TMeetingWorkTarget["kind"], id: string) => ({ projectId, kind, id });
const decide = (row: string, body: object) => f.call("POST", `/api/me/nexus-confirmations/${row}/decision`, body);

describe("本人确认后递送至原工作", { timeout: 60000 }, () => {
  it("去向不列「随手」项目和它的会话（本人 11/19 收到幕后）", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    const kept = await makeProject("原品牌项目");
    const scratch = randomUUID();
    await f.t.sql("INSERT INTO projects(id,owner_id,name,scratch,created_at,updated_at) VALUES($1,$2,'随手',true,$3,$3)", [scratch, TEST_MEMBER.personId, BOARD_NOW]);
    const topic = randomUUID();
    await f.t.sql("INSERT INTO research_topics(id,owner_id,title,project_id,free,first_message) VALUES($1,$2,'比对合同',$3,true,'比对')", [topic, TEST_MEMBER.personId, scratch]);
    const res = await f.call("GET", "/api/me/meeting-work-handoff-targets");
    expect(res.statusCode, res.body).toBe(200);
    const options = res.json().targets as TMeetingWorkTarget[];
    expect(options.map((o) => o.id)).toContain(kept);
    expect(options.map((o) => o.projectId)).not.toContain(scratch);
    expect(options.map((o) => o.id)).not.toContain(topic);
  });

  it("分目标递送、并发重放、部分失败重试、原卡交代与权限变化", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    const req = await addRequest();
    const projectId = await makeProject("原品牌项目", "task-open");
    const second = await makeProject("另一个现有项目");
    const card = await f.card("原 Logo 子会话");
    await f.t.sql("UPDATE tasks SET executor='claude_code', project_id=$2 WHERE id=$1", [card, projectId]);
    const topic = randomUUID();
    await f.t.sql("INSERT INTO research_topics(id,owner_id,title,project_id,status,free,first_message) VALUES($1,$2,'官网',$3,'archived',true,'延续原框架')",
      [topic, TEST_MEMBER.personId, projectId]);
    const otherTopic = randomUUID();
    await f.t.sql("INSERT INTO research_topics(id,owner_id,title,project_id,free,first_message) VALUES($1,$2,'另一个方案',$3,true,'原指令')",
      [otherTopic, TEST_MEMBER.personId, projectId]);
    const options = (await f.call("GET", "/api/me/meeting-work-handoff-targets")).json().targets;
    expect(options.map((o: TMeetingWorkTarget) => o.id)).toEqual(expect.arrayContaining([projectId, second, "task-open", card]));
    expect(options.map((o: TMeetingWorkTarget) => o.id)).not.toContain(topic);
    const dest: (TMeetingWorkTarget & { instruction?: string })[] = [
      { ...node(projectId, "card", card), instruction: "在原 LOGO 上调整" },
      node(projectId, "task", "task-open"), node(projectId, "topic", topic), node(second, "project", second),
    ];
    expect((await f.call("GET", base)).json()).toEqual({ items: [] });
    const decision = await decide(req, { decision: "amended", value: "本人修订后的整体方向" });
    expect(decision.statusCode, decision.body).toBe(200);
    const ref = decision.json().confirmationRef as string;
    const choice = (await f.call("GET", base)).json().items[0];
    expect(choice).toMatchObject({ conclusion: { confirmationRef: ref, decision: "amended", revision: 1, meetingId: source.meetingId,
      content: { value: "本人修订后的整体方向" }, source: { readState: "reference_only", version: source.source.version } }, receipts: [] });
    expect(await projectFeed(projectId)).toEqual([]);
    const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin },
      payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect((await f.call("GET", base, undefined, cookie)).json()).toEqual({ items: [] });
    expect((await post(ref, dest, 1, cookie)).statusCode).toBe(404);
    expect((await post(ref, dest, 2)).statusCode).toBe(409);
    const requests = await Promise.all([post(ref, dest), post(ref, [...dest].reverse())]);
    for (const res of requests) expect(res.statusCode, res.body).toBe(200);
    const receipts = requests[0]!.json().receipts as TMeetingWorkReceipt[];
    expect(receipts.map(r => r.status)).toEqual(["delivered", "delivered", "failed", "delivered"]);
    expect((requests[1]!.json().receipts as TMeetingWorkReceipt[]).map(r => r.id).reverse()).toEqual(receipts.map(r => r.id));
    const group = await projectFeed(projectId);
    expect(group).toHaveLength(2);
    expect(group.find(r => r.target.kind === "task")?.criteria.map(c => c.text)).toEqual(["有题库打分结果", "有新人上手录屏"]);
    expect(group.find(r => r.target.kind === "card")).toMatchObject({ instruction: dest[0].instruction, conclusion: { confirmationRef: ref },
      criteria: expect.arrayContaining([expect.objectContaining({ id: card, kind: "card", revision: 1 })]) });
    expect((await projectFeed(second))[0]?.conclusion.confirmationRef).toBe(ref);
    expect((await f.call("GET", `/api/me/cards/${card}/brief`)).json().markdown).toContain("本人修订后的整体方向");
    expect((await f.call("GET", `/api/me/topics/${otherTopic}/brief`)).json().markdown).toBe("原指令");
    await f.t.sql("UPDATE research_topics SET status='active' WHERE id=$1", [topic]);
    const retried = (await post(ref, [dest[2]!])).json().receipts[0];
    expect(retried).toMatchObject({ id: receipts[2]!.id, status: "delivered" });
    const topicBrief = (await f.call("GET", `/api/me/topics/${topic}/brief`)).json().markdown;
    expect(topicBrief).toContain("延续原框架");
    expect(topicBrief).toContain(ref);
    const longOriginal = "原".repeat(19998) + "末尾";
    await f.t.sql("UPDATE research_topics SET first_message=$2 WHERE id=$1", [topic, longOriginal]);
    const capped = (await f.call("GET", `/api/me/topics/${topic}/brief`)).json();
    expect(capped.originalMarkdown).toBe(longOriginal);
    expect(capped.markdown.length).toBeLessThanOrEqual(20000);
    expect(capped.markdown).toContain(ref);
    expect(capped.markdown).toContain("末尾");
    expect(await projectFeed(projectId)).toHaveLength(3);
    expect(await f.t.sql("SELECT COUNT(*)::int AS n FROM session_starts")).toEqual([{ n: 0 }]);
    expect(await f.t.sql("SELECT COUNT(*)::int AS n FROM local_runs")).toEqual([{ n: 0 }]);
    expect(await f.t.sql("SELECT COUNT(*)::int AS n FROM deliverable_versions")).toEqual([{ n: 0 }]);
    await f.t.sql("UPDATE research_topics SET project_id=$2 WHERE id=$1", [topic, second]);
    expect((await f.call("GET", `/api/me/topics/${topic}/brief`)).json().markdown).toBe(longOriginal);
    await f.t.sql("UPDATE nexus_dri_requests SET superseded_at=now() WHERE id=$1", [req]);
    const revision2 = await addRequest(2);
    expect((await post(ref, [dest[0]!])).statusCode).toBe(409);
    const historical = await projectFeed(projectId);
    expect(historical).toHaveLength(2);
    expect(historical.every(row => row.superseded)).toBe(true);
    expect((await f.call("GET", `/api/me/cards/${card}/brief`)).json().markdown).not.toContain(ref);
    await f.t.sql("UPDATE nexus_dri_requests SET confirmer_person_id=$2 WHERE id=$1", [revision2, THIRD.personId]);
    expect(await projectFeed(projectId)).toHaveLength(0);
  });

  it("一次确认加继续推进明确授权所有去向；拒绝和普通确认不会授权执行", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    const req = await addRequest(2, "这次确认的来源片段");
    const projectId = await makeProject("一个原项目");
    const scope = { authorization: "continue", targets: [node(projectId, "project", projectId)] };
    expect((await decide(req, { decision: "rejected", continueWork: scope })).statusCode).toBe(400);
    expect(await projectFeed(projectId)).toHaveLength(0);
    const combined = await decide(req, { decision: "confirmed", continueWork: scope });
    expect(combined.statusCode, combined.body).toBe(200);
    const ref = combined.json().confirmationRef;
    expect((await projectFeed(projectId))[0]).toMatchObject({ target: { projectId }, conclusion: {
      confirmationRef: ref, revision: 2, source: { readState: "excerpt", quote: "这次确认的来源片段" },
    } });
    const replayed = await post(ref, scope.targets, 2);
    expect(replayed.json().receipts[0].status).toBe("delivered");
    expect(await projectFeed(projectId)).toHaveLength(1);
    const rejected = await addRequest(3);
    const rejectedRef = (await decide(rejected, { decision: "rejected" })).json().confirmationRef;
    expect((await post(rejectedRef, scope.targets, 3)).statusCode).toBe(404);
  });
});
