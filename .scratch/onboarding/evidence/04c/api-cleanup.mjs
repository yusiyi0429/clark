// Only remove databases from this ticket's failed setup, verified by creation time and fixture fingerprint.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../../../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const base = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
const admin = new Pool({ connectionString: base, max: 1 });
const results = [];
const mode = process.argv.includes("--ipc") ? "ipc" : "setup";
const log = mode === "ipc" ? await readFile(new URL("./api-review-green.log", import.meta.url), "utf8") : "";
const recordedRounds = new Set([...log.matchAll(/mission-round:([a-f0-9-]{36})/g)].map((match) => match[1]));
try {
  const databases = (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'warmap_test_%' ORDER BY datname")).rows;
  for (const { datname } of databases) {
    if (!/^warmap_test_[0-9a-f]{12}$/.test(datname)) continue;
    const db = new Pool({ connectionString: base.replace(/\/postgres$/, `/${datname}`), max: 1 });
    let record;
    try {
      const installed = (await db.query("SELECT to_regclass('public.schema_migrations') AS present")).rows[0].present;
      if (!installed) continue;
      const { first_applied: first } = (await db.query("SELECT min(applied_at) AS first_applied FROM schema_migrations")).rows[0];
      const from = mode === "setup" ? "2026-09-26T23:05:06Z" : "2026-09-26T23:10:00Z";
      const to = mode === "setup" ? "2026-09-26T23:05:20Z" : "2026-09-26T23:10:40Z";
      if (!first || first < new Date(from) || first > new Date(to)) continue;
      const rounds = (await db.query("SELECT id,status,created_at,draft_source FROM mission_rounds")).rows;
      const counts = (await db.query(`SELECT (SELECT count(*)::int FROM personal_mission_cards) AS cards,
        (SELECT count(*)::int FROM missions) AS missions`)).rows[0];
      record = { database: datname, firstApplied: first.toISOString(), rounds, ...counts };
      record.matchesFailedSetup = rounds.length === 1 && rounds[0].status === "draft"
        && rounds[0].created_at.toISOString() === "2026-10-01T02:00:00.000Z"
        && JSON.stringify(rounds[0].draft_source) === "{}" && counts.cards === 1 && counts.missions === 0;
      record.matchesRecordedIpcRound = rounds.length > 0 && rounds.every((round) => recordedRounds.has(round.id));
    } finally { await db.end(); }
    if (!record) continue;
    if (mode === "setup" ? record.matchesFailedSetup : record.matchesRecordedIpcRound) {
      await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
      record.removed = true;
    }
    results.push(record);
  }
  await writeFile(new URL(mode === "setup" ? "./api-cleanup.json" : "./api-ipc-cleanup.json", import.meta.url), JSON.stringify({ criteria: mode === "setup"
    ? "First migrations 2026-09-26 23:05:06–23:05:20 UTC, one 04c draft round, one card, no Missions"
    : "First migrations 2026-09-26 23:10:00–23:10:40 UTC and every round ID explicitly recorded in api-review-green.log", results }, null, 2));
  console.log(JSON.stringify({ inspectedMatchingTime: results.length, removed: results.filter((r) => r.removed).length }));
} finally { await admin.end(); }
