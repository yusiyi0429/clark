import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { THIRD, boardFixture } from "./boardFixture.js";

const markdown = (title: string, text: string) => {
  const buffer = Buffer.from(text);
  return ["artifact", { artifactId: `a-${randomUUID().slice(0, 6)}`, title, fileName: `${title}.md`, mimeType: "text/markdown", size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"), contentBase64: buffer.toString("base64") }] as [string, unknown];
};

describe("调研专题", () => {
  it("新建挂 Task 和岗位；本机报来的提纲、各稿、评审按顺序编号；详情带各版本、最新一版正文和本机执行；归档的不在列表里", async () => {
    const f = await boardFixture();
    try {
      const role = (await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json();
      const created = await f.call("POST", "/api/me/topics", { title: " 竞品调研 ", planTaskId: "task-open", roleId: role.id });
      expect(created.statusCode).toBe(201);
      const topic = created.json();
      expect(topic).toMatchObject({ title: "竞品调研", status: "active", planTaskId: "task-open", missionId: "mine", role: { id: role.id, kind: "worker" },
        latestVersion: null, run: null, lastVersionAt: null });
      expect((await f.call("POST", "/api/me/topics", { title: "x", planTaskId: "task-other" })).json()).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect((await f.call("POST", "/api/me/topics", { title: "x", roleId: randomUUID() })).json()).toMatchObject({ code: "ROLE_NOT_FOUND" });
      const loose = (await f.call("POST", "/api/me/topics", { title: "随手查查" })).json();
      expect(loose).toMatchObject({ planTaskId: null, missionId: null, role: null });

      const local = await f.local();
      await local.send({ kind: "topic", topicId: topic.id }, [["status", { status: "running", title: "竞品调研", agent: "claude-code", modelLabel: "订阅" }],
        markdown("提纲", "# 提纲\n- 三家"), markdown("调研", "# 第一稿"), markdown("评审", "# 分歧和建议"), markdown("调研", "# 第二稿"),
        ["status", { status: "idle", title: "竞品调研", agent: "claude-code", modelLabel: "订阅" }]]);
      const detail = (await f.call("GET", `/api/me/topics/${topic.id}`)).json();
      expect(detail.topic).toMatchObject({ latestVersion: { number: 4, kind: "draft", label: "第 2 版" }, run: { state: "idle", deviceName: "我的电脑" } });
      expect(detail.task).toEqual({ taskId: "task-open", name: "对话质量达标" });
      expect(detail.versions.map((version: { number: number; kind: string; label: string }) => [version.number, version.kind, version.label]))
        .toEqual([[4, "draft", "第 2 版"], [3, "review", "评审"], [2, "draft", "第 1 版"], [1, "outline", "提纲"]]);
      expect(detail.current).toMatchObject({ number: 4, body: "# 第二稿", deliverable: null });
      expect(detail.runs).toHaveLength(1);
      expect((await f.call("GET", `/api/me/topics/${topic.id}/versions/1`)).json()).toMatchObject({ kind: "outline", body: "# 提纲\n- 三家" });
      expect((await f.call("GET", `/api/me/topics/${topic.id}/versions/9`)).statusCode).toBe(404);

      await f.call("POST", "/api/plan-tasks/task-open/deliverable/pending", { topicVersionId: detail.versions[0].id });
      expect((await f.call("GET", `/api/me/topics/${topic.id}`)).json().versions[0].deliverable).toEqual({ state: "pending", versionNumber: 1 });

      // 新动静的在前：专题最后一版是本机 01:00 报的，随手查查是 02:00 建的。
      expect((await f.call("GET", "/api/me/topics")).json().topics.map((item: { title: string }) => item.title)).toEqual(["随手查查", "竞品调研"]);
      expect((await f.call("PATCH", `/api/me/topics/${loose.id}`, { status: "archived", title: "不查了" })).json()).toMatchObject({ status: "archived", title: "不查了" });
      expect((await f.call("GET", "/api/me/topics")).json().topics.map((item: { title: string }) => item.title)).toEqual(["竞品调研"]);
      expect((await f.call("GET", "/api/me/topics?status=archived")).json().topics.map((item: { title: string }) => item.title)).toEqual(["不查了"]);
      expect((await f.call("PATCH", `/api/me/topics/${loose.id}`, {})).statusCode).toBe(400);

      const third = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
      const cookie = (third.headers["set-cookie"] as string).split(";")[0];
      expect((await f.call("GET", `/api/me/topics/${topic.id}`, undefined, cookie)).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("开专题的交代带 Mission、Task、标准、岗位和评审会的挑刺岗位；可以点名挑刺岗位，点的不是本人的 400", async () => {
    const f = await boardFixture();
    try {
      const role = (await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json();
      const opponent = (await f.call("POST", "/api/me/roles", { presetKey: "opponent" })).json();
      const reader = (await f.call("POST", "/api/me/roles", { name: "读者视角", family: "general", kind: "critic", acceptanceMd: "外行看得懂" })).json();
      const topic = (await f.call("POST", "/api/me/topics", { title: "竞品调研", planTaskId: "task-open", roleId: role.id })).json();
      const brief = (await f.call("GET", `/api/me/topics/${topic.id}/brief`)).json();
      expect(brief).toMatchObject({ title: "竞品调研", latestVersion: null, role: { id: role.id, name: role.name, kind: "worker", version: 1 } });
      expect(brief.critics.map((item: { id: string }) => item.id).sort()).toEqual([opponent.id, reader.id].sort());
      expect(brief.critics.find((item: { id: string }) => item.id === reader.id)).toMatchObject({ name: "读者视角", kind: "critic", acceptanceMd: "外行看得懂" });
      for (const text of ["# 调研专题：竞品调研", "Mission：内部版上线", "Task：对话质量达标", `岗位：${role.name}`, "1. 有题库打分结果", "2. 有新人上手录屏"])
        expect(brief.markdown).toContain(text);
      expect((await f.call("GET", `/api/me/topics/${topic.id}/brief?critics=${reader.id}`)).json().critics.map((item: { id: string }) => item.id)).toEqual([reader.id]);
      expect((await f.call("GET", `/api/me/topics/${topic.id}/brief?critics=${role.id}`)).json()).toMatchObject({ code: "INVALID_CRITICS" });
    } finally { await f.close(); }
  });
});
