// 在开发库里重置某人的首次登录引导：删掉 person_onboarding 里这个人的一行，他下次打开任意页面就会进入引导。
// 只动这一行，不动口令、会话和其他数据；走完引导或按「先进入工作台」会重新写回。
// 用法（在 apps/api 目录）：node node_modules/tsx/dist/cli.mjs --env-file=.env ../../.scratch/manual-test/reset-onboarding.ts sun-mingze
import { createRequire } from "node:module";

const personId = process.argv[2];
if (!personId || !/^[a-z0-9-]+$/.test(personId)) {
  console.error("用法：… reset-onboarding.ts <人员 ID，例如 sun-mingze；人员 ID 见 seed/company-people.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) throw new Error("没有 DATABASE_URL：请在 apps/api 目录用 --env-file=.env 运行");
const { Client } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("pg");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query("DELETE FROM person_onboarding WHERE person_id=$1", [personId]);
    console.log(result.rowCount ? `已重置 ${personId} 的首次登录引导；刷新页面就会进入引导。` : `${personId} 没有「已看过引导」的记录：要么还没看过，要么人员 ID 不对。`);
  } finally {
    await client.end();
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
