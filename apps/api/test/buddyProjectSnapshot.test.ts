import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { runAction, type BuddyDeps } from "../src/buddyActions.js";
import type { Query } from "../src/meetingStore.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const call = { personId: "owner", conversationId: null, runId: null };

async function fixture(options: { listed?: boolean; denied?: boolean; homeFailed?: boolean } = {}) {
  const app = Fastify();
  const requests: { url: string; cookie: string | undefined; origin: string | undefined }[] = [];
  app.addHook("onRequest", async (request) => { requests.push({ url: request.url, cookie: request.headers.cookie, origin: request.headers.origin }); });
  const subSessions = [{ id: "one", title: "会议确认", state: "waiting", waiting: null, stopWhy: "turn_done" }];
  app.get(`/api/me/projects/${PROJECT}`, async (_request, reply) => options.denied
    ? reply.code(404).send({ code: "NOT_FOUND", message: "项目不存在" }) : { project: { projectId: PROJECT, name: "天枢" } });
  app.get(`/api/me/projects/${PROJECT}/feed`, async () => ({ items: [{ id: "report", kind: "sub_session_report" }] }));
  app.get("/api/me/work-home", async (_request, reply) => options.homeFailed
    ? reply.code(503).send({ code: "READ_FAILED", message: "暂时读不到状态" })
    : { projects: [...(options.listed === false ? [] : [{ projectId: PROJECT, subSessions }]), { projectId: OTHER, subSessions: [{ id: "private-other" }] }] });
  const q = vi.fn(async (sql: string) => {
    if (sql !== "SELECT session_version FROM member_access WHERE person_id = $1") throw new Error(`Unexpected query: ${sql}`);
    return { rows: [{ session_version: 1 }], rowCount: 1, command: "SELECT", fields: [], oid: 0 };
  });
  const deps: BuddyDeps = { app, q: q as Query, env: { sessionSecret: "test-secret", publicOrigin: "https://test.local" },
    now: () => new Date("2026-11-13T02:00:00Z"), names: () => new Map(), history: vi.fn() };
  return { app, deps, requests, subSessions };
}

describe("伙伴读取项目的当前子会话状态", () => {
  it("保留项目与动态，只补当前项目的原始状态；按本人身份读取，不执行写操作", async () => {
    const f = await fixture();
    try {
      const result = await runAction(f.deps, call, "read_project", { projectId: PROJECT });
      expect(result).toMatchObject({ auditId: null, undoable: false, result: {
        project: { projectId: PROJECT }, feed: { items: [{ id: "report" }] }, subSessions: f.subSessions,
      } });
      expect(JSON.stringify(result.result)).not.toContain("private-other");
      expect(f.requests.every((request) => request.cookie?.includes("=") && request.origin === "https://test.local")).toBe(true);
    } finally { await f.app.close(); }
  });

  it("先检查项目读取权限；404时不额外读取首页和动态", async () => {
    const f = await fixture({ denied: true });
    try {
      await expect(runAction(f.deps, call, "read_project", { projectId: PROJECT })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(f.requests.map((request) => request.url)).toEqual([`/api/me/projects/${PROJECT}`]);
    } finally { await f.app.close(); }
  });

  it("首页未列出的项目明确返回未知，不把缺失当成零个子会话", async () => {
    const f = await fixture({ listed: false });
    try {
      expect((await runAction(f.deps, call, "read_project", { projectId: PROJECT })).result).toMatchObject({ subSessions: null });
    } finally { await f.app.close(); }
  });

  it("状态读取失败沿用真实错误，不回成功的空列表", async () => {
    const f = await fixture({ homeFailed: true });
    try {
      await expect(runAction(f.deps, call, "read_project", { projectId: PROJECT })).rejects.toMatchObject({ status: 503, code: "READ_FAILED" });
    } finally { await f.app.close(); }
  });
});
