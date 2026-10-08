import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

const script = (name: string) => readFileSync(fileURLToPath(new URL(`../../../infra/backup/${name}`, import.meta.url)), "utf8");

/** 备份/恢复脚本里内嵌的存储行 SQL：deployment.test 用桩替掉了 psql，这里在真实 PostgreSQL 上跑一遍。 */
const BACKUP_SQL = /STORAGE_ROWS_SQL="([^"]+)"/.exec(script("backup.sh"))![1];
const RESTORE_SQL = /storage_rows=\$\("\$PSQL_BIN" "\$TARGET_URL" -Atc "([^"]+)"\)/.exec(script("restore.sh"))![1];

describe("backup/restore storage-row SQL on real PostgreSQL", () => {
  it("both scripts carry the same query and it runs against the migrated schema", async () => {
    expect(RESTORE_SQL).toBe(BACKUP_SQL);
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const probe = BACKUP_SQL
        .replace("FROM meetings m, jsonb_array_elements(m.materials) value", `FROM (VALUES ('m-1', '[{"storageKey":"meet/m-1","sha256":"aa11"},{"storageKey":""}]'::jsonb)) m(id, materials), jsonb_array_elements(m.materials) value`)
        .replace("FROM conversation_messages cm, jsonb_array_elements(cm.attachments) a", `FROM (VALUES ('c-1', 3, '[{"storageKey":"conv/a-1","sha256":"bb22"}]'::jsonb)) cm(conversation_id, sequence, attachments), jsonb_array_elements(cm.attachments) a`);
      expect((await db.query(BACKUP_SQL)).rows).toEqual([]);
      expect((await db.query(probe)).rows.map((row) => Object.values(row)[0])).toEqual([
        "meeting_material|m-1|meet/m-1|aa11",
        "conversation_attachment|c-1:3|conv/a-1|bb22",
      ]);
    });
  });
});
