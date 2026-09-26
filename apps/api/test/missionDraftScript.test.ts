import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/api/node_modules/tsx/dist/cli.mjs");
const script = join(root, "apps/api/scripts/import-mission-card-drafts.ts");

describe("Mission draft import CLI", () => {
  it("prints usage without a database and imports through the same idempotent repository", async () => {
    const help = spawnSync(process.execPath, [cli, script, "--help"], { cwd: root, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("mission-cards:import");
    await createTestDb(async ({ db, database }) => {
      await migrate(db);
      const dir = await mkdtemp(join(tmpdir(), "warmap-mission-cli-"));
      try {
        const draft = JSON.parse(await readFile(join(root, "seed/placeholders/2026-10-mission-cards.battlefield-01.json"), "utf8"));
        draft.cards = draft.cards.slice(0, 1);
        draft.cards[0].ownerId = "person-fixture-002";
        const file = join(dir, "draft.json");
        await writeFile(file, JSON.stringify(draft));
        await db.query("UPDATE battlefield_config SET code='01', owner_id='person-fixture-001' WHERE id='growth'");
        await db.query("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ('method',1,'03','Method','方法沉淀')");
        await db.query(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
          VALUES ($1,1,'2026-10','confirmed','本月目标','[{"battlefieldId":"growth","outcome":"完成结果"}]','[]','{}','{}',$2)`, [randomUUID(), "2026-10-01T00:00:00Z"]);
        const run = () => spawnSync(process.execPath, [cli, script, file], { cwd: root, encoding: "utf8", env: {
          ...process.env,
          DATABASE_URL: (process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres").replace(/\/postgres$/, `/${database}`),
          COMPANY_PEOPLE_SEED: join(root, "apps/api/test/fixtures/company-people.json"),
        } });
        const first = run();
        expect(first.status, first.stderr).toBe(0);
        expect(first.stdout).toContain("测试乙");
        expect((await db.query("SELECT count(*)::int AS count FROM missions")).rows[0].count).toBe(4);
        const before = (await db.query("SELECT row_to_json(r) AS row FROM mission_rounds r")).rows;
        expect(run().status).toBe(0);
        expect((await db.query("SELECT row_to_json(r) AS row FROM mission_rounds r")).rows).toEqual(before);
        draft.placeholderNote += "（改动）";
        await writeFile(file, JSON.stringify(draft));
        expect(run().status).toBe(1);
        expect((await db.query("SELECT count(*)::int AS count FROM missions")).rows[0].count).toBe(4);
      } finally {
        if (!resolve(dir).startsWith(join(resolve(tmpdir()), "warmap-mission-cli-"))) throw new Error("Unexpected temporary directory");
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
