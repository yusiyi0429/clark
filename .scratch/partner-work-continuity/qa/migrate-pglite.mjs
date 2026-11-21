import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from './pglite.mjs';
const db = new PGlite('memory://');
const migrations = new URL('../../../apps/api/migrations/', import.meta.url);

try {
  const version = (await db.query('SELECT version() AS version')).rows[0].version;
  const files = (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort();
  console.log(JSON.stringify({ version, migrations: files.length }));
  for (const file of files) {
    try {
      await db.exec(await readFile(new URL(file, migrations), 'utf8'));
    } catch (error) {
      console.error(JSON.stringify({ migration: file, code: error.code, reason: error.message }));
      throw error;
    }
  }
  const { rows } = await db.query("SELECT count(*)::integer AS tables FROM pg_tables WHERE schemaname='public'");
  console.log(JSON.stringify({ migrated: true, last: files.at(-1), tables: rows[0].tables }));
} finally {
  await db.close();
}
