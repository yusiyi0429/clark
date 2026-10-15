import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { editObjectMaterial } from "../src/objectMaterials.js";
import { TEST_CEO, TEST_MEMBER, createTestApp, createTestDb } from "./helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const multipart = (name: string, body: string) => {
  const boundary = "----material-origin-test";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${body}\r\n--${boundary}--\r\n`) };
};
type Revision = { version: number; origin?: string; summary: string | null; requestedBy: { personId: string } | null };
type Block = { text: string; change: { kind: string } | null; history: { version: number; origin?: string }[] };

describe("材料版本的来历（062）", () => {
  it("迁移前已有的版本一律记 agent；新写入不给时也是 agent；只收 agent / upload / import", async () => {
    await createTestDb(async ({ db }) => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql") && Number(file.split("_")[0]) <= 61).sort();
      await db.query("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        await db.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
        await db.query("INSERT INTO schema_migrations(id,filename) VALUES($1,$2)", [Number(file.split("_")[0]), file]);
      }
      const id = randomUUID();
      await db.query(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,storage_key,origin,owner_id,current_version,created_at,updated_at)
        VALUES($1,'issue','issue-old','旧清单.md','markdown',10,'objects/issue/issue-old/x','upload','chen-yan',2,now(),now())`, [id]);
      await db.query(`INSERT INTO material_revisions(material_id,version,body,requested_by,summary,created_at)
        VALUES($1,1,'原件',NULL,NULL,now()),($1,2,'改后','chen-yan','旧场次的第二版',now())`, [id]);
      await migrate(db);
      expect((await db.query("SELECT version, origin, body FROM material_revisions WHERE material_id=$1 ORDER BY version", [id])).rows)
        .toEqual([{ version: 1, origin: "agent", body: "原件" }, { version: 2, origin: "agent", body: "改后" }]);
      await db.query("INSERT INTO material_revisions(material_id,version,body,created_at) VALUES($1,3,'默认',now())", [id]);
      await db.query("INSERT INTO material_revisions(material_id,version,body,created_at,origin) VALUES($1,4,'导入',now(),'import')", [id]);
      expect((await db.query("SELECT origin FROM material_revisions WHERE material_id=$1 AND version>2 ORDER BY version", [id])).rows.map((row) => row.origin))
        .toEqual(["agent", "import"]);
      await expect(db.query("INSERT INTO material_revisions(material_id,version,body,created_at,origin) VALUES($1,5,'x',now(),'robot')", [id]))
        .rejects.toThrow(/material_revisions_origin_check/);
    });
  });

  it("导入的新版本在材料、修订记录、段落历史里都是 import；上传的原件是 upload；Agent 再改的一版是 agent", async () => {
    const storage = await mkdtemp(join(tmpdir(), "material-origin-test-"));
    const t = await createTestApp({ materialStorageDir: storage });
    try {
      const issue = await t.createIssue();
      const base = `/api/materials/issue/${issue.objectRef.id}`;
      const cookie = await t.loginCookie();
      const part = multipart("验收清单.md", "# 验收清单\n\n回款周期中位数25天。");
      const uploaded = await t.app.inject({ method: "POST", url: base, headers: { cookie, origin: t.publicOrigin, ...part.headers }, payload: part.payload });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const id = uploaded.json().id as string;
      // 资料包导入（importer）写法：资料里陈砚上传的 v2，带改动说明。
      await t.sql("INSERT INTO material_revisions(material_id,version,body,requested_by,summary,created_at,origin) VALUES($1,2,$2,$3,'按九月回款数据更新',now(),'import')",
        [id, "# 验收清单\n\n回款周期中位数27天。", TEST_MEMBER.personId]);
      await t.sql("UPDATE object_materials SET current_version=2 WHERE id=$1", [id]);
      const get = async (url: string) => (await t.app.inject({ method: "GET", url, headers: { cookie } })).json();

      const imported = await get(`${base}/${id}`);
      expect(imported.revision).toMatchObject({ version: 2, origin: "import", summary: "按九月回款数据更新", requestedBy: { personId: TEST_MEMBER.personId } });
      expect(imported.material.lastRevision).toMatchObject({ version: 2, origin: "import" });
      expect((imported.revisions as Revision[]).map((item) => [item.version, item.origin])).toEqual([[2, "import"], [1, "upload"]]);
      const changed = (imported.blocks as Block[]).find((block) => block.change?.kind === "modified")!;
      expect(changed.history.map((entry) => [entry.version, entry.origin])).toEqual([[2, "import"]]);
      expect((await get(base)).materials[0].lastRevision).toMatchObject({ version: 2, origin: "import" });

      const ceo = { personId: TEST_CEO.personId, role: "ceo" as const, displayName: "测试甲" };
      expect(await editObjectMaterial(t.pool, { objectType: "issue", objectId: issue.objectRef.id }, id, ceo, 2,
        [{ find: "27天", replace: "28天" }], "改天数", randomUUID())).toEqual({ version: 3, changed: 1 });
      const edited = await get(`${base}/${id}`);
      expect(edited.revision).toMatchObject({ version: 3, origin: "agent", requestedBy: { personId: TEST_CEO.personId } });
      expect((edited.revisions as Revision[]).map((item) => [item.version, item.origin])).toEqual([[3, "agent"], [2, "import"], [1, "upload"]]);
      const block = (edited.blocks as Block[]).find((item) => item.change?.kind === "modified")!;
      expect(block.history.map((entry) => [entry.version, entry.origin])).toEqual([[3, "agent"], [2, "import"]]);
      // 看旧版：选中版本的记录仍是 import。
      expect((await get(`${base}/${id}?version=2`)).revision).toMatchObject({ version: 2, origin: "import" });
    } finally { await t.close(); await rm(storage, { recursive: true, force: true }); }
  }, 20_000);
});
