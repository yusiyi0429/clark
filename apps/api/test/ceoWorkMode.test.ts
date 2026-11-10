import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEXUS_DRI_REQUESTS_PATH, nexusDriIdempotencyKey, type TNexusDriRequest } from "@warmap/contracts";
import { requestFingerprint } from "../src/nexusDri.js";
import { BOARD_NOW, boardFixture } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/**
 * CEO 的管理模式和工作模式（设计稿 17.2 第 45 条）：每个 CEO 角色的人都能切到成员视角（工作模式），不要求同时是负责人；
 * 切过去以后以本人的身份用新首页那一套接口。测试里的 CEO（测试甲）只有 CEO 角色。
 */
const CHAT_TOKEN = "chat-token";
const NEXUS_TOKEN = "nexus-token";
const SAMPLE: TNexusDriRequest = JSON.parse(readFileSync(new URL("./fixtures/nexus-dri-contract-examples.json", import.meta.url), "utf8")).request;

async function fixture() {
  const people = join(mkdtempSync(join(tmpdir(), "ceo-work-")), "people.json");
  writeFileSync(people, JSON.stringify({ people: { [TEST_CEO.personId]: "synthetic-human" } }));
  const f = await boardFixture({}, { boardCloudAgents: false, internalChatToken: CHAT_TOKEN, worldInstanceLocalFile: people,
    nexusDri: { serviceToken: NEXUS_TOKEN, tenantId: SAMPLE.recipientTenant, agentId: SAMPLE.agentId } });
  const ceo = await f.t.loginCookie();
  const switchTo = (cookie: string, view: "ceo" | "member") =>
    f.t.app.inject({ method: "POST", url: "/api/auth/view", headers: { cookie, origin: f.t.publicOrigin }, payload: { view } });
  const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0];
  return { ...f, ceo, switchTo, cookieOf };
}

describe("CEO 的管理模式和工作模式（17.2 第 45 条）", { timeout: 60_000 }, () => {
  it("只有 CEO 角色的人也能切到工作模式，切过去留在那；管理模式的接口和工作模式的接口各认各的视角；只有负责人身份的人没有切换", async () => {
    const f = await fixture();
    try {
      const session = async (cookie: string) => (await f.call("GET", "/api/auth/session", undefined, cookie)).json();
      expect(await session(f.ceo)).toMatchObject({ personId: TEST_CEO.personId, role: "ceo", canSwitchView: true });
      expect((await f.call("GET", "/api/cards/home", undefined, f.ceo)).statusCode).toBe(200);
      expect((await f.call("GET", "/api/me/work-home", undefined, f.ceo)).statusCode).toBe(403);

      const switched = await f.switchTo(f.ceo, "member");
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ personId: TEST_CEO.personId, role: "member", canSwitchView: true });
      const work = f.cookieOf(switched);
      // 刷新不跳回：带着新会话再读还是工作模式。
      expect(await session(work)).toMatchObject({ role: "member", canSwitchView: true });
      expect((await f.call("GET", "/api/me/work-home", undefined, work)).statusCode).toBe(200);
      expect((await f.call("GET", "/api/cards/home", undefined, work)).statusCode).toBe(403);

      const back = await f.switchTo(work, "ceo");
      expect(back.json()).toMatchObject({ role: "ceo", canSwitchView: true });
      expect((await f.call("GET", "/api/cards/home", undefined, f.cookieOf(back))).statusCode).toBe(200);

      // 只有负责人身份的人：不能切，登录就是成员视角。
      const member = await f.t.memberCookie();
      expect(await session(member)).toMatchObject({ personId: TEST_MEMBER.personId, role: "member", canSwitchView: false });
      expect((await f.switchTo(member, "ceo")).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("工作模式里以本人的身份用新首页：首页数据、项目、子会话、配对电脑和同步、伙伴授权和伙伴动作、Chat 以成员视角回读", async () => {
    const f = await fixture();
    try {
      const work = f.cookieOf(await f.switchTo(f.ceo, "member"));
      const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => f.call(method, url, payload, work);

      // 首页那几样：work-home、老成员首页轮询的 /api/me/home、后台任务。
      const home = await call("GET", "/api/me/work-home");
      expect(home.json()).toMatchObject({ projects: [], waiting: [] });
      expect((await call("GET", "/api/me/home")).statusCode).toBe(200);
      expect((await call("GET", "/api/me/background?scope=main")).statusCode).toBe(200);

      // 项目：建、读、改名，是本人自己的。
      const created = await call("POST", "/api/me/projects", { name: "CEO 自己的项目" });
      expect(created.statusCode, created.body).toBe(201);
      const projectId = created.json().projectId as string;
      expect((await call("GET", `/api/me/projects/${projectId}`)).json()).toMatchObject({ project: { name: "CEO 自己的项目" } });
      expect((await call("GET", "/api/me/work-home")).json().projects.map((project: { name: string }) => project.name)).toEqual(["CEO 自己的项目"]);

      // 子会话：开一个探索专题。
      const topic = await call("POST", "/api/me/topics", { title: "看看竞品" });
      expect(topic.statusCode, topic.body).toBe(201);

      // 本机程序：配对一台电脑，设备令牌能同步。
      const deviceId = randomUUID();
      const paired = await call("POST", "/api/me/local-devices", { deviceId, name: "CEO 的电脑", os: "win32" });
      expect(paired.statusCode).toBe(201);
      const sync = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${paired.json().token}` },
        payload: { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: [] } });
      expect(sync.statusCode, sync.body).toBe(200);

      // 伙伴：授权；伙伴以本人身份做写动作（服务端签的是成员视角的会话，只有 CEO 角色的人也要认）。
      expect((await call("PUT", "/api/me/buddy-authority", { authority: "full" })).json()).toMatchObject({ authority: "full" });
      const act = (name: string, args: unknown) => f.t.app.inject({ method: "POST", url: `/internal/me/buddy-actions/${name}`,
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_CEO.personId }, payload: { args } });
      const renamed = await act("rename_project", { projectId, name: "CEO 的项目（改过）" });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await act("read_work_home", {})).json().result.projects.map((project: { name: string }) => project.name)).toEqual(["CEO 的项目（改过）"]);

      // Chat 以成员视角回读宿主接口：只有 CEO 角色的人也放行。
      const hostRead = await f.t.app.inject({ method: "GET", url: "/internal/scheduled-meetings",
        headers: { authorization: `Bearer ${CHAT_TOKEN}`, "x-owner-id": TEST_CEO.personId, "x-viewer-role": "member" } });
      expect(hostRead.statusCode, hostRead.body).toBe(200);
    } finally { await f.close(); }
  });

  it("等你：Nexus 推给 CEO 本人的待定事项在工作模式里确认；管理模式下读得到「有几件等你」", async () => {
    const f = await fixture();
    try {
      const count = async (cookie: string) => (await f.call("GET", "/api/me/work-home/waiting-count", undefined, cookie)).json();
      expect(await count(f.ceo)).toEqual({ count: 0 });

      const base = { ...SAMPLE, createdAt: BOARD_NOW.getTime(), expiresAt: BOARD_NOW.getTime() + 3_600_000 };
      const request = { ...base, fingerprint: requestFingerprint(base) };
      const pushed = await f.t.app.inject({ method: "POST", url: NEXUS_DRI_REQUESTS_PATH, payload: JSON.stringify(request),
        headers: { authorization: `Bearer ${NEXUS_TOKEN}`, "content-type": "application/json", "idempotency-key": nexusDriIdempotencyKey(request.requestId, request.revision) } });
      expect(pushed.statusCode, pushed.body).toBe(200);

      // 管理模式：读不了 work-home，但知道有 1 件等你。
      expect(await count(f.ceo)).toEqual({ count: 1 });
      expect((await f.call("GET", "/api/me/work-home", undefined, f.ceo)).statusCode).toBe(403);

      // 工作模式：在「等你」里，本人确认。
      const work = f.cookieOf(await f.switchTo(f.ceo, "member"));
      const waiting = (await f.call("GET", "/api/me/work-home", undefined, work)).json().waiting as { kind: string; title: string; confirmation?: { id: string } }[];
      expect(waiting).toMatchObject([{ kind: "nexus_confirmation", title: SAMPLE.question }]);
      expect(await count(work)).toEqual({ count: 1 });
      const decided = await f.call("POST", `/api/me/nexus-confirmations/${waiting[0].confirmation!.id}/decision`, { decision: "confirmed" }, work);
      expect(decided.statusCode, decided.body).toBe(200);
      expect(await count(work)).toEqual({ count: 0 });
      // 没登录读不到。
      expect((await f.t.app.inject({ method: "GET", url: "/api/me/work-home/waiting-count" })).statusCode).toBe(401);
    } finally { await f.close(); }
  });
});
