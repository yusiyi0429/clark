import { Pool } from "pg";
import { loadPeople } from "../src/companyMemory.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.log("用法：pnpm --filter @warmap/api mission-cards:import <mission-card-drafts.v1.json 文件路径>");
    console.log("需要 DATABASE_URL、COMPANY_PEOPLE_SEED；仅导入已签发目标下的讨论候选，同文件重跑不覆盖。");
    if (args[0] !== "--help") process.exitCode = 1;
    return;
  }
  const people = loadPeople(requiredEnv("COMPANY_PEOPLE_SEED"));
  const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL"), max: 2 });
  try {
    const { importMissionCardDrafts } = await import("../src/missionRounds.js");
    const result = await importMissionCardDrafts(pool, people, args[0], () => new Date());
    const names = new Map(people.map((person) => [person.personId, person.displayName]));
    console.table(result.cards.map((card) => ({ 姓名: names.get(card.ownerId) ?? card.ownerId, 个人任务: card.missionCount })));
    console.log(result.imported ? "已整理讨论候选（占位），尚未开放讨论。" : "同一文件已整理，本次没有写入。" );
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "导入失败");
  process.exitCode = 1;
});
