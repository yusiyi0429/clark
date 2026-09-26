import { Pool } from "pg";
import { loadPeople } from "../src/companyMemory.js";
import { loginIdFor, randomInitialPasscode, roleOf, setMemberAccess } from "../src/memberAccess.js";

/**
 * 发初始码：`pnpm --filter @warmap/api access:issue [personId[:loginId] ...]`
 * - 不带参数：给 seed 里还没有凭据的人发码。
 * - 带参数：给这些人重置（旧会话立即失效）；`personId:loginId` 手工指定登录 ID。
 * 初始码只出现在这一次输出里；首次登录后必须改成自己的 4 位口令。
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL") });
try {
  const people = loadPeople(requiredEnv("COMPANY_PEOPLE_SEED"));
  const rows = (await pool.query<{ person_id: string; login_id: string }>("SELECT person_id, login_id FROM member_access")).rows;
  const loginIdOf = new Map(rows.map((row) => [row.person_id, row.login_id]));
  const ownerOf = new Map(rows.map((row) => [row.login_id, row.person_id]));
  const requested = process.argv.slice(2).map((arg) => {
    const [personId, loginId] = arg.split(":");
    return { personId, loginId: loginId || undefined };
  });
  const targets = requested.length
    ? requested
    : people.filter((person) => !loginIdOf.has(person.personId)).map((person) => ({ personId: person.personId, loginId: undefined }));

  const issued: Record<string, string>[] = [];
  for (const target of targets) {
    const person = people.find((p) => p.personId === target.personId);
    if (!person) throw new Error(`seed 里没有 ${target.personId}`);
    const loginId = target.loginId ?? loginIdOf.get(person.personId) ?? loginIdFor(person.personId);
    if (!loginId || !/^[a-z]{2,20}$/.test(loginId)) {
      throw new Error(`${person.displayName}（${person.personId}）推不出登录 ID，请用 ${person.personId}:<id> 指定（2–20 个小写字母）`);
    }
    const owner = ownerOf.get(loginId);
    if (owner && owner !== person.personId) throw new Error(`登录 ID ${loginId} 已属于 ${owner}，请用 ${person.personId}:<id> 另外指定`);
    ownerOf.set(loginId, person.personId);
    const passcode = randomInitialPasscode();
    await setMemberAccess(pool.query.bind(pool), { personId: person.personId, loginId, passcode, mustChange: true });
    issued.push({ 姓名: person.displayName, ID: loginId, 初始码: passcode, 身份: roleOf(person) === "ceo" ? "CEO" : "成员" });
  }
  if (issued.length) console.table(issued);
  else console.log("seed 里的人都已有凭据；要重置请指定 personId。");
} finally {
  await pool.end();
}
