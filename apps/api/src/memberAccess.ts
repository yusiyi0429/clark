import { randomInt } from "node:crypto";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { hashSecret, verifySecret } from "./session.js";

export type SessionRole = "ceo" | "member";

export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MINUTES = 15;

const WEAK_CODES = new Set([
  ...Array.from({ length: 10 }, (_, d) => String(d).repeat(4)),
  "1234", "2345", "3456", "4567", "5678", "6789", "4321", "0123", "1212", "6969",
]);
/** ID 不存在时也跑一次 scrypt，响应时间不泄露 ID 是否存在。 */
const DUMMY_HASH = hashSecret("0000");

/** `sun-mingze` → `sunm`：姓全拼 + 名的首字母。不符合「姓-名」格式时返回 null，由管理员手工指定。 */
export function loginIdFor(personId: string): string | null {
  const match = /^([a-z]+)-([a-z])[a-z]*$/.exec(personId);
  return match ? `${match[1]}${match[2]}` : null;
}

export function randomInitialPasscode(): string {
  for (;;) {
    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    if (!WEAK_CODES.has(code)) return code;
  }
}

export const roleOf = (person: MemoryPerson): SessionRole => (person.roles.includes("ceo") ? "ceo" : "member");
export const canSwitchView = (person: MemoryPerson): boolean =>
  person.roles.includes("ceo") && (person.roles.includes("dri") || person.roles.includes("participant"));
export const canUseMemberView = (person: MemoryPerson): boolean =>
  person.roles.includes("dri") || person.roles.includes("participant");

export type AccessRow = {
  person_id: string;
  login_id: string;
  passcode_hash: string;
  must_change: boolean;
  failed_count: number;
  locked_until: Date | null;
  session_version: number;
};

/** 写入或重置凭据（发码脚本与测试用）：重置会清掉锁定并让旧会话失效。 */
export async function setMemberAccess(
  q: Query,
  input: { personId: string; loginId: string; passcode: string; mustChange: boolean },
): Promise<void> {
  await q(
    `INSERT INTO member_access (person_id, login_id, passcode_hash, must_change)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (person_id) DO UPDATE SET
       login_id = EXCLUDED.login_id,
       passcode_hash = EXCLUDED.passcode_hash,
       must_change = EXCLUDED.must_change,
       failed_count = 0,
       locked_until = NULL,
       session_version = member_access.session_version + 1,
       updated_at = now()`,
    [input.personId, input.loginId, hashSecret(input.passcode), input.mustChange],
  );
}

export type Verified = { kind: "verified"; row: AccessRow; person: MemoryPerson };
export type Rejected = { kind: "invalid" } | { kind: "locked"; retryAfterSeconds: number };

/**
 * 校验 ID + 口令，并维护错误计数与锁定：连续错 5 次锁 15 分钟，锁定期间正确口令也不放行。
 * 人从 seed 里查：seed 删掉的人即使还有凭据也进不来。
 */
export async function verifyCredentials(
  q: Query,
  findPerson: (personId: string) => MemoryPerson | undefined,
  loginId: string,
  passcode: string,
  now: Date,
): Promise<Verified | Rejected> {
  const row = (await q(
    "SELECT person_id, login_id, passcode_hash, must_change, failed_count, locked_until, session_version FROM member_access WHERE login_id = $1",
    [loginId.trim().toLowerCase()],
  )).rows[0] as AccessRow | undefined;
  if (!row) {
    verifySecret(DUMMY_HASH, passcode);
    return { kind: "invalid" };
  }
  if (row.locked_until && row.locked_until > now) {
    return { kind: "locked", retryAfterSeconds: Math.ceil((row.locked_until.getTime() - now.getTime()) / 1000) };
  }
  if (!verifySecret(row.passcode_hash, passcode)) {
    const failures = row.failed_count + 1;
    const lockedUntil = failures >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;
    // 锁定时计数清零，解锁后重新累计；过期的锁时间戳保留无妨（判断只看 locked_until > now）。
    await q("UPDATE member_access SET failed_count = $2, locked_until = COALESCE($3, locked_until) WHERE person_id = $1", [
      row.person_id,
      lockedUntil ? 0 : failures,
      lockedUntil,
    ]);
    return lockedUntil ? { kind: "locked", retryAfterSeconds: LOCK_MINUTES * 60 } : { kind: "invalid" };
  }
  const person = findPerson(row.person_id);
  if (!person) return { kind: "invalid" };
  if (row.failed_count > 0 || row.locked_until) {
    await q("UPDATE member_access SET failed_count = 0, locked_until = NULL WHERE person_id = $1", [row.person_id]);
  }
  return { kind: "verified", row, person };
}

/** 换成新口令：不再是初始码，凭据版本加一（其他设备上的旧会话随之失效）。返回新版本。 */
export async function changePasscode(q: Query, row: AccessRow, newPasscode: string): Promise<number> {
  const updated = await q(
    "UPDATE member_access SET passcode_hash = $2, must_change = FALSE, session_version = session_version + 1, updated_at = now() WHERE person_id = $1 RETURNING session_version",
    [row.person_id, hashSecret(newPasscode)],
  );
  return updated.rows[0].session_version as number;
}

export async function currentSessionVersion(q: Query, personId: string): Promise<number | null> {
  const row = (await q("SELECT session_version FROM member_access WHERE person_id = $1", [personId])).rows[0];
  return row ? (row.session_version as number) : null;
}
