import { fileURLToPath } from "node:url";

// Run the real app and existing assertions against disposable embedded PostgreSQL.
// Only the database helper and the legacy thread fixture's explicit timeout are adapted below.
const appRoot = fileURLToPath(new URL("../../apps/api",import.meta.url));
const adapter = fileURLToPath(new URL("qa/isolated-pg.mjs",import.meta.url)).replaceAll("\\","/");
export default {
  root: appRoot,
  test: { fileParallelism:false, maxWorkers:1, testTimeout:90000, hookTimeout:90000 },
  plugins: [{
    name:"offline-test-database", enforce:"pre",
    transform(code:string,id:string) {
      // This older test includes database creation and an SSE stream in its explicit 15s budget.
      if (id.replaceAll("\\","/").endsWith("/test/threadGroups.test.ts"))
        return code.replaceAll("}, 15_000);","}, 60_000);");
      if (!id.replaceAll("\\","/").endsWith("/test/helpers.ts")) return;
      const start = code.indexOf("  const database = ",code.indexOf("export async function createTestApp("));
      const end = code.indexOf("  const client = await pool.connect();", start);
      if (start < 0 || end < start) throw new Error("Test DB helper shape changed");
      code = code.slice(0,start) +
        `  const { createIsolatedPool } = await import(${JSON.stringify(adapter)});
  const {pool, close: closeIsolated} = await createIsolatedPool();
  const migrateClient = await pool.connect();
  try { await migrate(migrateClient); } finally { migrateClient.release(); }
` + code.slice(end);
      const cleanup = /await pool\.end\(\);[\s\S]*?await admin\.end\(\);/;
      const cut = code.indexOf("export async function createTestApp(");
      return code.slice(0,cut) + code.slice(cut).replace(cleanup,"await closeIsolated();");
    },
  }],
};
