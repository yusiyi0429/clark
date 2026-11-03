import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeishuClient } from "../src/feishu/client.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { isWorkSchedule } from "../src/onboardingLists.js";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";
import { createTestApp, TEST_MEMBER } from "./helpers.js";

/** 上手流程最后一页的工作依据清单与搬家清单：读本机采集器下线前留下的本机清单（local_inventory）。 */
const device = { id: "dev-0001-abcdef", name: "工作机", platform: "windows" as const };
const feishuUrl = "https://example.feishu.cn/docx/AbCdEfGh123";
const weeklyScript = String.raw`powershell.exe -NoProfile -File "C:\Users\sean\scripts\weekly.ps1"`;
const inventory = (tasks: string[]) => ({
  scheduledTasks: tasks.map((name) => ({ name, schedule: "Daily", command: weeklyScript })),
  feishuDocs: [{ url: feishuUrl, title: null, readAt: "2026-10-09T01:00:00.000Z" }],
  memoryFiles: [{ source: "claude", path: "~/.claude/projects/a/memory/MEMORY.md", bytes: 120, modifiedAt: "2026-10-08T01:00:00.000Z" }],
});

type Inventory = ReturnType<typeof inventory>;
/** 采集器下线前那台设备的一次完整盘点，落库方式与当时的心跳相同（定时任务、记忆文件以最近一次盘点为准）。 */
async function scan(f: Fixture, list: Inventory, at = new Date("2026-10-10T02:00:00.000Z")) {
  await f.t.sql(`INSERT INTO collector_health(person_id,device_id,source,device_name,platform,collector_version,first_seen_at,last_attempt_at,source_status)
    VALUES('person-fixture-002',$1,'codex',$2,$3,'0.2.0',$4,$4,'ok') ON CONFLICT (person_id,device_id,source) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at`,
  [device.id, device.name, device.platform, at]);
  const sql = `INSERT INTO local_inventory(person_id,device_id,kind,item_key,detail,read_at,first_seen_at,last_seen_at)
    VALUES('person-fixture-002',$1,$2,$3,$4,$5,$6,$6) ON CONFLICT (person_id,device_id,kind,item_key) DO UPDATE SET detail=EXCLUDED.detail,
      read_at=GREATEST(local_inventory.read_at, EXCLUDED.read_at), last_seen_at=EXCLUDED.last_seen_at`;
  for (const task of list.scheduledTasks) await f.t.sql(sql, [device.id, "scheduled_task", task.name, JSON.stringify({ schedule: task.schedule, command: task.command }), null, at]);
  for (const doc of list.feishuDocs) await f.t.sql(sql, [device.id, "feishu_doc", doc.url, JSON.stringify({ title: doc.title }), doc.readAt, at]);
  for (const file of list.memoryFiles) await f.t.sql(sql, [device.id, "memory_file", file.path, JSON.stringify({ source: file.source, bytes: file.bytes, modifiedAt: file.modifiedAt }), null, at]);
  await f.t.sql(`INSERT INTO collector_scans(person_id,device_id,scanned_at) VALUES('person-fixture-002',$1,$2)
    ON CONFLICT (person_id,device_id) DO UPDATE SET scanned_at=EXCLUDED.scanned_at`, [device.id, at]);
}

describe("上手流程的两个清单", () => {
  it("工作依据清单：执行事项里的材料带修订号、链接；会话里读过但读不到标题的飞书文档不列；勾选的入库，没勾的移出，候选外的 key 拒收", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const material = randomUUID(), link = randomUUID();
      await f.t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,current_version,created_at,updated_at)
        VALUES($1,'task',$2,'M2 战略解码.md','markdown',10,'agent',$3,7,now(),now())`, [material, task.id, "person-fixture-002"]);
      await f.t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,url,created_at,updated_at)
        VALUES($1,'task',$2,'方法论 SSOT','link',0,'upload',$3,$4,now(),now())`, [link, task.id, "person-fixture-002", feishuUrl]);
      await scan(f, { ...inventory([]), feishuDocs: [...inventory([]).feishuDocs,
        { url: "https://example.feishu.cn/wiki/WikiToken99", title: null, readAt: "2026-10-09T02:00:00.000Z" }] });

      const listed = (await call(f, f.member, "GET", "/api/me/work-basis")).json().candidates;
      expect(listed).toEqual([
        // 执行事项里的材料与链接按最近更新排列；会话里读过的飞书文档没有飞书授权读不到标题，不列（只有兜底标题用户看不懂）。
        { key: `feishu_doc:${feishuUrl}`, kind: "feishu_doc", title: "方法论 SSOT", url: feishuUrl, revision: null, origin: "task", revisedAt: null, revisedBy: null, confirmed: false, supersededBy: null, keepUntil: null },
        { key: `material:${material}`, kind: "material", title: "M2 战略解码.md", url: `/me/tasks/${task.id}`, revision: "v7", origin: "task", revisedAt: null, revisedBy: null, confirmed: false, supersededBy: null, keepUntil: null },
      ]);
      expect((await call(f, f.member, "PUT", "/api/me/work-basis", { keys: ["material:nope"] })).statusCode).toBe(400);
      // 无标题的不列，但提交时照样认：列出时读到了标题、提交那一刻飞书读标题失败，已勾的不至于被当成「清单变了」。下一次提交没勾它就移出。
      expect((await call(f, f.member, "PUT", "/api/me/work-basis", { keys: ["feishu_doc:https://example.feishu.cn/wiki/WikiToken99"] })).statusCode).toBe(200);
      const saved = await call(f, f.member, "PUT", "/api/me/work-basis", { keys: [`material:${material}`, `feishu_doc:${feishuUrl}`] });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().candidates.map((row: { confirmed: boolean }) => row.confirmed)).toEqual([true, true]);
      // 材料之后改了版：入库的仍是确认时的修订号。
      await f.t.sql("UPDATE object_materials SET current_version=8 WHERE id=$1", [material]);
      await call(f, f.member, "PUT", "/api/me/work-basis", { keys: [`material:${material}`] });
      expect(await f.t.sql("SELECT person_id,doc_kind,title,revision FROM work_basis")).toEqual([
        { person_id: "person-fixture-002", doc_kind: "material", title: "M2 战略解码.md", revision: "v7" }]);
      expect((await call(f, f.third, "GET", "/api/me/work-basis")).json().candidates).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("搬家清单：最近一次盘点里工作用的本机定时任务（不含采集器自己和厂商任务），勾选的写进定时任务区；搬过的旧任务不在本机了也照样列出", async () => {
    const f = await executionFixture();
    try {
      const base = inventory(["周报汇总", "日报提醒", "TkosCollector"]);
      await scan(f, { ...base, scheduledTasks: [...base.scheduledTasks,
        { name: "MicrosoftEdgeUpdateTaskMachineCore", schedule: "Logon, Daily", command: String.raw`C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe /c` }] });
      const listed = (await call(f, f.member, "GET", "/api/me/schedule-migration")).json().candidates as { key: string }[];
      expect(listed.sort((x, y) => x.key < y.key ? -1 : 1)).toEqual([
        { key: `${device.id}:周报汇总`, name: "周报汇总", cadence: "Daily", command: weeklyScript, deviceName: "工作机", imported: false },
        { key: `${device.id}:日报提醒`, name: "日报提醒", cadence: "Daily", command: weeklyScript, deviceName: "工作机", imported: false },
      ]);
      expect((await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [`${device.id}:TkosCollector`] })).statusCode).toBe(400);
      expect((await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [`${device.id}:MicrosoftEdgeUpdateTaskMachineCore`] })).statusCode).toBe(400);
      const saved = (await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [`${device.id}:周报汇总`] })).json().candidates;
      // 已搬的排在前面。
      expect(saved.map((row: { name: string; imported: boolean }) => [row.name, row.imported])).toEqual([["周报汇总", true], ["日报提醒", false]]);
      expect(await f.t.sql("SELECT name,cadence,source,source_device_id FROM schedules")).toEqual([
        { name: "周报汇总", cadence: "Daily", source: "local", source_device_id: device.id }]);

      f.setNow(new Date("2026-10-10T03:00:00.000Z"));
      await scan(f, inventory(["TkosCollector"]), new Date("2026-10-10T03:00:00.000Z"));
      const later = (await call(f, f.member, "GET", "/api/me/schedule-migration")).json().candidates;
      expect(later.map((row: { name: string; imported: boolean }) => [row.name, row.imported])).toEqual([["周报汇总", true]]);
      await call(f, f.member, "PUT", "/api/me/schedule-migration", { keys: [] });
      expect(await f.t.sql("SELECT count(*)::int AS n FROM schedules")).toEqual([{ n: 0 }]);
    } finally { await f.t.close(); }
  });

  it("飞书文档按本人身份读标题、修订时间和修订人（不读正文），入库记下确认时的那一次；会话里读过的读到标题才列出", async () => {
    const feishu = { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 };
    const asked: { token: string; docs: unknown }[] = [];
    const client = {
      getDocMetas: async (token: string, docs: unknown) => {
        asked.push({ token, docs });
        return [{ token: "AbCdEfGh123", type: "docx" as const, title: "M2 战略解码", modifiedAt: new Date("2026-10-16T08:00:00.000Z"), modifiedBy: "ou_editor", ownerId: null },
          { token: "WikiTitled01", type: "wiki" as const, title: "周会纪要", modifiedAt: new Date("2026-10-15T08:00:00.000Z"), modifiedBy: null, ownerId: null }];
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
      // 采集器盘点到的两份会话里读过的文档：一份读得到元数据，一份读不到。
      const sessionDoc = (url: string, readAt: string) => t.sql(`INSERT INTO local_inventory(person_id,device_id,kind,item_key,detail,read_at,first_seen_at,last_seen_at)
        VALUES($1,'dev-1','feishu_doc',$2,'{"title":null}',$3,now(),now())`, [TEST_MEMBER.personId, url, readAt]);
      await sessionDoc("https://example.feishu.cn/wiki/WikiTitled01", "2026-10-09T02:00:00.000Z");
      await sessionDoc("https://example.feishu.cn/docx/NoMeta0002", "2026-10-09T01:00:00.000Z");
      const get = async () => (await t.app.inject({ method: "GET", url: "/api/me/work-basis", headers: { cookie } })).json().candidates;
      // 没有飞书授权：不调接口，标题用执行事项里的名字，修订信息为空；会话里读过的只有兜底标题，不列。
      const unauthorized = await get();
      expect(unauthorized).toMatchObject([{ title: "方法论链接", revisedAt: null, revisedBy: null }]);
      expect(unauthorized).toHaveLength(1);
      expect(asked).toEqual([]);

      await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, 'ou_member', '测试乙'), ('person-x', 'ou_editor', '编辑人')", [TEST_MEMBER.personId]);
      await saveAuthorizedToken(async (sql, params) => ({ rows: await t.sql(sql, params) }) as never, feishu, TEST_MEMBER.personId,
        { accessToken: "u-member", refreshToken: "ur-member", expiresIn: 7200, refreshExpiresIn: 604800, scope: "offline_access drive:drive.metadata:readonly" }, new Date());
      // 读到标题的会话文档列出来；读不到的仍不列。
      const authorized = await get();
      expect(authorized).toMatchObject([{ title: "M2 战略解码", revisedAt: "2026-10-16T08:00:00.000Z", revisedBy: "编辑人", origin: "task" },
        { key: "feishu_doc:https://example.feishu.cn/wiki/WikiTitled01", title: "周会纪要", revisedAt: "2026-10-15T08:00:00.000Z", revisedBy: null, origin: "session" }]);
      expect(authorized).toHaveLength(2);
      expect(asked.at(-1)).toEqual({ token: "u-member", docs: [{ token: "AbCdEfGh123", type: "docx" }, { token: "WikiTitled01", type: "wiki" }, { token: "NoMeta0002", type: "docx" }] });

      const saved = await t.app.inject({ method: "PUT", url: "/api/me/work-basis", headers: { cookie, origin: t.publicOrigin }, payload: { keys: [`feishu_doc:${feishuUrl}`] } });
      expect(saved.statusCode).toBe(200);
      expect(await t.sql("SELECT title, revised_at, revised_by FROM work_basis")).toEqual([
        { title: "M2 战略解码", revised_at: new Date("2026-10-16T08:00:00.000Z"), revised_by: "编辑人" }]);
    } finally { await t.close(); }
  });
});

describe("搬家清单只列工作用的定时任务", () => {
  // 真实盘点样例（Windows 任务计划根目录）：只有本人的周同步脚本是工作用的。
  it.each([
    { name: "TianshuWeeklySync", cadence: "Weekly", command: String.raw`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\10021\.claude\tianshu-weekly-sync.ps1"`, keep: true },
    { name: "ASUS Hotplug Controller", cadence: "Logon", command: String.raw`C:\Program Files\ASUS\ARMOURY CRATE Lite Service\HotplugController.exe`, keep: false },
    { name: "ASUS Optimization", cadence: "Event", command: String.raw`C:\WINDOWS\System32\DriverStore\FileRepository\asussci2.inf_amd64\ASUSOptimization.exe`, keep: false },
    { name: "OneDrive Standalone Update Task", cadence: "Time", command: String.raw`C:\Users\10021\AppData\Local\Microsoft\OneDrive\OneDriveStandaloneUpdater.exe`, keep: false },
    { name: "MicrosoftEdgeUpdateTaskMachineCore", cadence: "Logon, Daily", command: String.raw`C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe /c`, keep: false },
    { name: "NvDriverUpdateCheckDaily", cadence: "Daily", command: String.raw`"C:\Program Files\NVIDIA Corporation\NvContainer\nvcontainer.exe" -d "C:\Program Files\NVIDIA Corporation\NvContainer\plugins"`, keep: false },
    { name: "ZoomUpdateTaskUser", cadence: "Daily", command: String.raw`C:\Users\10021\AppData\Roaming\Zoom\bin\Zoom.exe --updatecheck`, keep: false },
    { name: "AdobeGCInvoker-1.0", cadence: "Daily", command: String.raw`C:\Program Files (x86)\Common Files\Adobe\AdobeGCClient\AGCInvokerUtility.exe`, keep: false },
    { name: "CCXProcess", cadence: "Logon", command: String.raw`C:\Program Files\Adobe\Adobe Creative Cloud Experience\CCXProcess.exe`, keep: false },
    { name: "MangoVPN 自启", cadence: "Logon", command: String.raw`C:\Program Files\MangoVPN\MangoVPN.exe --autostart`, keep: false },
  ])("$name → $keep", ({ cadence, command, keep }) => expect(isWorkSchedule({ cadence, command })).toBe(keep));

  it("按时间跑才算：只在登录、开机、事件、注册、空闲时触发的，跑本人脚本也不列", () => {
    const script = String.raw`powershell.exe -File "C:\Users\sean\sync.ps1"`;
    for (const cadence of ["Logon", "Boot", "Event", "Registration", "Idle", "Logon, Registration", "", null]) expect(isWorkSchedule({ cadence, command: script })).toBe(false);
    for (const cadence of ["Daily", "Weekly", "Monthly", "MonthlyDOW", "Time", "Logon, Weekly"]) expect(isWorkSchedule({ cadence, command: script })).toBe(true);
  });

  it("命令跑的是主目录下的脚本，或提到 AI 工具而本身不在系统、厂商目录", () => {
    const daily = (command: string) => isWorkSchedule({ cadence: "Daily", command });
    expect(daily(String.raw`C:\Users\10021\AppData\Roaming\npm\claude.cmd -p "写周报"`)).toBe(true);
    expect(daily(`codex exec "整理今天的进展"`)).toBe(true);
    expect(daily(`python C:/Users/sean/tkos/daily.py`)).toBe(true);
    expect(daily(String.raw`C:\Users\10021\AppData\Roaming\Vendor\update.cmd`)).toBe(false);
    expect(daily(String.raw`"C:\Program Files\Claude\claude.exe" --update`)).toBe(false);
    expect(daily(`python weekly.py`)).toBe(false);
    expect(daily(`/usr/local/bin/worldwide-sync`)).toBe(false);
    // macOS launchd 与 crontab
    expect(isWorkSchedule({ cadence: "StartCalendarInterval", command: "/bin/zsh /Users/sean/bin/report.sh" })).toBe(true);
    expect(isWorkSchedule({ cadence: "每 3600 秒", command: "/Users/sean/Library/Google/GoogleSoftwareUpdate/GoogleSoftwareUpdateAgent -runMode ifneeded" })).toBe(false);
    expect(isWorkSchedule({ cadence: "0 9 * * 1", command: "~/scripts/weekly.py" })).toBe(true);
    expect(isWorkSchedule({ cadence: "*/5 * * * *", command: "/usr/local/bin/backup" })).toBe(false);
    expect(isWorkSchedule({ cadence: "Daily", command: null })).toBe(false);
  });
});
