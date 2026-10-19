import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { CreateMissionRequest, type TCreateMissionRequest } from "@warmap/contracts";
import { loadPeople } from "../src/peopleDirectory.js";

/**
 * 一次性把飞书里的个人 Mission Card 导入 missions（2026-09 上线前：9 月个人卡只在飞书里）。
 * 与 CEO 接口 POST /api/config/missions 同一套校验与写入（契约校验、负责人 / 能力域 / 战场关系校验、registerMission）。
 * 能力域、战场按编号匹配本库的注册表，不写死 id。整批在一个事务里：有任何一条不合法就全部不写。
 * 同一条（同编号 + 同标题）已经在库里就跳过，可以重复运行。
 */
type Row = Omit<TCreateMissionRequest, "capabilityId" | "battlefieldIds" | "period"> & { capabilityCode: string; battlefieldCodes: string[] };
type File = { period: string; missions: Row[] };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((arg) => !arg.startsWith("--"));
  if (!path || args.includes("--help")) {
    console.log("用法：pnpm --filter @warmap/api missions:import <missions.json> [--dry-run]");
    console.log("需要 DATABASE_URL、COMPANY_PEOPLE_SEED；--dry-run 只校验不写入。");
    if (!args.includes("--help")) process.exitCode = 1;
    return;
  }
  const file = JSON.parse(await readFile(path, "utf8")) as File;
  const people = loadPeople(requiredEnv("COMPANY_PEOPLE_SEED"));
  const names = new Map(people.map((person) => [person.personId, person.displayName]));
  const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL"), max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 动态导入：不带 DATABASE_URL 看用法时不加载业务模块。
    const { registerMission, validateMissionRelations } = await import("../src/missions.js");
    const q = client.query.bind(client);
    const capabilities = new Map((await q("SELECT id, code FROM capability_config")).rows.map((row) => [row.code as string, row.id as string]));
    const battlefields = new Map((await q("SELECT id, code FROM battlefield_config")).rows.map((row) => [row.code as string, row.id as string]));
    const report: Record<string, string>[] = [];
    const problems: string[] = [];
    for (const row of file.missions) {
      const { capabilityCode, battlefieldCodes, ...rest } = row;
      const capabilityId = capabilities.get(capabilityCode);
      const battlefieldIds = battlefieldCodes.map((code) => battlefields.get(code));
      if (!capabilityId) { problems.push(`${row.code}：能力域编号 ${capabilityCode} 不在注册表`); continue; }
      if (battlefieldIds.some((id) => !id)) { problems.push(`${row.code}：战场编号 ${battlefieldCodes.join("/")} 有不在注册表的`); continue; }
      const input = { ...rest, period: file.period, capabilityId, battlefieldIds: battlefieldIds as string[] } as TCreateMissionRequest;
      if (!Value.Check(CreateMissionRequest, input)) {
        const first = [...Value.Errors(CreateMissionRequest, input)][0];
        problems.push(`${row.code}：${first?.path ?? "/"} ${first?.message ?? "不合契约"}`);
        continue;
      }
      const invalid = await validateMissionRelations(q, names, input);
      if (invalid) { problems.push(`${row.code}：${invalid.message}`); continue; }
      const result = dryRun ? { ok: true as const, id: "(dry-run)" } : await registerMission(q, input);
      if (!result.ok && result.code !== "MISSION_EXISTS") { problems.push(`${row.code}：${result.message}`); continue; }
      report.push({ 编号: row.code, 负责人: names.get(row.ownerId) ?? row.ownerId, 标题: row.title.slice(0, 30), 结果: dryRun ? "校验通过" : result.ok ? "已导入" : "已存在，跳过" });
    }
    console.table(report);
    if (problems.length) {
      await client.query("ROLLBACK");
      console.error(`有 ${problems.length} 条不合法，整批没有写入：\n${problems.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    console.log(dryRun ? `校验通过 ${report.length} 条（--dry-run，没有写入）。` : `完成：${report.filter((item) => item.结果 === "已导入").length} 条导入，${report.filter((item) => item.结果 !== "已导入").length} 条已存在。`);
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
