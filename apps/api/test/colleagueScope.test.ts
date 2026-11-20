import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { colleagueNames } from "../src/colleagueAccess.js";
import { CATALOG_MAX, colleagueIndex, dbScopeSource, matchColleagues, scopeEntries, scopeReader, type ColleagueIndexEntry, type OwnerRows, type ScopeDeps,
  type ScopeSource } from "../src/colleagueScope.js";
import { loadPeople } from "../src/peopleDirectory.js";
import type { PlanTaskSource } from "../src/planTasks.js";
import { ensureScratchProject } from "../src/projects.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 1, minute)).toISOString();
const session = (kind: "card" | "topic", id: string, projectId: string | null, minute: number, extra: Partial<OwnerRows["sessions"][number]> = {}):
  OwnerRows["sessions"][number] => ({ kind, id, title: `会话 ${id}`, projectId, trashed: false, archived: false, line: "停着", updatedAt: at(minute), author: null, ...extra });
const output = (id: string, sessionKind: "card" | "topic", sessionId: string): OwnerRows["outputs"][number] =>
  ({ id, sessionKind, sessionId, title: `产出 ${id}`, createdAt: at(30) });

const rows: OwnerRows = {
  note: { updatedAt: at(1) },
  files: [{ id: "f1", fileName: "手册.md", createdAt: at(2) }, { id: "f2", fileName: "口径.pdf", createdAt: at(3) }],
  roles: [
    { id: "r-a", name: "技能甲", shared: true, archived: false, updatedAt: at(4) },
    { id: "r-b", name: "技能乙", shared: false, archived: false, updatedAt: at(4) },
    { id: "r-c", name: "技能丙", shared: true, archived: true, updatedAt: at(4) },
  ],
  tasks: [{ taskId: "task-now", name: "本月的", carried: false }, { taskId: "task-old", name: "往月带过来的", carried: true }],
  deliverables: [
    { itemId: "d-now", taskId: "task-now", name: "方案.md", versionNumber: 2, hidden: false },
    { itemId: "d-hidden", taskId: "task-now", name: "收起项目里的报告.md", versionNumber: 2, hidden: true },
    { itemId: "d-old", taskId: "task-old", name: "旧方案.md", versionNumber: 1, hidden: false },
  ],
  projects: [
    { id: "p-deploy", name: "天枢部署", scratch: false, archived: false, hidden: false },
    { id: "p-scratch", name: "随手", scratch: true, archived: false, hidden: false },
    { id: "p-old", name: "旧官网", scratch: false, archived: true, hidden: false },
    { id: "p-hidden", name: "私事", scratch: false, archived: false, hidden: true },
  ],
  sessions: [
    session("card", "c-handed", "p-deploy", 10, { author: "丙" }),
    session("card", "c-deploy", "p-deploy", 20),
    session("topic", "t-trashed", "p-deploy", 21, { trashed: true }),
    session("topic", "t-archived", "p-deploy", 22, { archived: true }),
    session("topic", "t-scratch", "p-scratch", 23),
    session("card", "c-old", "p-old", 24),
    session("card", "c-loose", null, 25),
    session("card", "c-hidden", "p-hidden", 26),
  ],
  outputs: [output("o-deploy", "card", "c-deploy"), output("o-scratch", "topic", "t-scratch"), output("o-hidden", "card", "c-hidden")],
};

describe("范围判定（纯函数）", () => {
  it("只留同事可读的，顺序固定", () => {
    expect(scopeEntries(rows).map((entry) => entry.itemId)).toEqual(["note", "file:f1", "file:f2", "skill:r-a", "task:task-now", "deliverable:d-now",
      "project:p-deploy", "session:card:c-deploy", "output:o-deploy", "session:card:c-handed"]);
  });
  it("上一级指对了，标题照规矩，转交前别人记的会话带原作者", () => {
    const byId = new Map(scopeEntries(rows).map((entry) => [entry.itemId, entry]));
    expect(byId.get("note")).toEqual({ itemId: "note", kind: "note", title: "说明", updatedAt: at(1), under: null });
    expect(byId.get("file:f1")).toMatchObject({ kind: "file", title: "手册.md", updatedAt: at(2), under: null });
    expect(byId.get("skill:r-a")).toMatchObject({ kind: "skill", title: "技能甲", under: null });
    expect(byId.get("task:task-now")).toMatchObject({ kind: "task", title: "本月的", under: null });
    expect(byId.get("deliverable:d-now")).toMatchObject({ kind: "deliverable", title: "方案.md", under: "task:task-now" });
    expect(byId.get("project:p-deploy")).toMatchObject({ kind: "project", title: "天枢部署", under: null });
    expect(byId.get("session:card:c-deploy")).toEqual({ itemId: "session:card:c-deploy", kind: "session", title: "会话 c-deploy", updatedAt: at(20),
      under: "project:p-deploy" });
    expect(byId.get("session:card:c-handed")).toMatchObject({ under: "project:p-deploy", author: "丙" });
    expect(byId.get("output:o-deploy")).toMatchObject({ kind: "output", title: "产出 o-deploy", under: "session:card:c-deploy" });
  });
});

describe("读（scopeReader）", () => {
  const source = (bodies: Record<string, string>, sourceRows = rows): ScopeSource => ({ owner: { personId: "p-b", name: "乙" }, rows: async () => sourceRows,
    body: async (entry) => bodies[entry.itemId] ?? null });
  it("范围外的条目读不到，回话一样", async () => {
    const outside = ["skill:r-b", "skill:r-c", "task:task-old", "deliverable:d-old", "deliverable:d-hidden", "project:p-scratch", "project:p-old", "project:p-hidden",
      "session:topic:t-scratch", "session:topic:t-trashed", "session:topic:t-archived", "output:o-scratch", "session:card:c-old", "session:card:c-loose",
      "session:card:c-hidden", "output:o-hidden", "memory", "conversation:1", "", "note ", "NOTE"];
    const reader = scopeReader(source(Object.fromEntries(outside.map((id) => [id, "不该读到"]))));
    for (const id of outside) expect(await reader.read(id), id).toBeNull();
    // 在范围里但没有正文的，也是 null。
    expect(await reader.read("skill:r-a")).toBeNull();
  });
  it("读出来带人、条目和正文", async () => {
    expect(await scopeReader(source({ note: "部署先看手册" })).read("note")).toEqual({ person: { personId: "p-b", name: "乙" }, itemId: "note", kind: "note",
      title: "说明", updatedAt: at(1), text: "部署先看手册", truncated: false, nextOffset: null });
  });
  it("读出去的文字里像密钥的值被遮掉", async () => {
    const reader = scopeReader(source({ "output:o-deploy": "配置：sk-abcdefghijklmnop1234 结束\n令牌 ghp_abcdefghijklmnopqrstuvwxyz 别外传" }));
    const text = (await reader.read("output:o-deploy"))!.text;
    expect(text).toContain("sk-abc••••");
    expect(text).not.toContain("defghijklmnop1234");
    expect(text).toContain("ghp_ab••••");
    expect(text).not.toContain("cdefghijklmnopqrstuvwxyz");
    expect(text).toContain("别外传");
  });
  it("长的分段读", async () => {
    const reader = scopeReader(source({ "task:task-now": "字".repeat(50_000) }));
    const first = (await reader.read("task:task-now"))!;
    expect([first.text.length, first.truncated, first.nextOffset]).toEqual([24_000, true, 24_000]);
    const last = (await reader.read("task:task-now", 48_000))!;
    expect([last.text.length, last.truncated, last.nextOffset]).toEqual([2_000, false, null]);
    const small = (await reader.read("task:task-now", 100, 50))!;
    expect([small.text.length, small.truncated, small.nextOffset]).toEqual([50, true, 150]);
  });
  it("目录封顶 200 条，多出来的算进 more", async () => {
    const many: OwnerRows = { ...rows, sessions: Array.from({ length: 260 }, (_, index) => session("card", `c-${index}`, "p-deploy", index % 60)), outputs: [] };
    const total = scopeEntries(many).length;
    const catalog = await scopeReader(source({}, many)).catalog();
    expect(catalog.person).toEqual({ personId: "p-b", name: "乙" });
    expect(catalog.entries).toHaveLength(CATALOG_MAX);
    expect(catalog.more).toBe(total - CATALOG_MAX);
    expect(catalog.entries[0].itemId).toBe("note");
  });
});

const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const NAMES = new Map(loadPeople(PEOPLE_SEED).map((person) => [person.personId, person.displayName]));
const boardPlanTasks: PlanTaskSource = async (missions) => BOARD_TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId));

/** multipart 一个 file 字段（同 colleagueMaterials.test.ts）。 */
function upload(f: BoardFixture, name: string, text: string) {
  const boundary = randomUUID();
  const head = "--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n';
  return f.t.app.inject({ method: "POST", url: "/api/me/colleague-materials/files", headers: { cookie: f.member, origin: f.t.publicOrigin,
    "content-type": "multipart/form-data; boundary=" + boundary }, payload: Buffer.concat([Buffer.from(head), Buffer.from(text), Buffer.from("\r\n--" + boundary + "--\r\n")]) });
}
async function thirdCookie(f: BoardFixture) {
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  return String(login.headers["set-cookie"]).split(";")[0];
}
const deps = (f: BoardFixture, planTasks: PlanTaskSource = boardPlanTasks): ScopeDeps => ({ q: f.t.pool.query.bind(f.t.pool), planTasks, names: NAMES, now: BOARD_NOW });
const reader = (f: BoardFixture, planTasks?: PlanTaskSource) => scopeReader(dbScopeSource(deps(f, planTasks), TEST_MEMBER.personId));
const ids = async (f: BoardFixture, planTasks?: PlanTaskSource) => (await reader(f, planTasks).catalog()).entries.map((entry) => entry.itemId);
/** 建项目（带 Task 就挂上）。 */
const project = async (f: BoardFixture, name: string, taskId?: string) => {
  const res = await f.call("POST", "/api/me/projects", { name, ...(taskId ? { taskId } : {}) });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().projectId as string;
};
/** 一张交给 Claude Code 的卡（子会话），不挂 Task、记在这个项目上。 */
const looseCard = async (f: BoardFixture, title: string, projectId: string) => {
  const id = await f.card(title);
  await f.t.sql("UPDATE tasks SET executor='claude_code',plan_task_id=NULL,project_id=$2 WHERE id=$1", [id, projectId]);
  return id;
};
const topic = async (f: BoardFixture, title: string, projectId: string) => {
  const id = randomUUID();
  await f.t.sql("INSERT INTO research_topics(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)", [id, TEST_MEMBER.personId, title, projectId]);
  return id;
};

describe("从库里读（dbScopeSource）", { timeout: 60_000 }, () => {
  it("目录和各种正文：说明、文件、技能、本月 Task 的约定和对表、项目和会话状态、报告和验收结论、产出", async () => {
    const f = await boardFixture();
    try {
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署先看拆分手册" })).statusCode).toBe(200);
      const added = await upload(f, "手册.md", "# 拆分手册\n先做盘点表");
      expect(added.statusCode, added.body).toBe(200);
      const fileId = added.json().files[0].id as string;
      const role = await f.call("POST", "/api/me/roles", { name: "部署验收", family: "general", kind: "worker", dutiesMd: "看部署", practiceMd: "先跑冒烟", acceptanceMd: "页面能开" });
      const roleId = role.json().id as string;
      expect((await f.call("PUT", `/api/me/roles/${roleId}/sharing`, { shared: true })).statusCode).toBe(200);

      const deploy = await project(f, "天枢部署", "task-open");
      const cardId = await f.card("api 独立构建");
      expect((await f.call("PATCH", `/api/me/cards/${cardId}`, { version: 1, executor: "claude_code", criterionIndex: 1 })).statusCode).toBe(200);
      const idle = await project(f, "没开工的项目");
      const fresh = await looseCard(f, "还没开工的卡", idle);
      const machine = await f.local();
      await machine.send({ kind: "card", cardId }, [["status", { status: "running", title: "api 独立构建", agent: "claude-code", modelLabel: "订阅 · Sonnet" }],
        ["stopped", { why: "turn_done", summary: "api 独立构建通过", blocker: "等本人给部署机器", outputs: [] }]]);
      const handback = await machine.handBack(cardId);
      await f.t.app.cardAcceptance.idle();
      await f.t.sql(`UPDATE card_handbacks SET status='done',outcome='fail',finished_at=now(),result=$2::jsonb WHERE id=$1`, [handback, JSON.stringify({
        headline: "方案有了，评审结论还没有", beyondScope: [], criteria: [{ index: 1, verdict: "met", reason: "方案.md 里有", evidence: "方案.md", fix: null },
          { index: 2, verdict: "unmet", reason: "没有评审记录正文", evidence: null, fix: "补评审结论" }] })]);
      // 夹具的交回不报会话状态（停在 starting）：照真本机交完收工后的样子记成退出。
      await f.t.sql("UPDATE local_runs SET state='exited' WHERE task_id=$1", [cardId]);
      const [outputRow] = await f.t.sql("SELECT id::text FROM local_outputs WHERE task_id=$1 AND kind='artifact'", [cardId]);

      const read = reader(f);
      const catalog = await read.catalog();
      expect(catalog.person).toEqual({ personId: TEST_MEMBER.personId, name: "测试乙" });
      expect(catalog.more).toBe(0);
      const listed = catalog.entries.map((entry) => entry.itemId);
      expect(listed).toEqual(expect.arrayContaining(["note", `file:${fileId}`, `skill:${roleId}`, "task:task-open", `project:${deploy}`, `session:card:${cardId}`,
        `output:${outputRow.id}`, `project:${idle}`, `session:card:${fresh}`]));
      expect(listed).not.toContain("task:task-theirs");

      expect((await read.read("note"))!.text).toBe("部署先看拆分手册");
      expect((await read.read(`file:${fileId}`))!.text).toContain("先做盘点表");
      const skill = (await read.read(`skill:${roleId}`))!.text;
      for (const part of ["部署验收", "职责", "看部署", "做法", "先跑冒烟", "验收口径", "页面能开"]) expect(skill).toContain(part);
      const task = (await read.read("task:task-open"))!;
      expect(task).toMatchObject({ kind: "task", title: "对话质量达标", person: { personId: TEST_MEMBER.personId, name: "测试乙" } });
      expect(task.text).toContain("有题库打分结果");
      expect(task.text).toContain("还不能交");
      const projectText = (await read.read(`project:${deploy}`))!.text;
      expect(projectText).toContain("api 独立构建 · 停着");
      expect(projectText).toContain(`session:card:${cardId}`);
      expect((await read.read(`project:${idle}`))!.text).toContain("还没开工的卡 · 没开工");
      const sessionText = (await read.read(`session:card:${cardId}`))!.text;
      for (const part of ["api 独立构建通过", "等本人给部署机器", "方案有了，评审结论还没有", "没过", "没有评审记录正文", `output:${outputRow.id}`])
        expect(sessionText).toContain(part);
      expect((await read.read(`output:${outputRow.id}`))!.text).toContain("有方案文档");
    } finally { await f.close(); }
  });

  it("别人名下的、删掉的、归档的、随手里的、收起的都不在目录里；转交过来的项目里别人记的会话算进来、带原作者", async () => {
    const f = await boardFixture();
    try {
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const theirRole = randomUUID();
      await f.t.sql(`INSERT INTO roles(id,owner_id,name,family,kind,shared_with_colleagues) VALUES($1,$2,'别人的技能','general','worker',true)`, [theirRole, THIRD.personId]);
      const keep = await project(f, "留着的");
      const kept = await looseCard(f, "留着的卡", keep);
      const trashed = await looseCard(f, "删掉的卡", keep);
      await f.t.sql("UPDATE tasks SET trashed_at=now() WHERE id=$1", [trashed]);
      const handed = await looseCard(f, "转交前别人记的卡", keep);
      await f.t.sql("UPDATE tasks SET owner_id=$2 WHERE id=$1", [handed, THIRD.personId]);
      const theirs = randomUUID();
      await f.t.sql("INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,$2,'别人的项目',now(),now())", [theirs, THIRD.personId]);
      const inTheirs = await looseCard(f, "记在别人项目里的卡", theirs);
      const old = await project(f, "旧官网");
      const inOld = await looseCard(f, "旧官网的卡", old);
      expect((await f.call("PATCH", `/api/me/projects/${old}`, { archived: true })).statusCode).toBe(200);
      const scratch = (await ensureScratchProject(f.t.pool.query.bind(f.t.pool), TEST_MEMBER.personId, BOARD_NOW)).id;
      const inScratch = await topic(f, "随手查个东西", scratch);

      // 收起（A2）：只有负责人能改，别人 404；收起的项目连同 Task 挂在它上面时，Task 的约定和对表照出，交付条目的正文不出。
      const hidden = await project(f, "私事", "task-open");
      const inHidden = await looseCard(f, "私事的卡", hidden);
      expect((await f.call("PATCH", `/api/me/projects/${hidden}`, { hiddenFromColleagues: true }, await thirdCookie(f))).statusCode).toBe(404);
      const patched = await f.call("PATCH", `/api/me/projects/${hidden}`, { hiddenFromColleagues: true });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({ projectId: hidden, hiddenFromColleagues: true });
      const listedProjects = (await f.call("GET", "/api/me/projects")).json().projects as { projectId: string; hiddenFromColleagues?: true }[];
      expect(listedProjects.find((entry) => entry.projectId === hidden)!.hiddenFromColleagues).toBe(true);
      expect(listedProjects.find((entry) => entry.projectId === keep)).not.toHaveProperty("hiddenFromColleagues");
      const home = (await f.call("GET", "/api/me/work-home")).json().projects as { projectId: string; hiddenFromColleagues?: true }[];
      expect(home.find((entry) => entry.projectId === hidden)!.hiddenFromColleagues).toBe(true);
      const versionId = randomUUID(), itemId = randomUUID();
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,statement,project_id)
        VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance','["有题库打分结果","有新人上手录屏"]','私事里的报告',$3)`, [versionId, TEST_MEMBER.personId, hidden]);
      await f.t.sql(`INSERT INTO deliverable_items(id,version_id,position,kind,name,storage_key,extracted_text,read) VALUES($1,$2,0,'file','报告.md','deliverables/x','报告正文','read')`,
        [itemId, versionId]);

      const read = reader(f);
      const listed = await ids(f);
      expect(listed).toEqual(expect.arrayContaining([`project:${keep}`, `session:card:${kept}`, `session:card:${handed}`, "task:task-open"]));
      for (const id of [`skill:${theirRole}`, `session:card:${trashed}`, `project:${theirs}`, `session:card:${inTheirs}`, `project:${old}`, `session:card:${inOld}`,
        `project:${scratch}`, `session:topic:${inScratch}`, `project:${hidden}`, `session:card:${inHidden}`, `deliverable:${itemId}`]) {
        expect(listed, id).not.toContain(id);
        expect(await read.read(id), id).toBeNull();
      }
      const entry = (await read.catalog()).entries.find((item) => item.itemId === `session:card:${handed}`);
      expect(entry).toMatchObject({ under: `project:${keep}`, author: "测试丙" });
      expect((await read.catalog()).entries.find((item) => item.itemId === `session:card:${kept}`)).not.toHaveProperty("author");
      const task = (await read.read("task:task-open"))!.text;
      expect(task).toContain("有题库打分结果");
      expect(task).not.toContain(itemId);

      // 放开以后照常进来。
      expect((await f.call("PATCH", `/api/me/projects/${hidden}`, { hiddenFromColleagues: false })).json()).not.toHaveProperty("hiddenFromColleagues");
      expect(await ids(f)).toEqual(expect.arrayContaining([`project:${hidden}`, `session:card:${inHidden}`, `deliverable:${itemId}`]));
      expect((await read.read(`deliverable:${itemId}`))!.text).toBe("报告正文");
    } finally { await f.close(); }
  });

  it("没读本体到 Task 时，Task 那一条回 null，别的照读", async () => {
    const f = await boardFixture();
    try {
      expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署先看拆分手册" })).statusCode).toBe(200);
      const broken: PlanTaskSource = async () => { throw new Error("本体挂了"); };
      expect(await ids(f, broken)).toEqual(["note"]);
      expect(await reader(f, broken).read("task:task-open")).toBeNull();
      expect((await reader(f, broken).read("note"))!.text).toBe("部署先看拆分手册");
    } finally { await f.close(); }
  });
});

describe("搜人（matchColleagues，纯函数）", () => {
  const index: ColleagueIndexEntry[] = [
    { personId: "p-b", name: "陈乙", labels: ["负责能力域：研发", "公开技能：部署验收"] },
    { personId: "p-c", name: "林丙", labels: ["负责战场：增长"] },
    ...Array.from({ length: 6 }, (_, n) => ({ personId: `p-t${n}`, name: `测试${n}号`, labels: [] })),
  ];
  it("按名字、按工种都能对上，回的是对上了什么", () => {
    expect(matchColleagues(index, "陈乙")).toEqual({ people: [{ personId: "p-b", name: "陈乙", matched: ["名字"] }], more: 0 });
    expect(matchColleagues(index, "研发")).toEqual({ people: [{ personId: "p-b", name: "陈乙", matched: ["负责能力域：研发"] }], more: 0 });
    expect(matchColleagues(index, "部署验收").people[0]).toMatchObject({ personId: "p-b", matched: ["公开技能：部署验收"] });
    expect(matchColleagues(index, " 增长 ").people).toEqual([{ personId: "p-c", name: "林丙", matched: ["负责战场：增长"] }]);
  });
  it("搜人：不足两个字不搜，最多回 5 个", () => {
    for (const query of ["", " ", "陈", " 乙 "]) expect(matchColleagues(index, query)).toEqual({ people: [], more: 0 });
    expect(matchColleagues(index, "测试")).toMatchObject({ more: 1 });
    expect(matchColleagues(index, "测试").people).toHaveLength(5);
  });
});

describe("可搜的人从库里读（colleagueIndex）", { timeout: 60_000 }, () => {
  it("标签取负责的战场、能力域和同事可用的技能；只有 DRI 和 CEO；不含自己；没标同事可用的技能名搜不到", async () => {
    const f = await boardFixture();
    try {
      const q = f.t.pool.query.bind(f.t.pool);
      await f.t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await f.t.sql(`INSERT INTO capability_config(id,version,code,sort_order,name,"group",six_month_outcome,support_refs,owner_id)
        VALUES('rnd',1,'RND',1,'研发','','',  '[]'::jsonb,$1)`, [TEST_CEO.personId]);
      const role = (owner: string, name: string, shared: boolean) => f.t.sql(`INSERT INTO roles(id,owner_id,name,family,kind,shared_with_colleagues)
        VALUES($1,$2,$3,'general','worker',$4)`, [randomUUID(), owner, name, shared]);
      await role(TEST_CEO.personId, "部署验收", true);
      await role(TEST_CEO.personId, "个人复盘口径", false);
      await role(THIRD.personId, "部署验收", true);
      await f.t.sql(`INSERT INTO roles(id,owner_id,name,family,kind,shared_with_colleagues,archived_at) VALUES($1,$2,'归档的技能','general','worker',true,now())`,
        [randomUUID(), TEST_CEO.personId]);

      const colleagues = colleagueNames(loadPeople(PEOPLE_SEED));
      const index = await colleagueIndex(q, colleagues, TEST_MEMBER.personId);
      expect(index.map((entry) => entry.personId)).toEqual([TEST_CEO.personId]);
      expect(index[0]).toMatchObject({ name: "测试甲" });
      expect(index[0].labels).toEqual(expect.arrayContaining(["公开技能：部署验收", "负责能力域：研发", "负责战场：增长战场"]));
      expect(index[0].labels.join()).not.toContain("个人复盘口径");
      expect(index[0].labels.join()).not.toContain("归档的技能");
      expect(matchColleagues(index, "个人复盘")).toEqual({ people: [], more: 0 });
      expect(matchColleagues(index, "部署验收").people).toEqual([{ personId: TEST_CEO.personId, name: "测试甲", matched: ["公开技能：部署验收"] }]);
      // 不在覆盖里的人自己来搜：一个也搜不到。
      expect(await colleagueIndex(q, colleagues, THIRD.personId)).toEqual([]);
    } finally { await f.close(); }
  });
});
