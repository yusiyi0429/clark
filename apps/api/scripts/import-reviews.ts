import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { loadPeople } from "../src/peopleDirectory.js";

/**
 * 把飞书里写完的月度复盘导入天枢（2026-10 首轮上线：9 月复盘在飞书「业务域」里）。前提：missions:import 已导入该月 Mission。
 * 个人复盘四栏用复盘契约校验；整批在一个事务里，有任何问题就全部不写；已导入的、本人或 CEO 已经处理过的跳过，可以重复运行。
 * CLI 只写状态：Co-Agent 起草（按材料起草的个人复盘、交齐后的战场 / 能力域复盘）由运行中的 API 服务接手，月末复盘调度器每分钟检查一次。
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cycleAt = args.indexOf("--cycle-start");
  const cycleText = cycleAt >= 0 ? args[cycleAt + 1] : undefined;
  const cycleStart = new Date(cycleText ?? "");
  const path = args.find((arg, index) => !arg.startsWith("--") && !(cycleAt >= 0 && index === cycleAt + 1));
  if (!path || Number.isNaN(cycleStart.getTime()) || args.includes("--help")) {
    console.log("用法：pnpm --filter @warmap/api reviews:import <reviews.json> --cycle-start <ISO 时间> [--dry-run]");
    console.log("需要 DATABASE_URL、COMPANY_PEOPLE_SEED；--cycle-start 是开工时间，72 小时倒计时从这里算；--dry-run 只校验不写入。");
    if (!args.includes("--help")) process.exitCode = 1;
    return;
  }
  // 动态导入：只看用法时不加载业务模块。
  const { ReviewImportFile, importMonthlyReviews } = await import("../src/monthlyReviewImport.js");
  const file: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Value.Check(ReviewImportFile, file)) {
    const errors = [...Value.Errors(ReviewImportFile, file)].slice(0, 10).map((error) => `${error.path || "/"} ${error.message}`);
    console.error(`文件不合契约，没有写入：\n${errors.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const people = loadPeople(requiredEnv("COMPANY_PEOPLE_SEED"));
  const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL"), max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { report, problems } = await importMonthlyReviews(client.query.bind(client), file, people, cycleStart, new Date());
    if (report.length) console.table(report);
    if (problems.length) {
      await client.query("ROLLBACK");
      console.error(`有 ${problems.length} 个问题，整批没有写入：\n${problems.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    const count = (prefix: string) => report.filter((row) => row.结果.startsWith(prefix)).length;
    const drafting = count("交给 Co-Agent");
    console.log(`${dryRun ? "校验通过（--dry-run，没有写入）" : "完成"}：${count("导入为已提交")} 份个人复盘导入为已提交，${drafting} 份交给 Co-Agent 起草，`
      + `${count("导入并确认")} 项复盘导入并确认；开工时间 ${cycleText}。`);
    if (!dryRun && drafting) console.log("起草由运行中的 API 服务接手（每分钟检查一次），结果停在草稿等本人提交。");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "导入失败");
  process.exitCode = 1;
});
