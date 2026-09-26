import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, BattlefieldManagementResponse, MeetingCardPayload, StrategyConfigResponse, type TPreflightCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";

/** 配置页建会的 multipart 组装：文本字段 + 可选 files 文件字段。 */
function configMeetingMultipart(fields: Record<string, string>, files: { filename: string; mimeType: string; body: string }[] = []) {
  const boundary = "----config-meeting";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`));
    chunks.push(Buffer.from(file.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) };
}

async function postConfigMeeting(t: TestApp, headers: Record<string, string>, fields: Record<string, string>, files?: { filename: string; mimeType: string; body: string }[]) {
  const { contentType, payload } = configMeetingMultipart(fields, files);
  return t.app.inject({ method: "POST", url: "/api/config/meetings", headers: { ...headers, "content-type": contentType }, payload });
}

/** 预审只引用 Meeting 自身来源：独立新建的 Meeting 可以没有任何关联 Issue。 */
function fakeAgent(): PreflightAgent & { calls: PreflightAgentInput[] } {
  const calls: PreflightAgentInput[] = [];
  return {
    calls,
    async generate(input: PreflightAgentInput) {
      calls.push(input);
      const candidate: TPreflightCandidate = preflightCandidate([`meeting:${input.meeting.id}`]);
      return { candidate, runId: "preflight-run-config" };
    },
  };
}

async function authed(t: TestApp): Promise<{ cookie: string; headers: Record<string, string> }> {
  const cookie = await t.loginCookie();
  return { cookie, headers: { cookie, origin: t.publicOrigin } };
}

/** 结构化战场写入：code/sortOrder 与名称独立，ownerId 用 fixture 里的 dri。 */
function battlefieldBody(name: string, code: string, overrides: Record<string, unknown> = {}) {
  return { code, sortOrder: Number(code) * 10, name, ownerId: "person-fixture-002", sixMonthOutcome: `${name}六个月目标`, ...overrides };
}

function capabilityBody(name: string, code: string, overrides: Record<string, unknown> = {}) {
  return { code, sortOrder: Number(code) * 10, name, group: "", sixMonthOutcome: `${name}六个月目标`, ...overrides };
}

describe("CEO 配置页 create 路由", () => {
  it("rejects unauthenticated writes on all four routes", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      for (const [url, payload] of [
        ["/api/config/battlefields", battlefieldBody("供应战场", "01")],
        ["/api/config/capabilities", capabilityBody("供应链能力", "01", { group: "组织" })],
        ["/api/config/issues", { title: "标题", battlefieldId: "growth" }],
        ["/api/config/meetings", { title: "会议", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002" }],
      ] as const) {
        const res = await t.app.inject({ method: "POST", url, headers: { origin: t.publicOrigin }, payload });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await t.close();
    }
  });

  it("registers a battlefield and rejects a duplicate slug", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("供应战场", "01", { sixMonthOutcome: "锁定关键器件的供应与价格" }),
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.kind).toBe("battlefield");
      expect(card.objectRef.id).toBe("供应战场");

      const row = await t.sql("SELECT name, code, sort_order, six_month_outcome, owner_id, mission_anchors FROM battlefield_config WHERE id = $1", ["供应战场"]);
      expect(row).toEqual([{
        name: "供应战场",
        code: "01",
        sort_order: 10,
        six_month_outcome: "锁定关键器件的供应与价格",
        owner_id: "person-fixture-002",
        mission_anchors: [],
      }]);

      const duplicate = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("供应战场", "02"),
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().code).toBe("BATTLEFIELD_EXISTS");

      const missingField = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { code: "03", sortOrder: 30, name: "空白战场", ownerId: "person-fixture-002" },
      });
      expect(missingField.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("registers a capability that reaches the home capability panel without any Issue", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("供应链能力", "01", { group: "交付组织", sixMonthOutcome: "把关键器件从寻源到交付串成一条线" }),
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.kind).toBe("capability");
      expect(card.payload).toEqual({
        capabilityId: "供应链能力",
        code: "01",
        sortOrder: 10,
        name: "供应链能力",
        group: "交付组织",
        sixMonthOutcome: "把关键器件从寻源到交付串成一条线",
        supportRefs: [],
      });

      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: headers.cookie! } });
      expect(home.json().cards.some((candidate: { id: string }) => candidate.id === "capability:供应链能力")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("creates a pending CEO Issue that triggers research", async () => {
    const started: string[] = [];
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() }, {
      async start(issueId: string) { started.push(issueId); },
      async executeRun() {},
      async idle() {},
    });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "是否自建渠道", battlefieldId: "growth", decisionBy: "2026-06-30" },
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.badge).toBe("CEO");
      expect(card.title).toBe("是否自建渠道");
      expect(card.payload.origin).toBe("ceo");
      expect(card.payload.status).toBe("pending");
      expect(card.payload.location).toEqual({ level: "battlefield", battlefieldId: "growth" });
      expect(card.payload.urgency).toEqual({ level: "yellow", decisionBy: "2026-06-30" });
      expect(card.payload.research.status).toBe("pending");
      expect(started).toEqual([card.objectRef.id]);

      const unknownBattlefield = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "未注册战场议题", battlefieldId: "unknown-zone" },
      });
      expect(unknownBattlefield.statusCode).toBe(400);

      const tooLongTitle = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "这是一个明显超过二十五个字的议题标题用于验证长度校验", battlefieldId: "growth" },
      });
      expect(tooLongTitle.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("creates a scheduled Meeting with no linked Issue and with an existing Issue", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const empty = await postConfigMeeting(t, headers, { title: "季度经营复盘", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002" });
      expect(empty.statusCode).toBe(201);
      const emptyCard = empty.json().cards[0];
      expect(Value.Check(Card, emptyCard)).toBe(true);
      expect(Value.Check(MeetingCardPayload, emptyCard.payload)).toBe(true);
      expect(emptyCard.payload.issueIds).toEqual([]);
      expect(emptyCard.payload.status).toBe("scheduled");
      expect(emptyCard.payload.leadDriId).toBe("person-fixture-002");
      expect(emptyCard.payload).toMatchObject({ endsAt: "2026-06-01T03:00:00.000Z", endedAt: null });

      const timed = await postConfigMeeting(t, headers, { title: "带结束时间", scheduledAt: "2026-06-01T14:00:00.000+08:00", endsAt: "2026-06-01T15:30:00.000+08:00", leadDriId: "person-fixture-002" });
      expect(timed.statusCode).toBe(201);
      expect(timed.json().cards[0].payload.endsAt).toBe("2026-06-01T07:30:00.000Z");

      const badRange = await postConfigMeeting(t, headers, { title: "结束早于开始", scheduledAt: "2026-06-01T14:00:00.000+08:00", endsAt: "2026-06-01T13:00:00.000+08:00", leadDriId: "person-fixture-002" });
      expect(badRange.statusCode).toBe(400);
      expect(badRange.json()).toMatchObject({ code: "INVALID_INPUT", fieldErrors: { endsAt: expect.any(String) } });

      const issue = await t.createIssue();
      const linked = await postConfigMeeting(t, headers, {
        title: "渠道投入决策会",
        scheduledAt: "2026-06-02T10:00:00.000+08:00",
        leadDriId: "person-fixture-002",
        issueIds: JSON.stringify([issue.objectRef.id]),
      });
      expect(linked.statusCode).toBe(201);
      expect(linked.json().cards[0].payload.issueIds).toEqual([issue.objectRef.id]);

      const badDri = await postConfigMeeting(t, headers, { title: "非法负责人", scheduledAt: "2026-06-03T10:00:00.000+08:00", leadDriId: "person-fixture-001" });
      expect(badDri.statusCode).toBe(400);

      const badTime = await postConfigMeeting(t, headers, { title: "非法时间", scheduledAt: "不是时间", leadDriId: "person-fixture-002" });
      expect(badTime.statusCode).toBe(400);

      const badIssueIds = await postConfigMeeting(t, headers, { title: "非法议题", scheduledAt: "2026-06-04T10:00:00.000+08:00", leadDriId: "person-fixture-002", issueIds: "not-json" });
      expect(badIssueIds.statusCode).toBe(400);

      const missingTitle = await postConfigMeeting(t, headers, { scheduledAt: "2026-06-05T10:00:00.000+08:00", leadDriId: "person-fixture-002" });
      expect(missingTitle.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("lands pre-meeting materials on creation so the first preflight reads them instead of research", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { headers } = await authed(t);
      const created = await postConfigMeeting(t, headers, { title: "带材料建会", scheduledAt: "2026-06-06T10:00:00.000+08:00", leadDriId: "person-fixture-002" }, [
        { filename: "会前材料.md", mimeType: "text/markdown", body: "会前材料正文：渠道毛利下降" },
      ]);
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.payload.materials).toHaveLength(1);
      expect(card.payload.materials[0].fileName).toBe("会前材料.md");
      expect(card.payload.preflight.status).toBe("ready");

      const call = agent.calls.at(-1)!;
      expect(call.materials.map((material) => material.extractedText).join("")).toContain("会前材料正文：渠道毛利下降");
      expect(call.issues.every((issue) => issue.research === null)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("assigns and unassigns pending Issues with deterministic set normalization", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, headers } = await authed(t);
      const issue = await t.createIssue();
      const issueId = issue.objectRef.id;
      const battlefield = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("渠道战场", "02"),
      });
      expect(battlefield.statusCode).toBe(201);
      const extra = battlefield.json().cards[0].objectRef.id as string;

      // 未注册战场：404
      const unknown = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/unknown-zone/issues",
        headers,
        payload: { issueId },
      });
      expect(unknown.statusCode).toBe(404);

      const assigned = await t.app.inject({ method: "POST", url: `/api/config/battlefields/${extra}/issues`, headers, payload: { issueId } });
      expect(assigned.statusCode).toBe(200);
      const assignedCard = assigned.json().cards[0];
      expect(Value.Check(Card, assignedCard)).toBe(true);
      // 2 个战场：归一化为排序后的 company 集合
      expect(assignedCard.payload.location).toEqual({ level: "company", relatedBattlefieldIds: ["growth", extra].sort() });
      expect(assignedCard.objectRef.version).toBe(issue.version + 1);

      // 重复加入同一战场：集合不变，不升 version
      const again = await t.app.inject({ method: "POST", url: `/api/config/battlefields/${extra}/issues`, headers, payload: { issueId } });
      expect(again.statusCode).toBe(200);
      expect(again.json().cards[0].objectRef.version).toBe(assignedCard.objectRef.version);

      // 2 → 1：自动降级回 battlefield 级
      const downgraded = await t.app.inject({ method: "DELETE", url: `/api/config/battlefields/${extra}/issues/${issueId}`, headers });
      expect(downgraded.statusCode).toBe(200);
      expect(downgraded.json().cards[0].payload.location).toEqual({ level: "battlefield", battlefieldId: "growth" });

      // 1 → 0：未归属（company + 空集合）
      const orphaned = await t.app.inject({ method: "DELETE", url: `/api/config/battlefields/growth/issues/${issueId}`, headers });
      expect(orphaned.statusCode).toBe(200);
      expect(orphaned.json().cards[0].payload.location).toEqual({ level: "company", relatedBattlefieldIds: [] });
      const rows = await t.sql("SELECT location, version FROM issues WHERE id = $1", [issueId]);
      expect(rows[0].location).toEqual({ level: "company", relatedBattlefieldIds: [] });
      expect(rows[0].version).toBe(assignedCard.objectRef.version + 2);
      expect(cookie).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("rejects battlefield membership changes on capability Issues and on non-pending Issues", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const capability = await t.createIssue({ location: { level: "capability", capabilityId: "cap-delivery" } });
      const capabilityAssign = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/growth/issues",
        headers,
        payload: { issueId: capability.objectRef.id },
      });
      expect(capabilityAssign.statusCode).toBe(400);
      expect(capabilityAssign.json().code).toBe("INVALID_LOCATION");

      const decided = await t.createIssue();
      await t.sql("UPDATE issues SET status = 'decided' WHERE id = $1", [decided.objectRef.id]);
      const decidedAssign = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/growth/issues",
        headers,
        payload: { issueId: decided.objectRef.id },
      });
      expect(decidedAssign.statusCode).toBe(409);
      expect(decidedAssign.json().code).toBe("ISSUE_NOT_PENDING");
      const decidedUnassign = await t.app.inject({
        method: "DELETE",
        url: `/api/config/battlefields/growth/issues/${decided.objectRef.id}`,
        headers,
      });
      expect(decidedUnassign.statusCode).toBe(409);

      const missing = await t.app.inject({ method: "POST", url: "/api/config/battlefields/growth/issues", headers, payload: { issueId: "no-such-issue" } });
      expect(missing.statusCode).toBe(404);

      const anonymous = await t.app.inject({ method: "POST", url: "/api/config/battlefields/growth/issues", headers: { origin: t.publicOrigin }, payload: { issueId: capability.objectRef.id } });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("deletes a battlefield, detaching Issues and dropping its ontology anchors", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      for (const [code, name] of [["02", "渠道战场"], ["03", "供应战场"]] as const) {
        const created = await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody(name, code) });
        expect(created.statusCode).toBe(201);
      }
      // company[A,B]：两个战场都指向同一议题
      const shared = await t.createIssue();
      for (const id of ["growth", "渠道战场"]) {
        const res = await t.app.inject({ method: "POST", url: `/api/config/battlefields/${id}/issues`, headers, payload: { issueId: shared.objectRef.id } });
        expect(res.statusCode).toBe(200);
      }
      // battlefield:A：单独归属另一个议题
      const solo = await t.createIssue();
      await t.app.inject({ method: "POST", url: "/api/config/battlefields/growth/issues", headers, payload: { issueId: solo.objectRef.id } });
      await t.sql("UPDATE radar_config SET anchors = $1::jsonb WHERE id = 'default'", [JSON.stringify([
        { id: "ontology:growth", title: "增长战场", query: "增长", location: { type: "battlefield", id: "growth" }, source: "ontology", originRef: "monthly-plan:2026-09" },
        { id: "manual:keep", title: "手工", query: "手工", location: { type: "battlefield", id: "growth" }, source: "manual" },
        { id: "ontology:company", title: "公司目标", query: "公司", location: { type: "company" }, source: "ontology", originRef: "monthly-plan:2026-09" },
      ])]);

      const deleted = await t.app.inject({ method: "DELETE", url: "/api/config/battlefields/growth", headers });
      expect(deleted.statusCode).toBe(204);
      expect(await t.sql("SELECT id FROM battlefield_config WHERE id = $1", ["growth"])).toEqual([]);

      // company[A,B] 删 A → 自动降级回 battlefield:B；battlefield:A 删 A → 未归属
      const rows = await t.sql("SELECT id, location FROM issues WHERE id = ANY($1::uuid[])", [[shared.objectRef.id, solo.objectRef.id]]);
      const byId = new Map(rows.map((row) => [row.id as string, row.location]));
      expect(byId.get(shared.objectRef.id)).toEqual({ level: "battlefield", battlefieldId: "渠道战场" });
      expect(byId.get(solo.objectRef.id)).toEqual({ level: "company", relatedBattlefieldIds: [] });

      // anchors：只删指向该战场的 ontology anchor，manual 与公司级 ontology 保留
      const anchors = (await t.sql("SELECT anchors FROM radar_config WHERE id = 'default'"))[0].anchors as { id: string }[];
      expect(anchors.map((anchor) => anchor.id).sort()).toEqual(["manual:keep", "ontology:company"]);

      const missing = await t.app.inject({ method: "DELETE", url: "/api/config/battlefields/growth", headers });
      expect(missing.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("deletes a battlefield, pruning capability supportRefs to it and its Missions", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("灯塔项目", "01", { missionAnchors: [{ code: "01-1", title: "未来组织范式设计与确认" }] }),
      });
      // 引用该战场与它的 Mission
      await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Method", "03", {
          supportRefs: [{ type: "mission-anchor", missionCode: "01-1" }, { type: "battlefield", battlefieldId: "灯塔项目" }, { type: "all-battlefields" }],
        }),
      });
      // 只引用别的战场：不受影响，version 不动
      await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Agents", "04", { supportRefs: [{ type: "battlefield", battlefieldId: "growth" }] }),
      });
      expect(await t.sql("SELECT code, version FROM capability_config ORDER BY code")).toEqual([
        { code: "03", version: 1 },
        { code: "04", version: 1 },
      ]);

      const deleted = await t.app.inject({ method: "DELETE", url: "/api/config/battlefields/灯塔项目", headers });
      expect(deleted.statusCode).toBe(204);

      // 指向被删战场与它 Mission 的 ref 被清掉，其余 ref 保留；只有受影响能力 version+1
      expect(await t.sql("SELECT code, version, support_refs FROM capability_config ORDER BY code")).toEqual([
        { code: "03", version: 2, support_refs: [{ type: "all-battlefields" }] },
        { code: "04", version: 1, support_refs: [{ type: "battlefield", battlefieldId: "growth" }] },
      ]);
    } finally {
      await t.close();
    }
  });

  it("projects the battlefield management page from one endpoint", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("渠道战场", "02") });
      const assigned = await t.createIssue({ title: "增长战场议题" });
      const shared = await t.createIssue({ title: "跨战场议题", urgency: { level: "red", decisionBy: "2026-09-30", reason: "窗口关闭" } });
      await t.app.inject({ method: "POST", url: "/api/config/battlefields/渠道战场/issues", headers, payload: { issueId: shared.objectRef.id } });
      const orphan = await t.createIssue({ title: "未归属议题", location: { level: "company", relatedBattlefieldIds: [] } });
      const capability = await t.createIssue({ location: { level: "capability", capabilityId: "cap-delivery" } });
      const decided = await t.createIssue();
      await t.sql("UPDATE issues SET status = 'decided' WHERE id = $1", [decided.objectRef.id]);

      const res = await t.app.inject({ method: "GET", url: "/api/config/battlefields", headers: { cookie: headers.cookie! } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Value.Check(BattlefieldManagementResponse, body)).toBe(true);
      expect(body.battlefields).toEqual([
        {
          id: "growth", version: 1, code: "", sortOrder: 0, name: "增长战场", ownerId: "", ownerDisplayName: "",
          sixMonthOutcome: "验证渠道结构与交付节奏，形成可复制的增长路径。", missionAnchors: [], pendingIssueCount: 2,
        },
        {
          id: "渠道战场", version: 1, code: "02", sortOrder: 20, name: "渠道战场", ownerId: "person-fixture-002",
          ownerDisplayName: "测试乙", sixMonthOutcome: "渠道战场六个月目标", missionAnchors: [], pendingIssueCount: 1,
        },
      ]);
      const byId = new Map(body.issues.map((issue: { id: string }) => [issue.id, issue]));
      expect([...byId.keys()].sort()).toEqual([assigned.objectRef.id, shared.objectRef.id, orphan.objectRef.id].sort());
      expect(byId.get(assigned.objectRef.id)).toEqual({ id: assigned.objectRef.id, title: "增长战场议题", urgencyLevel: "gray", battlefieldIds: ["growth"] });
      expect(byId.get(shared.objectRef.id)).toEqual({ id: shared.objectRef.id, title: "跨战场议题", urgencyLevel: "red", decisionBy: "2026-09-30", battlefieldIds: ["growth", "渠道战场"] });
      expect(byId.get(orphan.objectRef.id)).toEqual({ id: orphan.objectRef.id, title: "未归属议题", urgencyLevel: "gray", battlefieldIds: [] });
      expect(body.issues.some((issue: { id: string }) => issue.id === capability.objectRef.id)).toBe(false);

      const anonymous = await t.app.inject({ method: "GET", url: "/api/config/battlefields" });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  // Receipt schema 仍然只由 Meeting Outcome 写入；配置页不产生 Receipt。
});

describe("CEO 长期配置与结构化引用", () => {
  it("reads and updates the company LTCO with version+1", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const initial = await t.app.inject({ method: "GET", url: "/api/config/strategy", headers: { cookie: headers.cookie! } });
      expect(initial.statusCode).toBe(200);
      expect(Value.Check(StrategyConfigResponse, initial.json())).toBe(true);
      expect(initial.json()).toEqual({ version: 1, ltco: "" });

      const patched = await t.app.inject({ method: "PATCH", url: "/api/config/strategy", headers, payload: { ltco: "春节前完成核心业务第一次被真实证明。" } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ version: 2, ltco: "春节前完成核心业务第一次被真实证明。" });
      expect((await t.sql("SELECT version, ltco FROM company_strategy_config WHERE id = 'default'"))[0]).toEqual({
        version: 2,
        ltco: "春节前完成核心业务第一次被真实证明。",
      });

      const empty = await t.app.inject({ method: "PATCH", url: "/api/config/strategy", headers, payload: {} });
      expect(empty.statusCode).toBe(400);
      const anonymous = await t.app.inject({ method: "PATCH", url: "/api/config/strategy", headers: { origin: t.publicOrigin }, payload: { ltco: "x" } });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("validates ownerId against company-people.v1 and allows 待指派", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const unknown = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("供应战场", "01", { ownerId: "person-unknown" }),
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().code).toBe("INVALID_OWNER");

      const unassigned = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { code: "01", sortOrder: 10, name: "供应战场", sixMonthOutcome: "锁定供应" },
      });
      expect(unassigned.statusCode).toBe(201);
      expect(unassigned.json().cards[0].payload).toMatchObject({ ownerId: "", ownerDisplayName: "" });

      const badPatch = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { ownerId: "person-unknown" } });
      expect(badPatch.statusCode).toBe(400);
      expect(badPatch.json().code).toBe("INVALID_OWNER");
    } finally {
      await t.close();
    }
  });

  it("rejects duplicate codes and keeps battlefield/capability lists in sortOrder, code, id order", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      for (const [code, name] of [["02", "灯塔项目"], ["01", "Token Ops"], ["03", "002 客户"]] as const) {
        const created = await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody(name, code) });
        expect(created.statusCode).toBe(201);
      }
      const duplicateCode = await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("重复编号战场", "01") });
      expect(duplicateCode.statusCode).toBe(409);
      expect(duplicateCode.json().code).toBe("BATTLEFIELD_CODE_CONFLICT");

      const management = await t.app.inject({ method: "GET", url: "/api/config/battlefields", headers: { cookie: headers.cookie! } });
      // growth 是迁移期未编号行（sort_order 0, code ""），排在最前
      expect(management.json().battlefields.map((item: { code: string }) => item.code)).toEqual(["", "01", "02", "03"]);

      for (const [code, name] of [["03", "Method"], ["02", "Re-architecture"], ["04", "Agents"]] as const) {
        expect((await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody(name, code) })).statusCode).toBe(201);
      }
      const duplicateCapabilityCode = await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("重复能力", "02") });
      expect(duplicateCapabilityCode.statusCode).toBe(409);
      expect(duplicateCapabilityCode.json().code).toBe("CAPABILITY_CODE_CONFLICT");

      const list = await t.app.inject({ method: "GET", url: "/api/config/capabilities", headers: { cookie: headers.cookie! } });
      expect(list.json().capabilities.map((item: { code: string }) => item.code)).toEqual(["02", "03", "04"]);
    } finally {
      await t.close();
    }
  });

  it("validates capability supportRefs against registered battlefields and mission codes", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("灯塔项目", "01", {
          missionAnchors: [
            { code: "01-1", title: "未来组织范式设计与确认" },
            { code: "01-2", title: "CEO Agent 常态化使用" },
          ],
        }),
      });

      const unknownMission = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Method", "03", { supportRefs: [{ type: "mission-anchor", missionCode: "09-9" }] }),
      });
      expect(unknownMission.statusCode).toBe(400);
      expect(unknownMission.json().code).toBe("UNKNOWN_MISSION_ANCHOR_CODE");

      const unknownBattlefield = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Method", "03", { supportRefs: [{ type: "battlefield", battlefieldId: "no-such" }] }),
      });
      expect(unknownBattlefield.statusCode).toBe(400);
      expect(unknownBattlefield.json().code).toBe("UNKNOWN_BATTLEFIELD");

      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Method", "03", {
          supportRefs: [{ type: "mission-anchor", missionCode: "01-1" }, { type: "battlefield", battlefieldId: "灯塔项目" }, { type: "all-battlefields" }],
        }),
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().cards[0].payload.supportRefs).toEqual([
        { type: "mission-anchor", missionCode: "01-1" },
        { type: "battlefield", battlefieldId: "灯塔项目" },
        { type: "all-battlefields" },
      ]);

      const badPatch = await t.app.inject({
        method: "PATCH",
        url: "/api/config/capabilities/Method",
        headers,
        payload: { supportRefs: [{ type: "mission-anchor", missionCode: "01-3" }] },
      });
      expect(badPatch.statusCode).toBe(400);
      expect(badPatch.json().code).toBe("UNKNOWN_MISSION_ANCHOR_CODE");

      // 战场 missionAnchors 与 ownerDisplayName 一起投影到 Card 正面
      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: headers.cookie! } });
      const battlefieldCard = home.json().cards.find((candidate: { id: string }) => candidate.id === "battlefield:灯塔项目");
      expect(battlefieldCard.payload).toMatchObject({
        code: "01",
        sortOrder: 10,
        ownerId: "person-fixture-002",
        ownerDisplayName: "测试乙",
        missionAnchors: [
          { code: "01-1", title: "未来组织范式设计与确认" },
          { code: "01-2", title: "CEO Agent 常态化使用" },
        ],
      });
      expect(battlefieldCard.payload.positioning).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("CEO 配置页编辑路由", () => {
  it("patches a battlefield in place: id stable, version+1, projection reflects", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("供应战场", "01", { sixMonthOutcome: "锁定供应" }) });

      const patched = await t.app.inject({
        method: "PATCH",
        url: "/api/config/battlefields/供应战场",
        headers,
        payload: { name: "供应链战场", code: "05", sortOrder: 50, ownerId: "", sixMonthOutcome: "锁定关键器件", missionAnchors: [{ code: "05-1", title: "关键器件寻源" }] },
      });
      expect(patched.statusCode).toBe(200);
      const card = patched.json().cards[0];
      expect(card.objectRef.id).toBe("供应战场");
      expect(card.objectRef.version).toBe(2);
      expect(card.title).toBe("供应链战场");
      expect(card.payload).toMatchObject({ code: "05", sortOrder: 50, sixMonthOutcome: "锁定关键器件", ownerId: "", ownerDisplayName: "", missionAnchors: [{ code: "05-1", title: "关键器件寻源" }] });

      const rows = await t.sql("SELECT id, version, code, sort_order, name, owner_id, six_month_outcome FROM battlefield_config WHERE id = $1", ["供应战场"]);
      expect(rows[0]).toMatchObject({ id: "供应战场", version: 2, code: "05", sort_order: 50, name: "供应链战场", owner_id: "", six_month_outcome: "锁定关键器件" });

      const management = await t.app.inject({ method: "GET", url: "/api/config/battlefields", headers: { cookie: headers.cookie! } });
      expect(management.json().battlefields.find((item: { id: string }) => item.id === "供应战场")).toEqual({
        id: "供应战场",
        version: 2,
        code: "05",
        sortOrder: 50,
        name: "供应链战场",
        ownerId: "",
        ownerDisplayName: "",
        sixMonthOutcome: "锁定关键器件",
        missionAnchors: [{ code: "05-1", title: "关键器件寻源" }],
        pendingIssueCount: 0,
      });

      const missing = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/不存在", headers, payload: { name: "新名" } });
      expect(missing.statusCode).toBe(404);
      const empty = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: {} });
      expect(empty.statusCode).toBe(400);
      const anonymous = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers: { origin: t.publicOrigin }, payload: { name: "新名" } });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("rejects a battlefield rename whose slug collides, but allows renaming to itself", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      for (const [code, name] of [["02", "渠道战场"], ["03", "供应战场"]] as const) {
        await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody(name, code) });
      }

      const conflict = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { name: "渠道战场" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("BATTLEFIELD_NAME_CONFLICT");

      const self = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { name: "供应战场" } });
      expect(self.statusCode).toBe(200);
      expect(self.json().cards[0].objectRef.version).toBe(2);
    } finally {
      await t.close();
    }
  });

  it("patches a capability and lists registered capabilities for the management page", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("供应链能力", "01", { group: "交付组织" }) });
      await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("渠道能力", "02", { group: "增长组织" }) });

      const list = await t.app.inject({ method: "GET", url: "/api/config/capabilities", headers: { cookie: headers.cookie! } });
      expect(list.statusCode).toBe(200);
      expect(list.json().capabilities).toEqual([
        { id: "供应链能力", version: 1, code: "01", sortOrder: 10, name: "供应链能力", group: "交付组织", sixMonthOutcome: "供应链能力六个月目标", supportRefs: [] },
        { id: "渠道能力", version: 1, code: "02", sortOrder: 20, name: "渠道能力", group: "增长组织", sixMonthOutcome: "渠道能力六个月目标", supportRefs: [] },
      ]);

      const patched = await t.app.inject({ method: "PATCH", url: "/api/config/capabilities/供应链能力", headers, payload: { name: "区域仓配服务", group: "", code: "09", sortOrder: 90 } });
      expect(patched.statusCode).toBe(200);
      const card = patched.json().cards[0];
      expect(card.objectRef.id).toBe("供应链能力");
      expect(card.objectRef.version).toBe(2);
      expect(card.payload).toEqual({
        capabilityId: "供应链能力",
        code: "09",
        sortOrder: 90,
        name: "区域仓配服务",
        group: "",
        sixMonthOutcome: "供应链能力六个月目标",
        supportRefs: [],
      });

      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: headers.cookie! } });
      const capabilityCard = home.json().cards.find((candidate: { id: string }) => candidate.id === "capability:供应链能力");
      expect(capabilityCard.title).toBe("区域仓配服务");

      const conflict = await t.app.inject({ method: "PATCH", url: "/api/config/capabilities/渠道能力", headers, payload: { name: "供应链能力" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("CAPABILITY_NAME_CONFLICT");

      const empty = await t.app.inject({ method: "PATCH", url: "/api/config/capabilities/供应链能力", headers, payload: {} });
      expect(empty.statusCode).toBe(400);
      const missing = await t.app.inject({ method: "PATCH", url: "/api/config/capabilities/不存在", headers, payload: { name: "新名" } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("rejects a battlefield rename onto a display name whose row id is not its slug", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("供应战场", "01") });

      // migration 种下的行是手写 id：growth 的显示名是增长战场，只比 id 会漏掉这个重名。
      const conflict = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { name: "增长战场" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("BATTLEFIELD_NAME_CONFLICT");

      const fresh = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { name: "供应链战场" } });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().cards[0].objectRef).toMatchObject({ id: "供应战场", version: 2 });
    } finally {
      await t.close();
    }
  });

  it("rejects a capability rename onto a display name of a hand-written id, and accepts clearing the owner", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.sql(`INSERT INTO capability_config (id, version, code, sort_order, name, "group", six_month_outcome) VALUES ('cap-legacy', 1, '07', 70, '渠道能力', '增长组织', '渠道数据')`);
      await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("供应能力", "01", { group: "交付组织" }) });

      const conflict = await t.app.inject({ method: "PATCH", url: "/api/config/capabilities/供应能力", headers, payload: { name: "渠道能力" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("CAPABILITY_NAME_CONFLICT");

      // 负责人允许清空（owner_id NOT NULL DEFAULT ''，界面显示“待指派”）。
      await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("供应战场", "01") });
      const cleared = await t.app.inject({ method: "PATCH", url: "/api/config/battlefields/供应战场", headers, payload: { ownerId: "" } });
      expect(cleared.statusCode).toBe(200);
      const management = await t.app.inject({ method: "GET", url: "/api/config/battlefields", headers: { cookie: headers.cookie! } });
      expect(management.json().battlefields.find((item: { id: string }) => item.id === "供应战场")).toMatchObject({ ownerId: "", ownerDisplayName: "" });
    } finally {
      await t.close();
    }
  });
});

describe("Mission code 全表唯一与旧引用清理", () => {
  it("rejects duplicate Mission codes inside one payload and across battlefields", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const samePayload = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("灯塔项目", "01", { missionAnchors: [{ code: "01-1", title: "A" }, { code: "01-1", title: "B" }] }),
      });
      expect(samePayload.statusCode).toBe(409);
      expect(samePayload.json().code).toBe("MISSION_ANCHOR_CODE_CONFLICT");

      expect(
        (await t.app.inject({
          method: "POST",
          url: "/api/config/battlefields",
          headers,
          payload: battlefieldBody("灯塔项目", "01", { missionAnchors: [{ code: "01-1", title: "A" }] }),
        })).statusCode,
      ).toBe(201);
      const cross = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("Token Ops", "02", { missionAnchors: [{ code: "01-1", title: "占用同一编号" }] }),
      });
      expect(cross.statusCode).toBe(409);
      expect(cross.json().code).toBe("MISSION_ANCHOR_CODE_CONFLICT");
    } finally {
      await t.close();
    }
  });

  it("rejects a patch that duplicates a Mission code, and clears removed refs with version+1", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("灯塔项目", "01", { missionAnchors: [{ code: "01-1", title: "未来组织范式" }, { code: "01-2", title: "CEO Agent" }] }),
      });
      await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: battlefieldBody("Token Ops", "02", { missionAnchors: [{ code: "02-1", title: "TokenHub 生产化" }] }),
      });
      const capability = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: capabilityBody("Method", "03", {
          supportRefs: [
            { type: "mission-anchor", missionCode: "01-1" },
            { type: "mission-anchor", missionCode: "01-2" },
            { type: "battlefield", battlefieldId: "灯塔项目" },
            { type: "all-battlefields" },
          ],
        }),
      });
      expect(capability.statusCode).toBe(201);

      const crossConflict = await t.app.inject({
        method: "PATCH",
        url: "/api/config/battlefields/token-ops",
        headers,
        payload: { missionAnchors: [{ code: "02-1", title: "TokenHub 生产化" }, { code: "01-1", title: "撞号" }] },
      });
      expect(crossConflict.statusCode).toBe(409);
      expect(crossConflict.json().code).toBe("MISSION_ANCHOR_CODE_CONFLICT");

      const sameConflict = await t.app.inject({
        method: "PATCH",
        url: "/api/config/battlefields/token-ops",
        headers,
        payload: { missionAnchors: [{ code: "02-1", title: "A" }, { code: "02-1", title: "B" }] },
      });
      expect(sameConflict.statusCode).toBe(409);
      expect(sameConflict.json().code).toBe("MISSION_ANCHOR_CODE_CONFLICT");

      const patched = await t.app.inject({
        method: "PATCH",
        url: "/api/config/battlefields/灯塔项目",
        headers,
        payload: { missionAnchors: [{ code: "01-1", title: "未来组织范式" }] },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().cards[0].objectRef.version).toBe(2);
      expect(patched.json().cards[0].payload.missionAnchors).toEqual([{ code: "01-1", title: "未来组织范式" }]);

      const capRow = await t.sql("SELECT version, support_refs FROM capability_config WHERE id = $1", ["method"]);
      expect(capRow[0]).toEqual({
        version: 2,
        support_refs: [
          { type: "mission-anchor", missionCode: "01-1" },
          { type: "battlefield", battlefieldId: "灯塔项目" },
          { type: "all-battlefields" },
        ],
      });
      const untouched = await t.sql("SELECT version FROM battlefield_config WHERE id = $1", ["token-ops"]);
      expect(untouched[0]).toEqual({ version: 1 });
    } finally {
      await t.close();
    }
  });
});
