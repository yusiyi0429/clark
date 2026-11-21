// 会话里 Claude Code 自己开的后台任务（子 agent、后台命令）：报成后台任务给网页和云端，跑完、失败、被停都更新，能单独停（首页右栏「后台任务」）。
// 假 claude 照 11/07 真机抓到的形状发 system/task_started、task_updated、task_notification，收到 stop_task 就停。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

function fakeCloud() {
  const items: any[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/local-runner/sync") return new Response("{}", { status: 404 });
    const body = JSON.parse(init.body);
    items.push(...body.items);
    return new Response(JSON.stringify({ accepted: body.items.map((i: any) => i.key), rejected: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, items };
}

/** 假 claude 的记录（收到的权限答复、stop_task）。 */
const trace = (work: string): any[] => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * 假 claude 的配置写在文件夹里；repo 时做成 git 仓库（配置提交进去，卡的工作树里也有，记录文件忽略）。
 * noCloud 时不关联云端（发件箱送出后会顺带排一次队，关联了就测不出后台任务结束时自己排队）。
 */
async function setup(cfg: Record<string, unknown>, opts: { reuse?: { dataDir: string; work: string; token: string }; repo?: boolean; noCloud?: boolean } = {}) {
  const { reuse, repo: isRepo } = opts;
  const work = reuse?.work ?? tempDir("tl-bg-");
  if (!reuse) {
    writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ background: true, ...cfg }));
    if (isRepo) {
      writeFileSync(join(work, ".gitignore"), ".fake-claude-trace.jsonl\n");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=测试", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", "add", "-A");
      git(work, "-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
    }
  }
  const cloud = fakeCloud();
  const t = await startTestRunner({ pickFolder: work, fetchImpl: cloud.impl, dataDir: reuse?.dataDir });
  const token = reuse?.token ?? await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  if (!reuse) {
    await call("POST", "/v1/folders/pick", {});
    if (!opts.noCloud) expect((await call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "cloud-token-0123456789abcdef" })).status).toBe(200);
  }
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (title: string) => (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: work, firstMessage: `做 ${title}` })).body;
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const item = async (id: string, itemId: string) => ((await session(id)).background ?? []).find((b: any) => b.id === itemId);
  const stop = (id: string, itemId: string) => call("POST", `/v1/sessions/${id}/background/${itemId}/stop`, {});
  const statuses = (id: string) => events(id).filter((e) => e.type === "status").map((e) => e.status);
  return { t, work, token, cloud, call, session, open, events, item, stop, statuses };
}

describe("会话里的后台任务", { timeout: 30_000 }, () => {
  it("子 agent 和放到后台的命令报成后台任务（前台命令、内部任务不报）；跑完了更新、Claude Code 自己开的那一轮算在跑；能单独停；都同步上去", async () => {
    const h = await setup({ agentMs: 400 });
    try {
      const a = await h.open("A");
      const both = await until(async () => { const s = await h.session(a.id); return s.background?.length === 2 ? s.background : null; });
      expect(both).toEqual([
        { id: "bgtask1", title: "后台等一会儿", kind: "command", state: "running", startedAt: expect.any(String), finishedAt: null, stoppable: true },
        { id: "agent1", title: "数文件", kind: "subagent", state: "running", startedAt: expect.any(String), finishedAt: null, stoppable: true },
      ]);

      // 子 agent 跑完：done，Claude Code 自己开一轮（会话又在跑，跑完回到等你回复）
      const done = await until(async () => { const b = await h.item(a.id, "agent1"); return b?.state === "done" ? b : null; });
      expect(done).toMatchObject({ stoppable: false, finishedAt: expect.any(String) });
      await until(() => h.events(a.id).some((e) => e.type === "assistant_text" && e.text === "子 agent 回来了：2 个文件"));
      await until(async () => (await h.session(a.id)).status === "idle");
      const statuses = h.events(a.id).filter((e) => e.type === "status").map((e) => e.status);
      expect(statuses.slice(statuses.indexOf("idle"))).toEqual(["idle", "running", "idle"]);

      // 停后台命令：会话本身不停
      const stopped = await h.stop(a.id, "bgtask1");
      expect(stopped.status).toBe(200);
      expect(stopped.body.session.background.find((b: any) => b.id === "bgtask1")).toMatchObject({ state: "stopped", stoppable: false, finishedAt: expect.any(String) });
      expect(stopped.body.session.status).toBe("idle");
      expect((await h.stop(a.id, "bgtask1")).status).toBe(409); // 已经停了
      expect((await h.stop(a.id, "fg1")).status).toBe(409); // 前台命令不算后台任务
      expect(trace(h.work).filter((l) => l.stopTask).map((l) => l.stopTask)).toEqual(["bgtask1"]); // 后两次本机就回了，没去问 Claude Code

      // 只报了这两个，每次变化一条事件、一条同步
      const evs = h.events(a.id).filter((e) => e.type === "background").map((e) => `${e.item.id}:${e.item.state}`);
      expect(evs).toEqual(["bgtask1:running", "agent1:running", "agent1:done", "bgtask1:stopped"]);
      await until(() => h.cloud.items.filter((i) => i.type === "background").length === 4);
      const synced = h.cloud.items.filter((i) => i.type === "background");
      expect(synced.map((i) => `${i.data.id}:${i.data.state}`)).toEqual(evs);
      expect(synced.every((i) => i.sessionId === a.id && i.subject.cardId === "A")).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("进程退出时还在跑的后台任务算被停了；本机程序上次没正常退出、重启后也是", async () => {
    const h = await setup({ agentMs: 60_000 }); // 子 agent 一直不回来
    let r: Awaited<ReturnType<typeof setup>> | null = null;
    try {
      const a = await h.open("A");
      await until(async () => (await h.session(a.id)).background?.length === 2);
      await h.call("POST", `/v1/sessions/${a.id}/kill`, {});
      const after = await until(async () => { const s = await h.session(a.id); return s.status === "exited" ? s.background : null; });
      expect(after.map((b: any) => [b.id, b.state, b.stoppable])).toEqual([["bgtask1", "stopped", false], ["agent1", "stopped", false]]);
      expect((await h.stop(a.id, "agent1")).status).toBe(409);

      // 模拟本机程序被硬关：记录里还写着在跑
      const file = join(h.t.dataDir, "sessions", a.id, "session.json");
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec.background[1] = { ...rec.background[1], state: "running", finishedAt: null, stoppable: true };
      await h.t.runner.close();
      writeFileSync(file, JSON.stringify(rec));
      r = await setup({}, { reuse: { dataDir: h.t.dataDir, work: h.work, token: h.token } });
      expect((await r.item(a.id, "agent1"))).toMatchObject({ state: "stopped", stoppable: false });
    } finally {
      await (r ?? h).t.cleanup();
    }
  });

  it("后台子 agent 在主轮结束前来要权限：这一轮结束了也留着、会话等你批准；批了回到等你回复，子 agent 跑完 Claude Code 自己开一轮", async () => {
    const h = await setup({ subagentAsks: "before" });
    try {
      const a = await h.open("A");
      await until(async () => (await h.session(a.id)).status === "waiting_permission");
      await until(() => h.events(a.id).some((e) => e.type === "turn_end"));
      const body = (await h.call("GET", `/v1/sessions/${a.id}`)).body;
      expect(body.session.status).toBe("waiting_permission"); // 主轮结束后还在等
      expect(body.pendingPermissions.map((p: any) => p.requestId)).toEqual(["perm-agent1"]);
      expect(h.events(a.id).some((e) => e.type === "permission_resolved" && e.requestId === "perm-agent1")).toBe(false);

      expect((await h.call("POST", `/v1/sessions/${a.id}/permissions/perm-agent1`, { decision: "allow" })).status).toBe(200);
      await until(async () => (await h.item(a.id, "agent1"))?.state === "done");
      await until(() => h.events(a.id).some((e) => e.type === "assistant_text" && e.text === "子 agent 回来了：2 个文件"));
      await until(async () => (await h.session(a.id)).status === "idle");
      expect(trace(h.work).find((l) => l.subagentPermission)?.subagentPermission).toMatchObject({ behavior: "allow" });
      const st = h.statuses(a.id);
      expect(st.slice(st.indexOf("waiting_permission"))).toEqual(["waiting_permission", "idle", "running", "idle"]);
    } finally {
      await h.t.cleanup();
    }
  });

  it("后台子 agent 在主轮结束后才来要权限（真机的顺序）：等你批准；把子 agent 停了，请求作废，会话回到等你回复（不卡在在跑）", async () => {
    const h = await setup({ subagentAsks: "after" });
    try {
      const a = await h.open("A");
      await until(() => h.events(a.id).some((e) => e.type === "turn_end"));
      await until(async () => (await h.session(a.id)).status === "waiting_permission");
      expect((await h.stop(a.id, "agent1")).status).toBe(200);
      await until(async () => (await h.session(a.id)).status === "idle");
      const body = (await h.call("GET", `/v1/sessions/${a.id}`)).body;
      expect(body.pendingPermissions).toEqual([]);
      expect(body.session.background.find((b: any) => b.id === "agent1")).toMatchObject({ state: "stopped" });
      expect(h.events(a.id).find((e) => e.type === "permission_resolved" && e.requestId === "perm-agent1")).toMatchObject({ decision: "deny", message: "子 agent 已结束" });
      const st = h.statuses(a.id);
      expect(st.slice(st.indexOf("waiting_permission"))).toEqual(["waiting_permission", "idle"]);
    } finally {
      await h.t.cleanup();
    }
  });

  it("后台子 agent 的权限请求和主轮的提问同时在等：算等你批准；先批回到等你回复（还在等回答，不算在跑），先答还是等你批准", async () => {
    const both = async (h: Awaited<ReturnType<typeof setup>>) => {
      const a = await h.open("A");
      // 命令的请求等开工那份留好才转过来（11/11 留一份，最多 10 秒）：等两件都到了再看
      await until(async () => { const b = (await h.call("GET", `/v1/sessions/${a.id}`)).body; return b.session.pendingQuestion && b.pendingPermissions.length; });
      const body = (await h.call("GET", `/v1/sessions/${a.id}`)).body;
      expect([body.session.status, body.pendingPermissions.map((p: any) => p.requestId)]).toEqual(["waiting_permission", ["perm-agent1"]]);
      return a;
    };
    const allow = (h: Awaited<ReturnType<typeof setup>>, id: string) => h.call("POST", `/v1/sessions/${id}/permissions/perm-agent1`, { decision: "allow" });
    const answer = (h: Awaited<ReturnType<typeof setup>>, id: string) => h.call("POST", `/v1/sessions/${id}/questions/ask-bg`, { choices: [["做"]] });

    const h = await setup({ subagentAsks: "question" });
    try {
      const a = await both(h);
      expect((await allow(h, a.id)).status).toBe(200);
      expect((await h.session(a.id)).status).toBe("idle");
      expect((await answer(h, a.id)).body.session.status).toBe("running");
      await until(async () => (await h.session(a.id)).status === "idle"); // 假 claude 收到回答就结束这一轮
    } finally {
      await h.t.cleanup();
    }

    const g = await setup({ subagentAsks: "question" });
    try {
      const a = await both(g);
      expect((await answer(g, a.id)).body.session.status).toBe("waiting_permission");
      await until(() => g.events(a.id).some((e) => e.type === "turn_end"));
      expect((await g.session(a.id)).status).toBe("waiting_permission"); // 这一轮结束了，子 agent 的请求还在等
      expect((await allow(g, a.id)).status).toBe(200);
      expect((await g.session(a.id)).status).toBe("idle");
    } finally {
      await g.t.cleanup();
    }
  });

  it("先在前台跑、后来移到后台的命令从那时起报；没写说明用「后台命令」；失败了报 failed；只来 task_updated 或只来 task_notification 都认", async () => {
    const h = await setup({ moreTasks: true, agentMs: 100 });
    try {
      const a = await h.open("A");
      const fg2 = await until(async () => { const b = await h.item(a.id, "fg2"); return b?.state === "failed" ? b : null; });
      expect(fg2).toEqual({ id: "fg2", title: "后台命令", kind: "command", state: "failed", startedAt: expect.any(String), finishedAt: expect.any(String), stoppable: false });
      expect(h.events(a.id).filter((e) => e.type === "background" && e.item.id === "fg2").map((e) => e.item.state)).toEqual(["running", "failed"]);
      expect((await h.stop(a.id, "fg2")).status).toBe(409);
      expect(await until(async () => { const b = await h.item(a.id, "fg3"); return b?.state === "done" ? b : null; })).toMatchObject({ title: "跑测试", kind: "command", stoppable: false });
    } finally {
      await h.t.cleanup();
    }
  });

  it("后台任务还在跑：同一个不是仓库的文件夹里，下一张卡排队，停掉以后开工（没关联云端也是）；卡在工作树里做时不让合回", async () => {
    const h = await setup({ agentMs: 50 }, { noCloud: true });
    try {
      const a = await h.open("A");
      await until(async () => (await h.item(a.id, "agent1"))?.state === "done");
      await until(async () => (await h.session(a.id)).status === "idle"); // A 这一轮做完了，bgtask1 还在跑
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      await new Promise((r) => setTimeout(r, 300));
      expect((await h.session(b.id)).status).toBe("queued");
      expect((await h.stop(a.id, "bgtask1")).status).toBe(200);
      await until(async () => (await h.session(b.id)).status !== "queued");
    } finally {
      await h.t.cleanup();
    }
    const g = await setup({ agentMs: 50 }, { repo: true });
    try {
      const a = await g.open("A");
      expect(a.workspace.kind).toBe("worktree");
      await until(async () => (await g.item(a.id, "agent1"))?.state === "done");
      await until(async () => (await g.session(a.id)).status === "idle");
      const merge = () => g.call("POST", `/v1/sessions/${a.id}/merge`, {});
      const blocked = await merge();
      expect([blocked.status, blocked.body.error.message]).toEqual([409, "卡还有后台任务在跑，等它们结束或停掉再合"]);
      expect((await g.stop(a.id, "bgtask1")).status).toBe(200);
      expect((await merge()).body.error?.message ?? "").not.toContain("后台任务");
    } finally {
      await g.t.cleanup();
    }
  });
});
