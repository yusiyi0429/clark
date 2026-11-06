import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcceptanceInput, CardAcceptanceAgent } from "../src/cardAcceptanceAgent.js";
import type { RoleProposalAgent, RoleProposalInput } from "../src/roleProposalAgent.js";
import { parsePreset, readPresets, syncRolePresets } from "../src/roles.js";
import { createTestDb } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

/** 仓库里的预设（正文会由业务同事改，测试按文件里的读，不写死）。 */
const repoPreset = async (key: string) => (await readPresets()).presets.find((item) => item.key === key)!;
const preset = (name: string, practice = "先交提纲") => `---\nname: ${name}\nkind: worker\ntools: [tianshu, web_search]\nmodel_tier: strong\n---\n\n## 职责\n\n查资料\n\n## 做法\n\n${practice}\n\n## 验收口径\n\n有出处\n`;

describe("岗位：预设同步", () => {
  it("预设文件按 frontmatter 加三段正文读；格式不对说清哪里不对；仓库里的预设都读得出来", async () => {
    expect(parsePreset(preset("调研员"), "strategy_content", "researcher")).toEqual({ key: "researcher", family: "strategy_content", name: "调研员", kind: "worker",
      tools: ["tianshu", "web_search"], modelTier: "strong", dutiesMd: "查资料", practiceMd: "先交提纲", acceptanceMd: "有出处" });
    expect(() => parsePreset(preset("调研员"), "finance", "x")).toThrow("岗位包只能是");
    expect(() => parsePreset(preset("调研员").replace("kind: worker", "kind: boss"), "general", "x")).toThrow("kind 只能是");
    expect(() => parsePreset(preset("调研员").replace("## 做法", "## 方法"), "general", "x")).toThrow("正文要有「## 做法」一段");
    expect(() => parsePreset("没有 frontmatter", "general", "x")).toThrow("frontmatter");
    const real = await readPresets();
    expect(real.errors).toEqual([]);
    expect(real.presets.map((item) => [item.family, item.key, item.kind])).toEqual(expect.arrayContaining([
      ["general", "opponent", "critic"], ["general", "reviewer", "reviewer"], ["strategy_content", "researcher", "worker"]]));
  });

  it("同步进库：新的插入，内容变了版本 +1，文件没了归档、回来了取消归档；坏文件跳过不拦别的", async () => {
    const dir = await mkdtemp(join(tmpdir(), "presets-"));
    try {
      await mkdir(join(dir, "strategy_content"));
      await mkdir(join(dir, "general"));
      await writeFile(join(dir, "strategy_content", "researcher.md"), preset("调研员"));
      await writeFile(join(dir, "general", "writer.md"), preset("写稿人"));
      await writeFile(join(dir, "general", "broken.md"), "坏的");
      await createTestDb(async ({ pool }) => {
        const now = new Date("2026-11-06T00:00:00Z");
        const first = await readPresets(dir);
        expect(first.errors).toHaveLength(1);
        expect(await syncRolePresets(pool, first.presets, now)).toEqual({ inserted: 2, updated: 0, archived: 0 });
        expect(await syncRolePresets(pool, first.presets, now)).toEqual({ inserted: 0, updated: 0, archived: 0 });
        await writeFile(join(dir, "strategy_content", "researcher.md"), preset("调研员", "先交提纲，再写"));
        await rm(join(dir, "general", "writer.md"));
        expect(await syncRolePresets(pool, (await readPresets(dir)).presets, now)).toEqual({ inserted: 0, updated: 1, archived: 1 });
        const rows = (await pool.query("SELECT preset_key,version,preset_version,practice_md,archived_at IS NOT NULL AS archived FROM roles WHERE owner_id IS NULL ORDER BY preset_key")).rows;
        expect(rows).toEqual([{ preset_key: "researcher", version: 2, preset_version: 2, practice_md: "先交提纲，再写", archived: false },
          { preset_key: "writer", version: 1, preset_version: 1, practice_md: "先交提纲", archived: true }]);
        await writeFile(join(dir, "general", "writer.md"), preset("写稿人"));
        expect(await syncRolePresets(pool, (await readPresets(dir)).presets, now)).toEqual({ inserted: 0, updated: 1, archived: 0 });
        expect((await pool.query("SELECT version,archived_at FROM roles WHERE preset_key='writer'")).rows[0]).toEqual({ version: 1, archived_at: null });
      }, { migrated: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("岗位：本人的团队", () => {
  it("列岗位和预设；从预设加是一份副本、加过的再加 409；自己新建；改了版本 +1 留记录、版本不对 409；归档以后不列、记录还在、能再加", async () => {
    const f = await boardFixture();
    try {
      const list = (await f.call("GET", "/api/me/roles")).json();
      expect(list.roles).toEqual([]);
      const researcher = await repoPreset("researcher");
      expect(list.presets.length).toBe((await readPresets()).presets.length);
      expect(list.presets.every((item: { added: boolean }) => !item.added)).toBe(true);
      const added = await f.call("POST", "/api/me/roles", { presetKey: "researcher" });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ name: researcher.name, family: "strategy_content", kind: "worker", presetKey: "researcher", presetVersion: 1, version: 1,
        tools: researcher.tools, modelTier: researcher.modelTier, practiceMd: researcher.practiceMd });
      expect((await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json()).toMatchObject({ code: "PRESET_ADDED" });
      expect((await f.call("POST", "/api/me/roles", { presetKey: "nope" })).statusCode).toBe(404);
      const own = await f.call("POST", "/api/me/roles", { name: "写稿人", family: "strategy_content", kind: "worker" });
      expect(own.json()).toMatchObject({ name: "写稿人", presetKey: null, dutiesMd: "", tools: [], modelTier: "normal" });

      const id = added.json().id;
      const changed = await f.call("PATCH", `/api/me/roles/${id}`, { version: 1, practiceMd: "先交提纲，中文来源优先", tools: ["github"], reason: "上次查了太多英文" });
      expect(changed.json()).toMatchObject({ version: 2, practiceMd: "先交提纲，中文来源优先", tools: ["github"], updatedBy: { name: expect.any(String) } });
      expect((await f.call("PATCH", `/api/me/roles/${id}`, { version: 1, name: "改名" })).json()).toMatchObject({ code: "ROLE_VERSION_CONFLICT" });
      expect((await f.call("PATCH", `/api/me/roles/${id}`, { version: 2 })).statusCode).toBe(400);
      const revisions = (await f.call("GET", `/api/me/roles/${id}/revisions`)).json().revisions;
      expect(revisions).toMatchObject([{ version: 2, source: "manual", reason: "上次查了太多英文", proposalId: null, changes: [
        { field: "practiceMd", before: researcher.practiceMd, after: "先交提纲，中文来源优先" },
        { field: "tools", before: researcher.tools.join(", "), after: "github" }] }]);

      expect((await f.call("DELETE", `/api/me/roles/${id}`)).statusCode).toBe(204);
      const after = (await f.call("GET", "/api/me/roles")).json();
      expect(after.roles.map((role: { name: string }) => role.name)).toEqual(["写稿人"]);
      expect(after.presets.find((item: { presetKey: string }) => item.presetKey === "researcher").added).toBe(false);
      expect((await f.call("GET", `/api/me/roles/${id}/revisions`)).json().revisions).toHaveLength(1);
      expect((await f.call("PATCH", `/api/me/roles/${id}`, { version: 2, name: "x" })).statusCode).toBe(404);
      expect((await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).statusCode).toBe(201);
    } finally { await f.close(); }
  });

  it("岗位改了，下一张卡的交代就变；开工时记下岗位版本", async () => {
    const f = await boardFixture();
    try {
      const role = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker", dutiesMd: "写代码", practiceMd: "先写测试", acceptanceMd: "测试都过" })).json();
      const card = await f.card("修一个问题");
      expect((await f.call("PATCH", `/api/me/cards/${card}`, { version: 1, roleId: role.id })).json().card.role).toEqual({ id: role.id, name: "开发", kind: "worker" });
      const before = (await f.call("GET", `/api/me/cards/${card}/brief`)).json();
      expect(before.role).toMatchObject({ id: role.id, name: "开发", practiceMd: "先写测试", acceptanceMd: "测试都过", version: 1 });
      expect(before.markdown).toContain("- 岗位：开发");
      expect(before.markdown).toContain("## 开发的验收口径\n\n测试都过");
      await f.call("PATCH", `/api/me/roles/${role.id}`, { version: 1, acceptanceMd: "测试都过，覆盖到改动的分支" });
      const next = (await f.call("GET", `/api/me/cards/${card}/brief`)).json();
      expect(next.role).toMatchObject({ acceptanceMd: "测试都过，覆盖到改动的分支", version: 2 });
      expect(next.markdown).toContain("测试都过，覆盖到改动的分支");
      const local = await f.local();
      await local.handBack(card);
      expect((await f.t.sql("SELECT role_version FROM tasks WHERE id=$1", [card]))[0].role_version).toBe(2);
      expect((await f.call("PATCH", `/api/me/cards/${card}`, { version: 2, roleId: randomUUID() })).json()).toMatchObject({ code: "ROLE_NOT_FOUND" });
    } finally { await f.close(); }
  });
});

describe("岗位：验收口径和会成长", () => {
  async function growthFixture() {
    const acceptanceCalls: AcceptanceInput[] = [];
    const proposalCalls: RoleProposalInput[] = [];
    const verdicts: ("met" | "unmet")[][] = [];
    const acceptance: CardAcceptanceAgent = { async accept(input) {
      acceptanceCalls.push(input);
      const next = verdicts.shift() ?? input.card.criteria.map(() => "met" as const);
      return { headline: "结论", beyondScope: [], criteria: next.map((verdict, index) => ({ index: index + 1, verdict, reason: "理由",
        evidence: verdict === "met" ? "产出" : null, fix: verdict === "met" ? null : "补上" })) };
    } };
    const proposal: RoleProposalAgent = { async propose(input) {
      proposalCalls.push(input);
      if (input.card.title === "写不出来") throw new Error("模型出错了");
      const target = input.sourceKind === "overrule" ? input.roles[input.roles.length - 1] : input.roles[0];
      const field = input.sourceKind === "overrule" ? "acceptanceMd" as const : "practiceMd" as const;
      return { roleId: target.id, field, proposedText: `${target[field]}\n- 这次学到的一句`, why: "这张卡上没对上" };
    } };
    const f = await boardFixture({ boardAgents: { acceptance, proposal } });
    const worker = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker", practiceMd: "先写测试", acceptanceMd: "测试都过" })).json();
    const local = await f.local();
    const card = async (title: string) => {
      const id = await f.card(title);
      await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, executor: "claude_code", roleId: worker.id });
      return id;
    };
    const settle = async () => { await f.t.app.cardAcceptance.idle(); await f.t.app.roleProposals.idle(); };
    return { ...f, acceptanceCalls, proposalCalls, verdicts, worker, local, card, settle };
  }

  it("验收员拿到三样口径：约定、卡所属岗位的验收口径、验收员的口径；本人没有验收员岗位时用预设的", async () => {
    const f = await growthFixture();
    try {
      const first = await f.card("用预设的验收员");
      await f.local.handBack(first);
      await f.settle();
      const preset = await repoPreset("reviewer");
      expect(f.acceptanceCalls[0]).toMatchObject({ agreement: null, role: { name: "开发", acceptanceMd: "测试都过" },
        reviewer: { name: preset.name, practiceMd: preset.practiceMd, acceptanceMd: preset.acceptanceMd } });
      const reviewer = (await f.call("POST", "/api/me/roles", { presetKey: "reviewer" })).json();
      await f.call("PATCH", `/api/me/roles/${reviewer.id}`, { version: 1, acceptanceMd: "截图要能看清" });
      const second = await f.card("用本人的验收员");
      await f.local.handBack(second);
      await f.settle();
      expect(f.acceptanceCalls[1]).toMatchObject({ role: { name: "开发" }, reviewer: { acceptanceMd: "截图要能看清" } });
    } finally { await f.close(); }
  });

  it("推翻通过的、推翻没过的、第二次没过各提一条岗位修改；一张卡只提一条；采纳写回版本 +1 留记录，岗位后来改过就不能采纳；能不要", async () => {
    const f = await growthFixture();
    try {
      const reviewer = (await f.call("POST", "/api/me/roles", { presetKey: "reviewer" })).json();
      const passed = await f.card("通过但被推翻");
      const handback = await f.local.handBack(passed);
      await f.settle();
      await f.call("POST", `/api/me/cards/${passed}/handbacks/${handback}/overrule`, { reason: "截图不是这次的" });
      await f.settle();
      expect(f.proposalCalls[0]).toMatchObject({ sourceKind: "overrule", reason: "截图不是这次的", card: { title: "通过但被推翻" },
        acceptance: { outcome: "pass" }, roles: [{ id: f.worker.id, name: "开发" }, { id: reviewer.id, kind: "reviewer" }] });
      const open = (await f.call("GET", "/api/me/role-proposals")).json().proposals;
      expect(open).toMatchObject([{ role: { id: reviewer.id, name: reviewer.name }, baseVersion: 1, sourceKind: "overrule", handbackId: handback,
        card: { id: passed, title: "通过但被推翻" }, field: "acceptanceMd", currentText: reviewer.acceptanceMd,
        proposedText: `${reviewer.acceptanceMd}\n- 这次学到的一句`, why: "这张卡上没对上", status: "open", decidedAt: null }]);

      const accepted = await f.call("POST", `/api/me/role-proposals/${open[0].id}/accept`);
      expect(accepted.json()).toMatchObject({ id: reviewer.id, version: 2, acceptanceMd: `${reviewer.acceptanceMd}\n- 这次学到的一句` });
      expect((await f.call("GET", `/api/me/roles/${reviewer.id}/revisions`)).json().revisions).toMatchObject([
        { version: 2, source: "proposal", proposalId: open[0].id, reason: "这张卡上没对上", changes: [{ field: "acceptanceMd" }] }]);
      expect((await f.call("POST", `/api/me/role-proposals/${open[0].id}/accept`)).json()).toMatchObject({ code: "PROPOSAL_DECIDED" });
      expect((await f.call("GET", "/api/me/role-proposals")).json().proposals).toEqual([]);

      // 同一张卡再推翻一次（重交、没过、算通过），不再提。
      f.verdicts.push(["met", "unmet"]);
      const again = await f.local.handBack(passed);
      await f.settle();
      await f.call("POST", `/api/me/cards/${passed}/handbacks/${again}/overrule`, { reason: "这次够了" });
      await f.settle();
      expect(f.proposalCalls).toHaveLength(1);

      // 第二次没过：提一条做法的修改；岗位之后又改过，采纳 409；不要。
      const failing = await f.card("两次没过");
      f.verdicts.push(["unmet", "met"], ["met", "unmet"]);
      await f.local.handBack(failing);
      await f.settle();
      expect(f.proposalCalls).toHaveLength(1);
      await f.local.handBack(failing);
      await f.settle();
      expect(f.proposalCalls[1]).toMatchObject({ sourceKind: "second_fail", reason: null, roles: [{ id: f.worker.id }] });
      const second = (await f.call("GET", "/api/me/role-proposals")).json().proposals;
      expect(second).toMatchObject([{ role: { id: f.worker.id }, sourceKind: "second_fail", field: "practiceMd", proposedText: "先写测试\n- 这次学到的一句" }]);
      await f.call("PATCH", `/api/me/roles/${f.worker.id}`, { version: 1, practiceMd: "先读代码再写测试" });
      expect((await f.call("POST", `/api/me/role-proposals/${second[0].id}/accept`)).json()).toMatchObject({ code: "ROLE_CHANGED" });
      expect((await f.call("POST", `/api/me/role-proposals/${second[0].id}/dismiss`)).json()).toMatchObject({ status: "dismissed" });
      expect((await f.call("GET", "/api/me/role-proposals?status=all")).json().proposals.map((item: { status: string }) => item.status)).toEqual(["dismissed", "accepted"]);
    } finally { await f.close(); }
  });

  it("同一岗位同时最多 3 条待确认，作业没写成的不给本人看，重启后还在写的接着写", async () => {
    const f = await growthFixture();
    try {
      for (let index = 0; index < 4; index++) {
        const id = await f.card(`卡 ${index}`);
        const handback = await f.local.handBack(id);
        await f.settle();
        await f.call("POST", `/api/me/cards/${id}/handbacks/${handback}/overrule`, { reason: `第 ${index} 次` });
        await f.settle();
      }
      expect((await f.call("GET", "/api/me/role-proposals")).json().proposals).toHaveLength(3);
      expect(f.proposalCalls).toHaveLength(3);

      await f.t.sql("UPDATE role_proposals SET status='dismissed' WHERE status='open'");
      const broken = await f.card("写不出来");
      const brokenHandback = await f.local.handBack(broken);
      await f.settle();
      await f.call("POST", `/api/me/cards/${broken}/handbacks/${brokenHandback}/overrule`, { reason: "不对" });
      await f.settle();
      expect((await f.t.sql("SELECT status FROM role_proposals WHERE task_id=$1", [broken]))[0].status).toBe("failed");
      expect((await f.call("GET", "/api/me/role-proposals?status=all")).json().proposals.map((item: { card: { id: string } }) => item.card.id)).not.toContain(broken);

      const id = await f.card("重启接着写");
      const proposalId = randomUUID(), handback = randomUUID();
      await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status,outcome) VALUES($1,$2,$3,'x',1,'["甲"]'::jsonb,'done','pass')`,
        [handback, id, (await f.t.sql("SELECT owner_id FROM tasks WHERE id=$1", [id]))[0].owner_id]);
      await f.t.sql(`INSERT INTO role_proposals(id,role_id,owner_id,task_id,source_kind,source_id,base_version) SELECT $1,$2,owner_id,id,'overrule',$3,1 FROM tasks WHERE id=$4`,
        [proposalId, f.worker.id, handback, id]);
      await f.t.app.roleProposals.recover();
      await f.settle();
      expect((await f.t.sql("SELECT status FROM role_proposals WHERE id=$1", [proposalId]))[0].status).toBe("open");
    } finally { await f.close(); }
  });
});
