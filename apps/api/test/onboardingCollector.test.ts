import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeishuClient } from "../src/feishu/client.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";
import { createTestApp, TEST_MEMBER } from "./helpers.js";

/** 上手流程：安装采集器（一行命令拉的脚本）、后台扫描（心跳带本机清单）、最后一页的工作依据清单与搬家清单。 */
const device = { id: "dev-0001-abcdef", name: "工作机", platform: "windows" as const };
const sources = [{ source: "codex", status: "ok" as const, coverageUntil: null, lastNewEvidenceAt: null, errorCode: null }];
const feishuUrl = "https://example.feishu.cn/docx/AbCdEfGh123";
const inventory = (tasks: string[]) => ({
  scheduledTasks: tasks.map((name) => ({ name, schedule: "Daily", command: "python weekly.py" })),
  feishuDocs: [{ url: feishuUrl, title: null, readAt: "2026-10-09T01:00:00.000Z" }],
  memoryFiles: [{ source: "claude", path: "~/.claude/projects/a/memory/MEMORY.md", bytes: 120, modifiedAt: "2026-10-08T01:00:00.000Z" }],
});

async function collectorToken(f: Fixture) {
  const created = await call(f, f.member, "POST", "/api/me/tokens", { name: "本机采集器", client: "collector", expiresInDays: 90 });
  return created.json().token as string;
}
/** 本人在上手流程的采集器那一步打开「同意采集」（D-18）。 */
async function consent(f: Fixture, granted = true) {
  expect((await call(f, f.member, "PUT", "/api/me/collector/consent", { granted })).statusCode).toBe(200);
}
const beat = (f: Fixture, bearer: string, extra: Record<string, unknown> = {}) => f.t.app.inject({
  method: "POST", url: "/api/collector/heartbeat", headers: { authorization: `Bearer ${bearer}` }, payload: { device, version: "0.2.0", sources, ...extra },
});

describe("上手流程的采集器与两个清单", () => {
  it("一行安装命令拉的脚本和 Python 文件公开下载，不带 BOM、统一 LF；只发白名单里的文件", async () => {
    const f = await executionFixture();
    try {
      const ps1 = await f.t.app.inject({ method: "GET", url: "/api/collector/install.ps1" });
      expect(ps1.statusCode).toBe(200);
      expect(ps1.headers["content-type"]).toContain("charset=utf-8");
      expect(ps1.body.charCodeAt(0)).not.toBe(0xfeff);
      expect(ps1.body).toContain("[string]$Token");
      expect(ps1.body).not.toContain("\r\n");
      const sh = await f.t.app.inject({ method: "GET", url: "/api/collector/install.sh" });
      expect(sh.body.startsWith("#!/bin/sh")).toBe(true);
      expect(sh.body).toContain("--token");
      const py = await f.t.app.inject({ method: "GET", url: "/api/collector/files/tkos_collector.py" });
      expect(py.statusCode).toBe(200);
      expect(py.body).toContain("def full_inventory");
      for (const name of ["README.md", "install-windows.ps1", "..%2F..%2Fpackage.json", "test_sanitize.py"])
        expect((await f.t.app.inject({ method: "GET", url: `/api/collector/files/${name}` })).statusCode).toBe(404);
    } finally { await f.t.close(); }
  });

  it("心跳带上的本机清单：状态里有设备、盘点时刻和条数；定时任务、记忆文件只算最近一次盘点里还在的", async () => {
    const f = await executionFixture();
    try {
      const empty = await call(f, f.member, "GET", "/api/me/collector/status");
      expect(empty.json()).toEqual({ consent: false, devices: [], scannedAt: null, inventory: { scheduledTasks: 0, feishuDocs: 0, memoryFiles: 0 } });
      const bearer = await collectorToken(f);
      expect((await beat(f, bearer)).statusCode).toBe(200);
      const connected = (await call(f, f.member, "GET", "/api/me/collector/status")).json();
      expect(connected.devices).toMatchObject([{ id: device.id, name: "工作机", platform: "windows" }]);
      expect(connected.scannedAt).toBeNull();

      await consent(f);
      expect((await beat(f, bearer, { inventory: inventory(["周报汇总", "TkosCollector"]) })).json()).toMatchObject({ consent: true });
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json()).toMatchObject({
        scannedAt: expect.any(String), inventory: { scheduledTasks: 2, feishuDocs: 1, memoryFiles: 1 } });
      f.setNow(new Date("2026-10-10T03:00:00.000Z"));
      await beat(f, bearer, { inventory: { ...inventory(["TkosCollector"]), memoryFiles: [] } });
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json().inventory).toEqual({ scheduledTasks: 1, feishuDocs: 1, memoryFiles: 0 });
      // 别人看不到本人的设备和清单。
      expect((await call(f, f.third, "GET", "/api/me/collector/status")).json().devices).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("本人同意之前本机清单一律不收：心跳和上报里夹带的都丢掉，回给采集器 consent=false；撤回同意时清空", async () => {
    const f = await executionFixture();
    try {
      const bearer = await collectorToken(f);
      const refused = await beat(f, bearer, { inventory: inventory(["周报汇总"]) });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({ consent: false });
      const report = { device, version: "0.1.0", kind: "digest", windowStart: "2026-10-10T00:00:00.000Z", windowEnd: "2026-10-10T01:00:00.000Z",
        sources, items: [], inventory: inventory(["日报提醒"]) };
      expect((await f.t.app.inject({ method: "POST", url: "/api/collector/reports", headers: { authorization: `Bearer ${bearer}` }, payload: report })).statusCode).toBe(200);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM local_inventory")).toEqual([{ n: 0 }]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM collector_scans")).toEqual([{ n: 0 }]);
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json()).toMatchObject({ consent: false, scannedAt: null, devices: [{ id: device.id }] });
      expect((await call(f, f.member, "GET", "/api/me/schedule-migration")).json().candidates).toEqual([]);

      await consent(f);
      await f.t.app.inject({ method: "POST", url: "/api/collector/reports", headers: { authorization: `Bearer ${bearer}` }, payload: report });
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json()).toMatchObject({ consent: true, inventory: { scheduledTasks: 1, feishuDocs: 1 } });
      await consent(f, false);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM local_inventory")).toEqual([{ n: 0 }]);
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json()).toMatchObject({ consent: false, scannedAt: null });
    } finally { await f.t.close(); }
  });

  it("工作依据清单：执行事项里的材料带修订号、链接和读过的飞书文档；勾选的入库，没勾的移出，候选外的 key 拒收", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const material = randomUUID(), link = randomUUID();
      await f.t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,current_version,created_at,updated_at)
        VALUES($1,'task',$2,'M2 战略解码.md','markdown',10,'agent',$3,7,now(),now())`, [material, task.id, "person-fixture-002"]);
      await f.t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,url,created_at,updated_at)
        VALUES($1,'task',$2,'方法论 SSOT','link',0,'upload',$3,$4,now(),now())`, [link, task.id, "person-fixture-002", feishuUrl]);
      await consent(f);
      await beat(f, await collectorToken(f), { inventory: { ...inventory([]), feishuDocs: [...inventory([]).feishuDocs,
        { url: "https://example.feishu.cn/wiki/WikiToken99", title: null, readAt: "2026-10-09T02:00:00.000Z" }] } });

      const listed = (await call(f, f.member, "GET", "/api/me/work-basis")).json().candidates;
      expect(listed).toEqual([
        // 执行事项里的材料与链接按最近更新排在前面，之后是采集器盘点到的飞书文档。
        { key: `feishu_doc:${feishuUrl}`, kind: "feishu_doc", title: "方法论 SSOT", url: feishuUrl, revision: null, origin: "task", revisedAt: null, revisedBy: null, confirmed: false, supersededBy: null, keepUntil: null },
        { key: `material:${material}`, kind: "material", title: "M2 战略解码.md", url: `/me/tasks/${task.id}`, revision: "v7", origin: "task", revisedAt: null, revisedBy: null, confirmed: false, supersededBy: null, keepUntil: null },
        { key: "feishu_doc:https://example.feishu.cn/wiki/WikiToken99", kind: "feishu_doc", title: "飞书知识库 · WikiToke", url: "https://example.feishu.cn/wiki/WikiToken99", revision: null, origin: "session", revisedAt: null, revisedBy: null, confirmed: false, supersededBy: null, keepUntil: null },
      ]);
      expect((await call(f, f.member, "PUT", "/api/me/work-basis", { keys: ["material:nope"] })).statusCode).toBe(400);
      const saved = await call(f, f.member, "PUT", "/api/me/work-basis", { keys: [`material:${material}`, `feishu_doc:${feishuUrl}`] });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().candidates.map((row: { confirmed: boolean }) => row.confirmed)).toEqual([true, true, false]);
      // 材料之后改了版：入库的仍是确认时的修订号。
      await f.t.sql("UPDATE object_materials SET current_version=8 WHERE id=$1", [material]);
      await call(f, f.member, "PUT", "/api/me/work-basis", { keys: [`material:${material}`] });
      expect(await f.t.sql("SELECT person_id,doc_kind,title,revision FROM work_basis")).toEqual([
        { person_id: "person-fixture-002", doc_kind: "material", title: "M2 战略解码.md", revision: "v7" }]);
      expect((await call(f, f.third, "GET", "/api/me/work-basis")).json().candidates).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("搬家清单：最近一次盘点里的本机定时任务（不含采集器自己），勾选的写进定时任务区；搬过的旧任务不在本机了也照样列出", async () => {
    const f = await executionFixture();
    try {
      const bearer = await collectorToken(f);
      await consent(f);
      await beat(f, bearer, { inventory: inventory(["周报汇总", "日报提醒", "TkosCollector"]) });
      const listed = (await call(f, f.member, "GET", "/api/me/schedule-migration")).json().candidates as { key: string }[];
      expect(listed.sort((x, y) => x.key < y.key ? -1 : 1)).toEqual([
        { key: `${device.id}:周报汇总`, name: "周报汇总", cadence: "Daily", command: "python weekly.py", deviceName: "工作机", imported: false },
        { key: `${device.id}:日报提醒`, name: "日报提醒", cadence: "Daily", command: "python weekly.py", deviceName: "工作机", imported: false },
      ]);
      expect((await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [`${device.id}:TkosCollector`] })).statusCode).toBe(400);
      const saved = (await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [`${device.id}:周报汇总`] })).json().candidates;
      // 已搬的排在前面。
      expect(saved.map((row: { name: string; imported: boolean }) => [row.name, row.imported])).toEqual([["周报汇总", true], ["日报提醒", false]]);
      expect(await f.t.sql("SELECT name,cadence,source,source_device_id FROM schedules")).toEqual([
        { name: "周报汇总", cadence: "Daily", source: "local", source_device_id: device.id }]);

      f.setNow(new Date("2026-10-10T03:00:00.000Z"));
      await beat(f, bearer, { inventory: inventory(["TkosCollector"]) });
      const later = (await call(f, f.member, "GET", "/api/me/schedule-migration")).json().candidates;
      expect(later.map((row: { name: string; imported: boolean }) => [row.name, row.imported])).toEqual([["周报汇总", true]]);
      await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [] });
      expect(await f.t.sql("SELECT count(*)::int AS n FROM schedules")).toEqual([{ n: 0 }]);
    } finally { await f.t.close(); }
  });

  it("飞书文档按本人身份读标题、修订时间和修订人（不读正文），入库记下确认时的那一次；没授权时照常列出", async () => {
    const feishu = { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 };
    const asked: { token: string; docs: unknown }[] = [];
    const client = {
      getDocMetas: async (token: string, docs: unknown) => {
        asked.push({ token, docs });
        return [{ token: "AbCdEfGh123", type: "docx" as const, title: "M2 战略解码", modifiedAt: new Date("2026-10-16T08:00:00.000Z"), modifiedBy: "ou_editor", ownerId: null }];
      },
    } as unknown as FeishuClient;
    const t = await createTestApp({ feishu }, undefined, { feishuClient: client });
    try {
      const cookie = await t.memberCookie();
      const task = randomUUID();
      await t.sql(`INSERT INTO tasks(id,version,title,status,owner_id,created_by) VALUES($1,1,'上线','in_progress',$2,$2)`, [task, TEST_MEMBER.personId]);
      await t.sql(`INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'owner',$2)`, [task, TEST_MEMBER.personId]);
      await t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,url,created_at,updated_at)
        VALUES($1,'task',$2,'方法论链接','link',0,'upload',$3,$4,now(),now())`, [randomUUID(), task, TEST_MEMBER.personId, feishuUrl]);
      const get = async () => (await t.app.inject({ method: "GET", url: "/api/me/work-basis", headers: { cookie } })).json().candidates;
      // 没有飞书授权：不调接口，标题用执行事项里的名字，修订信息为空。
      expect(await get()).toMatchObject([{ title: "方法论链接", revisedAt: null, revisedBy: null }]);
      expect(asked).toEqual([]);

      await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, 'ou_member', '测试乙'), ('person-x', 'ou_editor', '编辑人')", [TEST_MEMBER.personId]);
      await saveAuthorizedToken(async (sql, params) => ({ rows: await t.sql(sql, params) }) as never, feishu, TEST_MEMBER.personId,
        { accessToken: "u-member", refreshToken: "ur-member", expiresIn: 7200, refreshExpiresIn: 604800, scope: "offline_access drive:drive.metadata:readonly" }, new Date());
      expect(await get()).toMatchObject([{ title: "M2 战略解码", revisedAt: "2026-10-16T08:00:00.000Z", revisedBy: "编辑人" }]);
      expect(asked.at(-1)).toEqual({ token: "u-member", docs: [{ token: "AbCdEfGh123", type: "docx" }] });

      const saved = await t.app.inject({ method: "PUT", url: "/api/me/work-basis", headers: { cookie, origin: t.publicOrigin }, payload: { keys: [`feishu_doc:${feishuUrl}`] } });
      expect(saved.statusCode).toBe(200);
      expect(await t.sql("SELECT title, revised_at, revised_by FROM work_basis")).toEqual([
        { title: "M2 战略解码", revised_at: new Date("2026-10-16T08:00:00.000Z"), revised_by: "编辑人" }]);
    } finally { await t.close(); }
  });
});
