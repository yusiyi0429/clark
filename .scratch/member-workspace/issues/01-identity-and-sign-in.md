# 第 1 步：身份与登录 · 实施计划

Type: implementation
Status: resolved

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个人用「登录 ID + 4 位口令」以自己的身份进入天枢。CEO 进 CEO 工作台，成员进 `/me`；成员进不去 CEO 页面，也调用不了 CEO 接口。

**Architecture:**
- 新表 `member_access` 保存凭据。签名 cookie 里只放 `{pid, v, exp}`；身份（ceo／member）每次按 company-people seed 现算。凭据版本 `v` 与库里的 `session_version` 比对，口令被重置后旧会话立即失效。
- API 两道闸门：`requirePerson`（任何有效会话，挂到 `req.person`）和 `requireCEO`（在 `requirePerson` 之上要求 CEO，成员一律 403）。
- 网页：`(ceo)` 路由组按会话身份跳转，新建 `(member)` 路由组 `/me`，锁屏改为「ID + 4 格口令」两阶段。

**Tech Stack:** Fastify 5 + TypeBox + pg（apps/api），Next 16 App Router + React 19 + HeroUI 3（apps/web），Vitest。

**Spec:** `.scratch/member-workspace/spec.md`（§2 身份、登录与部署；§4.1 锁屏；§4.2 成员工作台的外壳）

## Global Constraints

- 登录 ID 规则：姓全拼 + 名的首字母（`sun-mingze → sunm`），推不出或重名时手工指定。
- 口令：4 位数字，首次登录必须把初始码改成自己的，新口令不能与当前口令相同。
- 同一 ID 连续输错 5 次锁 15 分钟；每个 IP 的登录频率上限为 20 次／分钟。
- 会话有效期默认 30 天（`SESSION_MAX_AGE_SECONDS=2592000`）。
- 删除 CEO 长密码：`CEO_ACCESS_PASSWORD_HASH`、`ceoPasswordHash`、`hash-password` 脚本全部移除。
- 出错文案：「ID 或口令不对」「已连续输错 5 次，请 N 分钟后再试」「新口令不能和当前口令相同」「两次输入的口令不一致」。
- DRI 服务令牌与 MCP 令牌的检查不动。
- 不提交 git（用户未要求）。每个任务结束时跑对应检查，作为检查点。
- 文件改动遵守仓库 CRLF 现状：用编辑工具改，不用会改换行的脚本。
- API 测试需要 `TEST_PG_URL` 指向的 Postgres。本地已起 `tianshu-test-pg`（`postgres://postgres:postgres@localhost:54329/postgres`，即默认值）。全量跑用 `npx vitest run --maxWorkers=3 --minWorkers=1`，避免 OOM。
- API 基线：修改前已有 28 个失败用例（Windows 下的材料解析、bash 备份脚本、EXDEV），清单在 scratchpad 的 `api-baseline-failures.txt`。验收标准是「不新增失败」。

---

### Task 1: 契约——登录请求、改口令、会话响应

**Files:**
- Modify: `packages/contracts/src/auth.ts`（整文件替换）
- Modify: `packages/contracts/src/openapi.ts`：import 列表、`/api/auth/login` 路径、新增 `/api/auth/passcode`、components
- Modify: `packages/contracts/test/contract.test.ts`：路径清单加 `/api/auth/passcode`
- Regenerate: `apps/web/src/lib/api/openapi.json`、`apps/web/src/lib/api/schema.d.ts`（`gen:client`，不手改）

**Interfaces:**
- Produces:
  - `LoginRequest {loginId, passcode}`
  - `ChangePasscodeRequest {loginId, passcode, newPasscode}`
  - `LoginResponse {authenticated, mustChangePasscode, role?}`
  - `SessionResponse {authenticated, personId?, displayName?, role?}`
  - `SessionRole = "ceo" | "member"`
  - 类型 `TLoginRequest`、`TChangePasscodeRequest`、`TLoginResponse`、`TSessionResponse`、`TSessionRole`

- [ ] **Step 1: 先改契约测试（失败）**

在 `packages/contracts/test/contract.test.ts` 的 `"exposes the public API surface"` 路径清单里，`"/api/auth/session",` 后加一行 `"/api/auth/passcode",`。在 `"publishes card, action and error schemas as components"` 的清单里加 `"LoginResponse", "ChangePasscodeRequest",`。

- [ ] **Step 2: 跑契约测试确认失败**

Run: `pnpm --filter @warmap/contracts test`
Expected: FAIL，缺 `/api/auth/passcode` 与两个 component。

- [ ] **Step 3: 替换 `packages/contracts/src/auth.ts`**

```ts
import { Type, type Static } from "@sinclair/typebox";

/** 会话身份：按 company-people seed 判断，roles 含 ceo 的是 CEO，其余是成员。 */
export const SessionRole = Type.Union([Type.Literal("ceo"), Type.Literal("member")]);

const LoginId = Type.String({ minLength: 1, maxLength: 40 });
/** 4 位数字口令（初始码与自设口令同一格式）。 */
const Passcode = Type.String({ pattern: "^[0-9]{4}$" });

export const LoginRequest = Type.Object(
  { loginId: LoginId, passcode: Passcode },
  { additionalProperties: false },
);

/** 首次登录（或自己改口令）：先校验当前口令，再换成新口令并签发会话。 */
export const ChangePasscodeRequest = Type.Object(
  { loginId: LoginId, passcode: Passcode, newPasscode: Passcode },
  { additionalProperties: false },
);

/** 登录结果：仍是初始码时不签发会话，只告诉前端去设置自己的口令。 */
export const LoginResponse = Type.Object(
  { authenticated: Type.Boolean(), mustChangePasscode: Type.Boolean(), role: Type.Optional(SessionRole) },
  { additionalProperties: false },
);

export const SessionResponse = Type.Object(
  {
    authenticated: Type.Boolean(),
    personId: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
    role: Type.Optional(SessionRole),
  },
  { additionalProperties: false },
);

export type TSessionRole = Static<typeof SessionRole>;
export type TLoginRequest = Static<typeof LoginRequest>;
export type TChangePasscodeRequest = Static<typeof ChangePasscodeRequest>;
export type TLoginResponse = Static<typeof LoginResponse>;
export type TSessionResponse = Static<typeof SessionResponse>;
```

- [ ] **Step 4: 改 `packages/contracts/src/openapi.ts`**

1. import 列表中 `LoginRequest,` 后加 `LoginResponse,` 和 `ChangePasscodeRequest,`。
2. `"/api/auth/login"` 的 `post` 整段替换为：

```ts
        post: {
          operationId: "login",
          summary: "登录 ID + 4 位口令登录；仍是初始码时不签发会话，返回 mustChangePasscode",
          requestBody: jsonBody({ $ref: "#/components/schemas/LoginRequest" }),
          responses: {
            "200": {
              description: "已登录，或需要先设置口令",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } },
              },
            },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "423": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/auth/passcode": {
        post: {
          operationId: "changePasscode",
          summary: "校验当前口令后换成新的 4 位口令，并签发会话",
          requestBody: jsonBody({ $ref: "#/components/schemas/ChangePasscodeRequest" }),
          responses: {
            "200": {
              description: "口令已更新并登录",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } },
              },
            },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "423": errorResponse,
            "429": errorResponse,
          },
        },
```

   注意括号：原来 `"/api/auth/login": { post: {...} },` 的外层 `}` 由上面片段中 `},` 之后的 `"/api/auth/passcode": {` 接上。替换后确认 `"/api/auth/logout"` 仍是 `paths` 的直接子键。

3. `"/api/auth/session"` 的 `summary` 改为 `"查询当前登录状态与身份"`。
4. components 里 `LoginRequest: LoginRequest as JsonSchema,` 后加：

```ts
        LoginResponse: LoginResponse as JsonSchema,
        ChangePasscodeRequest: ChangePasscodeRequest as JsonSchema,
```

- [ ] **Step 5: 跑契约测试确认通过，并重新生成网页客户端**

Run: `pnpm --filter @warmap/contracts test && pnpm --filter @warmap/web gen:client`
Expected: 契约测试 PASS；`apps/web/src/lib/api/schema.d.ts` 出现 `changePasscode`、`LoginResponse`。

---

### Task 2: API 凭据存储——迁移、会话令牌、`memberAccess.ts`

**Files:**
- Create: `apps/api/migrations/023_member_access.sql`
- Modify: `apps/api/src/session.ts`（整文件替换）
- Create: `apps/api/src/memberAccess.ts`
- Modify: `apps/api/src/companyMemory.ts:65`：`function loadPeople` 改为 `export function loadPeople`
- Modify: `apps/api/test/migrate.test.ts`：迁移清单末尾加 `"023_member_access.sql",`
- Create: `apps/api/test/memberAccess.test.ts`

**Interfaces:**
- Consumes: `Query`（`apps/api/src/meetingStore.ts:17`），`MemoryPerson`（`apps/api/src/companyMemory.ts:13`）
- Produces:
  - `session.ts`：
    - `SESSION_COOKIE`
    - `type SessionClaims = { pid: string; v: number }`
    - `hashSecret(secret): string`、`verifySecret(stored, secret): boolean`
    - `createSessionToken(secret, maxAgeSeconds, claims): string`
    - `readSessionToken(secret, token?): SessionClaims | null`
    - `sessionSetCookie(secret, maxAgeSeconds, claims): string`
    - `sessionClearCookie(): string`
    - `parseCookies(header?): Record<string,string>`
  - `memberAccess.ts`：
    - `type SessionRole = "ceo" | "member"`
    - `LOCK_AFTER_FAILURES = 5`、`LOCK_MINUTES = 15`
    - `loginIdFor(personId): string | null`
    - `randomInitialPasscode(): string`
    - `roleOf(person): SessionRole`
    - `type AccessRow`
    - `setMemberAccess(q, {personId, loginId, passcode, mustChange}): Promise<void>`
    - `verifyCredentials(q, findPerson, loginId, passcode, now): Promise<Verified | Rejected>`
    - `changePasscode(q, row, newPasscode): Promise<number>`
    - `currentSessionVersion(q, personId): Promise<number | null>`

- [ ] **Step 1: 写失败测试 `apps/api/test/memberAccess.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import {
  LOCK_AFTER_FAILURES,
  changePasscode,
  currentSessionVersion,
  loginIdFor,
  randomInitialPasscode,
  setMemberAccess,
  verifyCredentials,
} from "../src/memberAccess.js";
import { createSessionToken, readSessionToken } from "../src/session.js";
import { createTestDb } from "./helpers.js";

const people = [
  { personId: "sun-mingze", displayName: "孙铭泽", roles: ["dri", "participant"] },
  { personId: "liu-minghua", displayName: "刘明华", roles: ["ceo", "dri"] },
];
const findPerson = (id: string) => people.find((p) => p.personId === id);
const at = (iso: string) => new Date(iso);

describe("登录 ID 与初始码", () => {
  it("姓全拼 + 名首字母；不是「姓-名」格式时交给管理员指定", () => {
    expect(loginIdFor("sun-mingze")).toBe("sunm");
    expect(loginIdFor("chen-xinan")).toBe("chenx");
    expect(loginIdFor("yu-siyi")).toBe("yus");
    expect(loginIdFor("person-fixture-001")).toBeNull();
  });

  it("初始码是 4 位数字，不出现弱码", () => {
    for (let i = 0; i < 200; i++) {
      const code = randomInitialPasscode();
      expect(code).toMatch(/^[0-9]{4}$/);
      expect(["0000", "1111", "1234", "4321"]).not.toContain(code);
    }
  });
});

describe("会话令牌", () => {
  it("只带 pid 与凭据版本；过期、篡改、旧格式都读不出来", () => {
    const token = createSessionToken("s", 60, { pid: "sun-mingze", v: 3 });
    expect(readSessionToken("s", token)).toEqual({ pid: "sun-mingze", v: 3 });
    expect(readSessionToken("s", createSessionToken("s", -1, { pid: "sun-mingze", v: 3 }))).toBeNull();
    expect(readSessionToken("s", `${token.slice(0, -2)}xx`)).toBeNull();
    expect(readSessionToken("other", token)).toBeNull();
    const legacy = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    expect(readSessionToken("s", `${legacy}.bad`)).toBeNull();
  });
});

describe("凭据校验与锁定", () => {
  it("正确口令通过；ID 不存在与口令错误一样是 invalid；ID 不分大小写", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: true });
      const ok = await verifyCredentials(q, findPerson, " SunM ", "2580", at("2026-09-24T02:00:00Z"));
      expect(ok).toMatchObject({ kind: "verified", row: { must_change: true, login_id: "sunm" }, person: { personId: "sun-mingze" } });
      expect(await verifyCredentials(q, findPerson, "nobody", "2580", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
      expect(await verifyCredentials(q, findPerson, "sunm", "1111", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
    });
  });

  it("连续输错 5 次锁 15 分钟，锁定期间正确口令也不放行，到期后可以再登录", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: false });
      const t0 = at("2026-09-24T02:00:00Z");
      for (let i = 1; i < LOCK_AFTER_FAILURES; i++) {
        expect(await verifyCredentials(q, findPerson, "sunm", "0001", t0)).toEqual({ kind: "invalid" });
      }
      expect(await verifyCredentials(q, findPerson, "sunm", "0001", t0)).toEqual({ kind: "locked", retryAfterSeconds: 900 });
      expect(await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:10:00Z"))).toEqual({ kind: "locked", retryAfterSeconds: 300 });
      expect(await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:15:01Z"))).toMatchObject({ kind: "verified" });
    });
  });

  it("seed 里已删除的人即使有凭据也进不来", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "gone-person", loginId: "goneo", passcode: "2580", mustChange: false });
      expect(await verifyCredentials(q, findPerson, "goneo", "2580", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
    });
  });

  it("改口令与重置都让凭据版本加一（旧会话失效）", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: true });
      expect(await currentSessionVersion(q, "sun-mingze")).toBe(1);
      const verified = await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:00:00Z"));
      if (verified.kind !== "verified") throw new Error("expected verified");
      expect(await changePasscode(q, verified.row, "7391")).toBe(2);
      expect(await verifyCredentials(q, findPerson, "sunm", "7391", at("2026-09-24T02:00:00Z"))).toMatchObject({ kind: "verified", row: { must_change: false } });
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "4826", mustChange: true });
      expect(await currentSessionVersion(q, "sun-mingze")).toBe(3);
      expect(await currentSessionVersion(q, "nobody")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/memberAccess.test.ts`
Expected: FAIL，`../src/memberAccess.js` 不存在。

- [ ] **Step 3: 写迁移 `apps/api/migrations/023_member_access.sql`**

```sql
-- 成员登录凭据：登录 ID + 4 位口令（scrypt 散列）。person_id 对应 company-people seed，不建外键（seed 在文件里）。
-- session_version：改口令或管理员重置时加一，签在会话里的旧版本随即失效。
CREATE TABLE member_access (
  person_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE CHECK (login_id ~ '^[a-z]{2,20}$'),
  passcode_hash TEXT NOT NULL,
  must_change BOOLEAN NOT NULL DEFAULT TRUE,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until TIMESTAMPTZ,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

并在 `apps/api/test/migrate.test.ts` 的清单末尾（`"022_mission_period_check.sql",` 之后）加 `"023_member_access.sql",`。

- [ ] **Step 4: 替换 `apps/api/src/session.ts`**

```ts
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "warmap_session";

/** 会话里只放「是谁」与凭据版本；身份（CEO／成员）每次按 seed 现算，版本对不上即视为已登出。 */
export type SessionClaims = { pid: string; v: number };

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 随机盐 scrypt 散列，格式 `scrypt:salt:hash`。 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(secret, salt, 32).toString("hex")}`;
}

/** 校验 `scrypt:salt:hash`，constant-time 比较。 */
export function verifySecret(stored: string, secret: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  return safeEqual(scryptSync(secret, salt, 32).toString("hex"), hash);
}

export function createSessionToken(secret: string, maxAgeSeconds: number, claims: SessionClaims): string {
  const payload = Buffer.from(
    JSON.stringify({ pid: claims.pid, v: claims.v, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds }),
  ).toString("base64url");
  return `${payload}.${hmac(secret, payload)}`;
}

/** 签名、有效期与字段齐全才返回；旧格式（只有 exp）一律视为未登录。 */
export function readSessionToken(secret: string, token: string | undefined): SessionClaims | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(hmac(secret, payload), sig)) return null;
  try {
    const { pid, v, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    if (typeof pid !== "string" || !pid || !Number.isInteger(v) || typeof exp !== "number") return null;
    return exp > Math.floor(Date.now() / 1000) ? { pid, v: v as number } : null;
  } catch {
    return null;
  }
}

export function sessionSetCookie(secret: string, maxAgeSeconds: number, claims: SessionClaims): string {
  // Secure：浏览器把 localhost/127.0.0.1 视为安全上下文，本地 http 调试也能写入；线上由 Nginx 终止 TLS。
  return `${SESSION_COOKIE}=${createSessionToken(secret, maxAgeSeconds, claims)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}
```

- [ ] **Step 5: 新建 `apps/api/src/memberAccess.ts`**

```ts
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
```

说明：错误计数用 `COALESCE($3, locked_until)` 保留过期锁的时间戳，不影响判断（判断只看 `locked_until > now`）；锁定时计数清零，解锁后重新累计 5 次。

- [ ] **Step 6: `loadPeople` 改为导出**

`apps/api/src/companyMemory.ts:65`：`function loadPeople(seedPath: string): MemoryPerson[] {` 改为 `export function loadPeople(seedPath: string): MemoryPerson[] {`。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/memberAccess.test.ts test/migrate.test.ts`
Expected: PASS。`apps/api` 的 `tsc --noEmit` 此时会因 `routes/auth.ts`、`routes/shared.ts` 仍引用旧的 `verifySessionToken`／`verifyPassword` 报错，Task 3 修复。

---

### Task 3: API 登录路由与两道闸门，迁移现有测试

**Files:**
- Modify: `apps/api/src/routes/shared.ts`：import、新增 `SessionPerson` 与 request 扩展、`createReadSession`、`createRequirePerson`，改 `createRequireCEO`，`RouteContext` 加字段
- Modify: `apps/api/src/routes/auth.ts`（整文件替换）
- Modify: `apps/api/src/app.ts`：`AppEnv` 删 `ceoPasswordHash`；`decorateRequest`；装配 `readSession`／`requirePerson`／`requireCEO`
- Modify: `apps/api/src/server.ts:29-30`：删 `ceoPasswordHash`，`SESSION_MAX_AGE_SECONDS` 默认 `"2592000"`
- Modify: `apps/api/test/helpers.ts`：`testEnv`、`TEST_PASSWORD` → `TEST_LOGIN`、`seedTestAccess`、`createTestApp` 播种、`memberCookie`
- Modify: 直接调用登录的测试 `issues.test.ts`、`issueDecision.test.ts`、`radar.test.ts`、`meetings.test.ts`、`monthlyPlan.test.ts`、`journey.test.ts`、`observabilitySecurity.test.ts`
- Create: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 契约；Task 2 的 `verifyCredentials`、`changePasscode`、`roleOf`、`currentSessionVersion`、`readSessionToken`、`sessionSetCookie`
- Produces:
  - `RouteContext.requirePerson: Guard`、`RouteContext.requireCEO: Guard`、`RouteContext.readSession: (req) => Promise<SessionPerson | null>`
  - `type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>`
  - `type SessionPerson = { personId: string; role: SessionRole }`
  - `FastifyRequest.person: SessionPerson | null`
  - 测试 helpers：`TEST_CEO`、`TEST_MEMBER`、`TEST_LOGIN`、`seedTestAccess(q)`、`TestApp.memberCookie()`

- [ ] **Step 1: 写失败测试 `apps/api/test/auth.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { setMemberAccess } from "../src/memberAccess.js";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";

const cookieOf = (setCookie: unknown) => String(setCookie).split(";")[0];

describe("登录 ID + 4 位口令", () => {
  it("初始码登录不发会话，改口令后才登录；新口令不能与初始码相同", async () => {
    const t = await createTestApp();
    try {
      const q = (text: string, params?: unknown[]) => t.sql(text, params).then((rows) => ({ rows, rowCount: rows.length }) as never);
      await setMemberAccess(q, { personId: TEST_MEMBER.personId, loginId: TEST_MEMBER.loginId, passcode: "4826", mustChange: true });
      const headers = { origin: t.publicOrigin };

      const first = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826" } });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ authenticated: false, mustChangePasscode: true });
      expect(first.headers["set-cookie"]).toBeUndefined();

      const same = await t.app.inject({ method: "POST", url: "/api/auth/passcode", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826", newPasscode: "4826" } });
      expect(same.statusCode).toBe(400);
      expect(same.json()).toMatchObject({ code: "PASSCODE_UNCHANGED", message: "新口令不能和当前口令相同" });

      const changed = await t.app.inject({ method: "POST", url: "/api/auth/passcode", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826", newPasscode: "7391" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ authenticated: true, mustChangePasscode: false, role: "member" });

      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: cookieOf(changed.headers["set-cookie"]) } });
      expect(session.json()).toEqual({ authenticated: true, personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member" });
    } finally {
      await t.close();
    }
  });

  it("ID 不存在与口令错误同一句话；连错 5 次返回 423 与分钟数", async () => {
    const t = await createTestApp();
    try {
      const headers = { origin: t.publicOrigin };
      const unknown = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: "nobody", passcode: "1357" } });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toMatchObject({ code: "INVALID_CREDENTIALS", message: "ID 或口令不对" });
      for (let i = 0; i < 4; i++) {
        const wrong = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "0001" } });
        expect(wrong.statusCode).toBe(401);
      }
      const locked = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "0001" } });
      expect(locked.statusCode).toBe(423);
      expect(locked.headers["retry-after"]).toBe("900");
      expect(locked.json()).toMatchObject({ code: "ACCOUNT_LOCKED", message: "已连续输错 5 次，请 15 分钟后再试" });
    } finally {
      await t.close();
    }
  });

  it("成员会话调用 CEO 接口得到 403（不是 401），CEO 照常", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const denied = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: member } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
      const ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: ceo } })).statusCode).toBe(200);
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: ceo } });
      expect(session.json()).toMatchObject({ authenticated: true, personId: TEST_CEO.personId, role: "ceo" });
    } finally {
      await t.close();
    }
  });

  it("管理员重置后旧会话立即失效", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const q = (text: string, params?: unknown[]) => t.sql(text, params).then((rows) => ({ rows, rowCount: rows.length }) as never);
      await setMemberAccess(q, { personId: TEST_MEMBER.personId, loginId: TEST_MEMBER.loginId, passcode: "9173", mustChange: true });
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: member } });
      expect(session.json()).toEqual({ authenticated: false });
    } finally {
      await t.close();
    }
  });

  it("成员也能退出登录", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: t.publicOrigin, cookie: member } });
      expect(out.statusCode).toBe(200);
      expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/auth.test.ts`
Expected: FAIL（helpers 里没有 `TEST_CEO`／`memberCookie`，路由仍是旧的密码登录）。

- [ ] **Step 3: 改 `apps/api/src/routes/shared.ts`**

1. 把 `import { SESSION_COOKIE, parseCookies, verifySessionToken } from "../session.js";` 替换为：

```ts
import { SESSION_COOKIE, parseCookies, readSessionToken } from "../session.js";
import { currentSessionVersion, roleOf, type SessionRole } from "../memberAccess.js";
```

2. 在 `export type RequestContext = ...` 之前加：

```ts
/** 已登录的人：身份按 seed 现算（CEO／成员），不信任会话里自带的角色。 */
export type SessionPerson = { personId: string; role: SessionRole };

declare module "fastify" {
  interface FastifyRequest {
    /** requirePerson / requireCEO 通过后挂上当前的人；未经闸门的路由为 null。 */
    person: SessionPerson | null;
  }
}

/** preHandler 闸门：放行时不返回，拒绝时返回已发送的 reply。 */
export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;
```

3. `RouteContext` 里把 `requireCEO: (req: FastifyRequest, reply: FastifyReply, done: () => void) => void;` 替换为：

```ts
  requireCEO: Guard;
  requirePerson: Guard;
  readSession: (req: FastifyRequest) => Promise<SessionPerson | null>;
```

4. 把整个 `createRequireCEO` 函数（`/** CEO 浏览器写请求边界…` 起到函数结束）替换为：

```ts
/** 读会话：签名与有效期之外，人要还在 seed 里，凭据版本要与库里一致（口令重置后旧会话立即失效）。 */
export function createReadSession(env: AppEnv, q: Query, companyMemory: CompanyMemoryRepository) {
  return async function readSession(req: FastifyRequest): Promise<SessionPerson | null> {
    const claims = readSessionToken(env.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!claims) return null;
    const person = companyMemory.searchPeople(undefined).find((p) => p.personId === claims.pid);
    if (!person) return null;
    return (await currentSessionVersion(q, person.personId)) === claims.v ? { personId: person.personId, role: roleOf(person) } : null;
  };
}

/** 浏览器请求边界：有效会话 + 写请求同源 Origin（CSRF）。 */
export function createRequirePerson(env: AppEnv, readSession: RouteContext["readSession"], fail: RouteContext["fail"]): Guard {
  return async function requirePerson(req, reply) {
    const person = await readSession(req);
    if (!person) return fail(reply, 401, "UNAUTHORIZED", "未登录");
    if (req.method !== "GET" && req.headers.origin !== env.publicOrigin) return fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
    req.person = person;
  };
}

/** CEO 专用：成员会话一律 403（不是 401，前端据此不回锁屏）。 */
export function createRequireCEO(requirePerson: Guard, fail: RouteContext["fail"]): Guard {
  return async function requireCEO(req, reply) {
    const denied = await requirePerson(req, reply);
    if (denied) return denied;
    if (req.person?.role !== "ceo") return fail(reply, 403, "FORBIDDEN", "只有 CEO 可以访问");
  };
}
```

`CompanyMemoryRepository` 与 `Query` 已在该文件顶部以 type 导入。

- [ ] **Step 4: 替换 `apps/api/src/routes/auth.ts`**

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { ChangePasscodeRequest, LoginRequest, LoginResponse, SessionResponse, type TLoginResponse, type TSessionRole } from "@warmap/contracts";
import { LOCK_AFTER_FAILURES, changePasscode, roleOf, verifyCredentials, type Rejected } from "../memberAccess.js";
import { sessionClearCookie, sessionSetCookie } from "../session.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerAuthRoutes(app: AppInstance, ctx: RouteContext): void {
  const { env, q, fail, requirePerson, readSession, now, companyMemory } = ctx;
  const findPerson = (personId: string) => companyMemory.searchPeople(undefined).find((p) => p.personId === personId);
  // 按 IP 的频率上限只挡刷接口；防猜口令靠按 ID 锁定（办公室共用出口 IP 时不互相误伤）。
  const perIp = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  function sameOrigin(req: FastifyRequest, reply: FastifyReply, done: () => void) {
    if (req.headers.origin !== env.publicOrigin) {
      fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
      return;
    }
    done();
  }

  function rejected(reply: FastifyReply, outcome: Rejected) {
    if (outcome.kind === "locked") {
      reply.header("retry-after", String(outcome.retryAfterSeconds));
      return fail(reply, 423, "ACCOUNT_LOCKED", `已连续输错 ${LOCK_AFTER_FAILURES} 次，请 ${Math.ceil(outcome.retryAfterSeconds / 60)} 分钟后再试`);
    }
    return fail(reply, 401, "INVALID_CREDENTIALS", "ID 或口令不对");
  }

  function signIn(reply: FastifyReply, personId: string, version: number, role: TSessionRole): TLoginResponse {
    reply.header("set-cookie", sessionSetCookie(env.sessionSecret, env.sessionMaxAgeSeconds, { pid: personId, v: version }));
    return { authenticated: true, mustChangePasscode: false, role };
  }

  app.post(
    "/api/auth/login",
    { preHandler: sameOrigin, config: perIp, schema: { body: LoginRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const outcome = await verifyCredentials(q, findPerson, req.body.loginId, req.body.passcode, now());
      if (outcome.kind !== "verified") return rejected(reply, outcome);
      if (outcome.row.must_change) return { authenticated: false, mustChangePasscode: true };
      return signIn(reply, outcome.person.personId, outcome.row.session_version, roleOf(outcome.person));
    },
  );

  app.post(
    "/api/auth/passcode",
    { preHandler: sameOrigin, config: perIp, schema: { body: ChangePasscodeRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const outcome = await verifyCredentials(q, findPerson, req.body.loginId, req.body.passcode, now());
      if (outcome.kind !== "verified") return rejected(reply, outcome);
      if (req.body.newPasscode === req.body.passcode) return fail(reply, 400, "PASSCODE_UNCHANGED", "新口令不能和当前口令相同");
      const version = await changePasscode(q, outcome.row, req.body.newPasscode);
      return signIn(reply, outcome.person.personId, version, roleOf(outcome.person));
    },
  );

  app.post("/api/auth/logout", { preHandler: requirePerson }, async (_req, reply) => {
    reply.header("set-cookie", sessionClearCookie());
    return { authenticated: false };
  });

  app.get("/api/auth/session", { schema: { response: { 200: SessionResponse } } }, async (req) => {
    const person = await readSession(req);
    if (!person) return { authenticated: false };
    return { authenticated: true, personId: person.personId, displayName: findPerson(person.personId)?.displayName ?? person.personId, role: person.role };
  });
}
```

- [ ] **Step 5: 改 `apps/api/src/app.ts` 与 `server.ts`**

1. `AppEnv` 删除 `ceoPasswordHash: string;` 一行。
2. import `createRequireCEO` 的那一行加上 `createReadSession, createRequirePerson`（与 `createRequireCEO` 同一 import 块，来自 `./routes/shared.js`）。
3. 把 `const requireCEO = createRequireCEO(env, fail);` 替换为：

```ts
  const readSession = createReadSession(env, q, companyMemory);
  const requirePerson = createRequirePerson(env, readSession, fail);
  const requireCEO = createRequireCEO(requirePerson, fail);
```

4. 在 `await app.register(rateLimit, { global: false });` 之前加：`app.decorateRequest("person", null);`
5. `ctx` 对象里 `requireCEO,` 后加 `requirePerson,` 与 `readSession,`。
6. `apps/api/src/server.ts`：删除 `ceoPasswordHash: requiredEnv("CEO_ACCESS_PASSWORD_HASH"),`；`sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS ?? "28800"),` 改为 `?? "2592000"`。

- [ ] **Step 6: 改 `apps/api/test/helpers.ts`**

1. 顶部 import 加：`import { hashSecret } from "../src/session.js";`；删除 `scryptSync` 的 import（改为 `import { randomUUID } from "node:crypto";`），并删除 `scryptHash` 导出。先用 `grep -rn "scryptHash" apps/api/test` 确认除 helpers 外无人使用；有人用则保留。
2. `testEnv` 删除 `ceoPasswordHash: scryptHash("ceo-pass-2024"),`。
3. 把 `export const TEST_PASSWORD = "ceo-pass-2024";` 替换为：

```ts
/** fixture seed：person-fixture-001 是 CEO，002 是成员。测试凭据已跳过首次改口令。 */
export const TEST_CEO = { personId: "person-fixture-001", loginId: "ceshij", passcode: "2468" } as const;
export const TEST_MEMBER = { personId: "person-fixture-002", loginId: "ceshiy", passcode: "1357" } as const;
export const TEST_LOGIN = { loginId: TEST_CEO.loginId, passcode: TEST_CEO.passcode };

/** 给一次性测试库写入两份测试凭据；已存在就不动（不让已签发的会话失效）。 */
export async function seedTestAccess(q: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  for (const who of [TEST_CEO, TEST_MEMBER]) {
    await q.query(
      "INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
      [who.personId, who.loginId, hashSecret(who.passcode)],
    );
  }
}
```

4. `TestApp` 类型里 `loginCookie: () => Promise<string>;` 后加 `memberCookie: () => Promise<string>;`。
5. `createTestApp` 中 `await migrate(client);` 之后加 `await seedTestAccess(client);`。
6. `loginCookie` 实现替换为下面两个方法，放在返回对象里：

```ts
    loginCookie: () => loginAs(app, TEST_CEO),
    memberCookie: () => loginAs(app, TEST_MEMBER),
```

并在文件内（`createTestApp` 之前）加：

```ts
async function loginAs(app: FastifyInstance, who: { loginId: string; passcode: string }): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: { loginId: who.loginId, passcode: who.passcode },
  });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return (login.headers["set-cookie"] as string).split(";")[0];
}
```

- [ ] **Step 7: 迁移直接调用登录的测试**

1. `issues.test.ts`、`issueDecision.test.ts`、`radar.test.ts`：
   - import 里的 `TEST_PASSWORD` 换成 `TEST_LOGIN, seedTestAccess`。
   - 本地 `login(app)` 改为：

```ts
async function login(app: Awaited<ReturnType<typeof buildApp>>, db: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<string> {
  await seedTestAccess(db);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: TEST_LOGIN,
  });
  return (response.headers["set-cookie"] as string).split(";")[0];
}
```

   - 所有调用处 `login(app)` → `login(app, db)`（`grep -n "login(app)" <file>` 逐个核对：调用处都在 `createTestDb(async ({ db ... }) => …)` 回调里，`db` 可用；若某处的库变量名不同，用那处的名字）。
2. `meetings.test.ts:1021` 附近与 `monthlyPlan.test.ts:628` 附近：
   - 在 inject 登录前加 `await seedTestAccess(db);`。
   - `payload: { password: TEST_PASSWORD }` 改为 `payload: TEST_LOGIN`。
   - import 同样替换。
3. `journey.test.ts`：
   - import `TEST_PASSWORD` 换成 `TEST_LOGIN, TEST_CEO`。
   - 错误口令用例：`payload: { password: "wrong" }` → `payload: { loginId: TEST_CEO.loginId, passcode: "0000" }`。
   - 其余 `payload: { password: TEST_PASSWORD }` → `payload: TEST_LOGIN`。
   - `Value.Check(SessionResponse, login.json())` 改为 `Value.Check(LoginResponse, login.json())`（从 `@warmap/contracts` import `LoginResponse`）。
   - `expect(session.json()).toEqual({ authenticated: true });` 改为 `expect(session.json()).toEqual({ authenticated: true, personId: TEST_CEO.personId, displayName: "测试甲", role: "ceo" });`。
   - 「rate limits login attempts per IP」改为：循环 20 次用 `payload: { loginId: \`nobody${i}\`, passcode: "0000" }` 各得 401，第 21 次 `payload: TEST_LOGIN` 得 429。
4. `observabilitySecurity.test.ts`：
   - `createSessionToken(testEnv.sessionSecret, -1)` → `createSessionToken(testEnv.sessionSecret, -1, { pid: TEST_CEO.personId, v: 1 })`；3600 那行同理。
   - 错误登录 `payload: { password: "wrong" }` → `payload: { loginId: TEST_CEO.loginId, passcode: "0000" }`。
   - import `TEST_CEO`。
   - 检查日志断言里是否有针对 `password` 字段的脱敏断言；有就把字段名改为 `passcode`，并确认日志脱敏规则覆盖 `passcode`（`grep -rn "password" apps/api/src/observability.ts`，若脱敏列表只含 `password`，在同一列表里加 `passcode` 与 `newPasscode`）。

- [ ] **Step 8: 跑类型检查、新测试与全量 API 测试**

Run:

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit && npx vitest run test/auth.test.ts test/memberAccess.test.ts test/journey.test.ts test/observabilitySecurity.test.ts
cd apps/api && npx vitest run --maxWorkers=3 --minWorkers=1
```

Expected:
- tsc 无错；指定的 4 个文件全部 PASS。
- 全量失败数不超过基线 28，失败清单与 `api-baseline-failures.txt` 一致，没有新增。

---

### Task 4: 发码脚本，去掉 CEO 长密码配置

**Files:**
- Create: `apps/api/scripts/issue-access.ts`
- Delete: `apps/api/scripts/hash-password.mjs`
- Modify: `apps/api/package.json`：scripts 里 `"hash-password": "node scripts/hash-password.mjs"` 换成 `"access:issue": "tsx scripts/issue-access.ts"`
- Modify: `.env.example`：删除 `CEO_ACCESS_PASSWORD_HASH=` 及其注释；`SESSION_MAX_AGE_SECONDS=28800` 改为 `2592000`，注释写「30 天」
- Modify: `infra/docker-compose.yml`：删除 `CEO_ACCESS_PASSWORD_HASH: ...` 一行；`SESSION_MAX_AGE_SECONDS: ${SESSION_MAX_AGE_SECONDS:-28800}` 改为 `:-2592000`
- Modify: `apps/api/test/deployment.test.ts:40`：删除 `"CEO_ACCESS_PASSWORD_HASH=scrypt:a:b",`
- Modify: `infra/staging/smoke.sh`：登录改为 `CEO_LOGIN_ID` + `CEO_PASSCODE`
- Modify: `infra/staging/runbook.md`：部署顺序里加「首次上线后运行发码脚本」
- Modify: `apps/api/.env`（本地、不入库）：删除 `CEO_ACCESS_PASSWORD_HASH=` 一行

**Interfaces:**
- Consumes: `loadPeople`、`loginIdFor`、`randomInitialPasscode`、`roleOf`、`setMemberAccess`

- [ ] **Step 1: 写 `apps/api/scripts/issue-access.ts`**

```ts
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
```

- [ ] **Step 2: 改配置与部署测试**

按上面 Files 列表逐项修改。`smoke.sh` 中：
- 顶部注释 `CEO_PASSWORD（…）` 改为 `CEO_LOGIN_ID 与 CEO_PASSCODE（真实 CEO 的登录 ID 与 4 位口令，只从环境读取，不落盘）`。
- 校验行改为：

```bash
: "${CEO_LOGIN_ID:?smoke: 缺少 CEO_LOGIN_ID（真实 smoke 需要登录；缺失即 BLOCKED，不跳过）}"
: "${CEO_PASSCODE:?smoke: 缺少 CEO_PASSCODE}"
```

- 登录请求体改为 `--data "$(printf '{"loginId":"%s","passcode":"%s"}' "$CEO_LOGIN_ID" "$CEO_PASSCODE")"`。

`runbook.md` §1 第 3 条之后插入：

```markdown
   - 首次上线（或新增人员）后发初始码：`docker compose -f infra/docker-compose.yml --env-file infra/.env exec api pnpm access:issue`，把输出表格里的「ID / 初始码」私下发给每个人；首次登录会要求改成自己的 4 位口令。重置某人：`... access:issue <personId>`。
```

- [ ] **Step 3: 验证**

Run:

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit
grep -rn "CEO_ACCESS_PASSWORD_HASH\|ceoPasswordHash\|hash-password\|TEST_PASSWORD" --include=*.ts --include=*.mjs --include=*.json --include=*.yml --include=*.sh --include=*.example --include=*.md . | grep -v node_modules | grep -v "^./.scratch/member-workspace"
```

Expected: tsc 无错；grep 只剩 `docs/` 下的历史文档（不改历史 ADR 与技术文档）。

---

### Task 5: 网页会话与路由分流、成员工作台外壳

**Files:**
- Modify: `apps/web/src/lib/api/server.ts`：新增 `SessionInfo`、`readSession`、`requireMember`，改 `requireCeo`
- Modify: `apps/web/src/app/(ceo)/layout.tsx`
- Create: `apps/web/src/app/(member)/me/page.tsx`
- Create: `apps/web/src/components/member/MemberWorkspace.tsx`
- Create: `apps/web/src/styles/member-home.module.css`
- Modify: `apps/web/src/components/NotificationRail.tsx`：`RailClock` 改为导出，左侧按钮由 `lead` 传入
- Create: `apps/web/src/components/member/memberWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 1 生成的 `/api/auth/session` 类型
- Produces:
  - `readSession(cookie): Promise<SessionInfo | null>`
  - `requireCeo(targetPath): Promise<string>`（签名不变）
  - `requireMember(targetPath): Promise<{ cookie: string; session: SessionInfo }>`
  - `type SessionInfo = { personId: string; displayName: string; role: "ceo" | "member" }`
  - `RailClock({ lead, onHome?, homeActive })`
  - `MemberWorkspace({ displayName })`

- [ ] **Step 1: 写失败测试 `apps/web/src/components/member/memberWorkspace.test.tsx`**

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberWorkspace } from "./MemberWorkspace";

describe("成员工作台外壳", () => {
  it("写出是谁、左上角是退出登录，通知栏为空时说明", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-testid="member-workspace"');
    expect(html).toContain(">孙铭泽<");
    expect(html).toContain('aria-label="退出登录"');
    expect(html).toContain("暂时没有新通知");
    expect(html).not.toContain('aria-label="配置"');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/member/memberWorkspace.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: `RailClock` 改为导出并接受 `lead`**

在 `apps/web/src/components/NotificationRail.tsx`：

1. 函数签名替换为：

```tsx
/** 通知栏顶部：左边一颗功能键（CEO 是配置，成员是退出登录），右边天枢胶囊与时钟。 */
export function RailClock({ lead, onHome, homeActive }: { lead: React.ReactNode; onHome?: () => void; homeActive: boolean }) {
```

2. `<span className={n.railLock}>…</span>` 内部改为 `{lead}`。
3. 胶囊 `onPress={onHome}` 保持不变（`onHome` 可为 undefined）。
4. `NotificationRail` 里的调用改为：

```tsx
      <RailClock
        onHome={() => onHome?.()}
        homeActive={homeActive}
        lead={
          <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={() => onNavigate("/config")} aria-label="配置" title="配置">
            <Settings aria-hidden="true" />
          </HeroButton>
        }
      />
```

5. 文件顶部 import 加 `type ReactNode`，或直接写 `React.ReactNode`（该文件已有 `"use client"`；若 `React` 命名空间未导入，改用 `import type { ReactNode } from "react";` 并写 `lead: ReactNode`）。

- [ ] **Step 4: 新建 `apps/web/src/components/member/MemberWorkspace.tsx`**

```tsx
"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import s from "@/styles/app-shell.module.css";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

/**
 * 成员工作台（clark `/dri` 工作面的骨架）：左侧通知栏、主区是自己的事。
 * 第 1 步只有身份与退出；通知、发给我的信号与执行事项在后续步骤接入。
 */
export function MemberWorkspace({ displayName }: { displayName: string }) {
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.replace("/access");
  }

  return (
    <div className={s.shell} data-testid="member-workspace">
      <div className={s.mainArea}>
        <div className={s.homeSurface}>
          <section className={m.board} aria-labelledby="member-title">
            <h1 id="member-title">{displayName}</h1>
            <p>发给你的信号、你推进和参与的执行事项，都会出现在这里。</p>
          </section>
        </div>
      </div>
      <div className={s.notificationArea}>
        <aside className={n.rail} aria-label="通知">
          <RailClock
            homeActive
            lead={
              <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={() => void logout()} isDisabled={leaving} aria-label="退出登录" title="退出登录">
                <Lock aria-hidden="true" />
              </HeroButton>
            }
          />
          <p className={m.quiet}>暂时没有新通知</p>
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 新建 `apps/web/src/styles/member-home.module.css`**

```css
/* 成员工作台主区：与 CEO 首页同一套留白与字号（home-board），不另起风格。 */
.board {
  display: grid;
  gap: 8px;
  padding: 28px 28px 0;
}

.board h1 {
  margin: 0;
  color: var(--ts-text, #10213a);
  font-size: 28px;
  font-weight: 650;
  letter-spacing: 0;
}

.board p {
  margin: 0;
  color: var(--ts-text-muted, #5b6b82);
  font-size: 15px;
  line-height: 1.6;
}

.quiet {
  margin: 12px 16px;
  color: rgb(255 255 255 / 0.72);
  font-size: 13px;
}

@media (max-width: 690px) {
  .board {
    padding: 20px 16px 0;
  }
}
```

执行时对照 `home-board.module.css` 与 `notifications.module.css` 的实际 token 名（`var(--…)`），把上面的兜底色换成仓库里实际存在的变量。

- [ ] **Step 6: 改 `apps/web/src/lib/api/server.ts` 的会话守卫**

把原 `requireCeo` 整段替换为：

```ts
export type SessionInfo = { personId: string; displayName: string; role: "ceo" | "member" };

/** 读当前会话（服务端）：没有 cookie 不发请求；接口判定无效（过期、口令已重置）时返回 null。 */
export async function readSession(cookie: string): Promise<SessionInfo | null> {
  if (!cookie.includes(`${SESSION_COOKIE}=`)) return null;
  const { data, response } = await serverApi.GET("/api/auth/session", { headers: { cookie } });
  if (!response.ok || !data?.authenticated || !data.personId || !data.role) return null;
  return { personId: data.personId, displayName: data.displayName ?? data.personId, role: data.role };
}

const accessPath = (targetPath: string) => `/access?next=${encodeURIComponent(targetPath)}`;

/** CEO 页面守卫：未登录回锁屏（带 next）；成员登录的去自己的工作台。 */
export async function requireCeo(targetPath: string): Promise<string> {
  const cookie = (await cookies()).toString();
  const session = await readSession(cookie);
  if (!session) redirect(accessPath(targetPath));
  if (session.role !== "ceo") redirect("/me");
  return cookie;
}

/** 成员页面守卫：未登录回锁屏（带 next）；CEO 回自己的首页。 */
export async function requireMember(targetPath: string): Promise<{ cookie: string; session: SessionInfo }> {
  const cookie = (await cookies()).toString();
  const session = await readSession(cookie);
  if (!session) redirect(accessPath(targetPath));
  if (session.role !== "member") redirect("/");
  return { cookie, session };
}
```

`load()` 里 `if (response.status === 401) redirect("/access");` 保持不变；成员经 layout 与页面守卫已被分流，不会走到 CEO 查询。

- [ ] **Step 7: 改 `apps/web/src/app/(ceo)/layout.tsx`**

```tsx
import { cookies } from "next/headers";
import { CeoWorkspace } from "@/components/shell/CeoWorkspace";
import { loadHomeCards, readSession } from "@/lib/api/server";

/**
 * CEO 工作面：首页看板、通知栏与对话条常驻在这一层，对象页作为 children 在主区原地打开
 * （clark 同：总览 DOM 保留，关闭回到来源）。未登录或成员身份时交给各页面自己的 requireCeo 跳转（带上正确的 next）。
 */
export default async function CeoLayout({ children }: { children: React.ReactNode }) {
  const cookie = (await cookies()).toString();
  const session = await readSession(cookie);
  if (session?.role !== "ceo") return children;
  const { cards } = await loadHomeCards(cookie);
  return <CeoWorkspace initialCards={cards}>{children}</CeoWorkspace>;
}
```

- [ ] **Step 8: 新建 `apps/web/src/app/(member)/me/page.tsx`**

```tsx
import type { Metadata } from "next";
import { MemberWorkspace } from "@/components/member/MemberWorkspace";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

export default async function MemberHomePage() {
  const { session } = await requireMember("/me");
  return <MemberWorkspace displayName={session.displayName} />;
}
```

- [ ] **Step 9: 跑测试与类型检查**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS。原有 189 个测试加新增用例全部通过，tsc 无错。

---

### Task 6: 锁屏两阶段——ID + 4 格口令，首次设置口令

**Files:**
- Create: `apps/web/src/app/access/PinField.tsx`
- Modify: `apps/web/src/app/access/AccessScreen.tsx`（整文件替换）
- Modify: `apps/web/src/styles/access.module.css`：新增 `.idField`、`.setHint`
- Modify: `apps/web/src/app/access/access.test.tsx`

**Interfaces:**
- Consumes: Task 1 契约（`LoginResponse` 形状）；接口 `/api/auth/login`、`/api/auth/passcode`
- Produces:
  - `PinField({ ref, length?, label, disabled?, invalid?, autoFocus?, autoComplete?, describedBy?, onComplete })`
  - `type PinFieldHandle = { clear(): void; focus(): void; value(): string }`
  - `loginFailureCopy(status, serverMessage?)`
  - `landingPath(role, nextPath)`

- [ ] **Step 1: 改测试 `apps/web/src/app/access/access.test.tsx`（失败）**

把「锁屏表单」describe 替换为：

```tsx
describe("锁屏表单", () => {
  it("失败说明：ID 或口令不对；锁定与改口令用服务端原话；限流、来源不符、其他", () => {
    expect(loginFailureCopy(401)).toBe("ID 或口令不对");
    expect(loginFailureCopy(423, "已连续输错 5 次，请 15 分钟后再试")).toBe("已连续输错 5 次，请 15 分钟后再试");
    expect(loginFailureCopy(400, "新口令不能和当前口令相同")).toBe("新口令不能和当前口令相同");
    expect(loginFailureCopy(429)).toBe("尝试次数过多，请一分钟后再试");
    expect(loginFailureCopy(403)).toBe("请从正式访问地址打开天枢");
    expect(loginFailureCopy(500)).toBe("暂时无法验证");
  });

  it("登录后去哪：成员只去 /me 下的页面，CEO 从 /me 来的回首页", () => {
    expect(landingPath("member", "/")).toBe("/me");
    expect(landingPath("member", "/radar")).toBe("/me");
    expect(landingPath("member", "/me/tasks/1")).toBe("/me/tasks/1");
    expect(landingPath("ceo", "/")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/me")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/radar")).toBe("/radar");
  });

  it("一个 ID 输入框 + 4 格口令，没有身份滑块；时钟未挂载前占位不跳动", () => {
    const html = renderToStaticMarkup(<AccessScreen nextPath="/" />);
    expect(html).toContain('id="access-id"');
    expect(html).toContain("你的 ID");
    expect(html.match(/aria-label="口令第 \d 位"/g)).toHaveLength(4);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("--:--");
    expect(html).toContain("tianshu-flow-lock-v3.webp");
  });
});
```

import 行改为 `import { AccessScreen, landingPath, loginFailureCopy } from "./AccessScreen";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/app/access/access.test.tsx`
Expected: FAIL（`landingPath` 未导出；文案仍是「密码无效」）。

- [ ] **Step 3: 新建 `apps/web/src/app/access/PinField.tsx`（clark access-form 的数字格，改为可复用、长度可配）**

```tsx
"use client";

import { useImperativeHandle, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import a from "@/styles/access.module.css";

export type PinFieldHandle = { clear: () => void; focus: () => void; value: () => string };

/** 逐位数字格（clark `access-form` 的访问码格子）：输满自动回调，支持粘贴、左右键与退格回退；输入显示为圆点。 */
export function PinField({
  ref,
  length = 4,
  label,
  disabled,
  invalid,
  autoFocus,
  autoComplete = "off",
  describedBy,
  onComplete,
}: {
  ref?: Ref<PinFieldHandle>;
  length?: number;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  describedBy?: string;
  onComplete: (code: string) => void;
}) {
  const digits = useRef<string[]>(Array(length).fill(""));
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const focusAt = (index: number) => inputs.current[Math.max(0, Math.min(index, length - 1))]?.focus();
  const firstEmpty = () => {
    const index = digits.current.findIndex((digit) => !digit);
    return index === -1 ? length - 1 : index;
  };

  useImperativeHandle(ref, () => ({
    clear() {
      digits.current = Array(length).fill("");
      inputs.current.forEach((input) => {
        if (input) input.value = "";
      });
      requestAnimationFrame(() => focusAt(0));
    },
    focus: () => focusAt(firstEmpty()),
    value: () => digits.current.join(""),
  }));

  function apply(start: number, value: string) {
    const incoming = value.replace(/\D/g, "").slice(0, length - start);
    if (!incoming) return;
    const next = [...digits.current];
    incoming.split("").forEach((digit, offset) => {
      next[start + offset] = digit;
    });
    digits.current = next;
    next.forEach((digit, index) => {
      const input = inputs.current[index];
      if (input) input.value = digit;
    });
    window.setTimeout(() => focusAt(Math.min(start + incoming.length, length - 1)), 0);
    const code = next.join("");
    if (code.length === length) onComplete(code);
  }

  function onChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    if (event.target.value) {
      apply(index, event.target.value);
      return;
    }
    const next = [...digits.current];
    next[index] = "";
    digits.current = next;
  }

  function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/\d/.test(pasted)) return;
    event.preventDefault();
    apply(index, pasted);
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      apply(index, event.key);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "Backspace" && !digits.current[index] && index > 0) {
      event.preventDefault();
      const next = [...digits.current];
      next[index - 1] = "";
      digits.current = next;
      const previous = inputs.current[index - 1];
      if (previous) previous.value = "";
      focusAt(index - 1);
    }
  }

  return (
    <div className={`${a.codeField} ${invalid ? a.codeFieldError : ""}`} role="group" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(node) => {
            inputs.current[index] = node;
          }}
          aria-label={`${label}第 ${index + 1} 位`}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? autoComplete : "off"}
          autoFocus={autoFocus && index === 0}
          maxLength={1}
          defaultValue=""
          placeholder=" "
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(index, event)}
          onPaste={(event) => onPaste(index, event)}
          onKeyDown={(event) => onKeyDown(index, event)}
          className={a.codeCell}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 替换 `apps/web/src/app/access/AccessScreen.tsx`**

```tsx
"use client";

import { useRef, useState } from "react";
import { TianshuMark } from "@/components/TianshuMark";
import { LockscreenBackdrop, LockscreenClock } from "./LockscreenVisual";
import { PinField, type PinFieldHandle } from "./PinField";
import a from "@/styles/access.module.css";

type Role = "ceo" | "member";
type Stage = { kind: "login" } | { kind: "set"; loginId: string; passcode: string };

/** 登录接口的失败说明：只说发生了什么、接下来怎么办。锁定与改口令的原因由服务端给出原话。 */
export function loginFailureCopy(status: number, serverMessage?: string): string {
  if (status === 401) return "ID 或口令不对";
  if ((status === 423 || status === 400) && serverMessage) return serverMessage;
  if (status === 429) return "尝试次数过多，请一分钟后再试";
  if (status === 403) return "请从正式访问地址打开天枢";
  return "暂时无法验证";
}

/** 登录后去哪：成员只去 /me 下的页面；CEO 从 /me 来的回首页，回首页时带入场动画。 */
export function landingPath(role: Role, nextPath: string): string {
  const memberPath = nextPath === "/me" || nextPath.startsWith("/me/");
  if (role === "member") return memberPath ? nextPath : "/me";
  const target = memberPath ? "/" : nextPath;
  return target === "/" ? "/?_entry=unlock" : target;
}

function navigationDelay() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 40 : 520;
}

type Result = { ok: true; mustChangePasscode: boolean; role?: Role } | { ok: false; message: string };

async function post(url: string, body: Record<string, string>): Promise<Result> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as { mustChangePasscode?: boolean; role?: Role; message?: string } | null;
  if (response.ok) return { ok: true, mustChangePasscode: Boolean(data?.mustChangePasscode), role: data?.role };
  return { ok: false, message: loginFailureCopy(response.status, data?.message) };
}

/**
 * 锁屏（clark `access-screen.tsx` + `access-form.tsx`）：浅蓝壁纸、等高线与闪光、锁形时钟。
 * 天枢是「你的 ID + 4 位口令」：口令输满即提交；初始码登录后原地换成「设置你的 4 位口令」，输两遍。
 * 验证通过后解锁动画 520ms，再以 replace 进入（不留锁屏历史）。
 */
export function AccessScreen({ nextPath }: { nextPath: string }) {
  const [stage, setStage] = useState<Stage>({ kind: "login" });
  const [loginId, setLoginId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  const idInput = useRef<HTMLInputElement>(null);
  const pin = useRef<PinFieldHandle>(null);
  const newPin = useRef<PinFieldHandle>(null);
  const confirmPin = useRef<PinFieldHandle>(null);
  const chosen = useRef("");
  const inFlight = useRef(false);
  const busy = submitting || unlocking;

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setSubmitting(true);
    try {
      await task();
    } catch {
      setError("网络连接失败");
      (stage.kind === "login" ? pin : confirmPin).current?.clear();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function enter(role: Role) {
    setUnlocking(true);
    await new Promise((resolve) => window.setTimeout(resolve, navigationDelay()));
    window.location.replace(landingPath(role, nextPath));
  }

  const login = (passcode: string) =>
    run(async () => {
      const id = loginId.trim();
      if (!id) {
        setError("先输入你的 ID");
        pin.current?.clear();
        idInput.current?.focus();
        return;
      }
      const result = await post("/api/auth/login", { loginId: id, passcode });
      if (!result.ok) {
        setError(result.message);
        pin.current?.clear();
        return;
      }
      if (result.mustChangePasscode) {
        setStage({ kind: "set", loginId: id, passcode });
        return;
      }
      await enter(result.role ?? "member");
    });

  function choose(code: string) {
    chosen.current = code;
    setError("");
    confirmPin.current?.focus();
  }

  const confirm = (code: string) =>
    run(async () => {
      if (stage.kind !== "set") return;
      if (code !== chosen.current) {
        setError("两次输入的口令不一致");
        confirmPin.current?.clear();
        return;
      }
      const result = await post("/api/auth/passcode", { loginId: stage.loginId, passcode: stage.passcode, newPasscode: code });
      if (!result.ok) {
        setError(result.message);
        chosen.current = "";
        confirmPin.current?.clear();
        newPin.current?.clear();
        return;
      }
      await enter(result.role ?? "member");
    });

  return (
    <main className={a.shell} data-unlocking={unlocking}>
      <LockscreenBackdrop />

      <div className={a.brand} aria-label="天枢">
        <TianshuMark className={a.brandMark} />
        <span className={a.brandName}>天枢</span>
      </div>

      <section className={a.lockscreen} aria-labelledby="access-title">
        <h1 id="access-title" className={a.srOnly}>
          进入天枢
        </h1>

        <LockscreenClock />

        <form className={a.accessForm} onSubmit={(event) => event.preventDefault()} aria-busy={submitting}>
          {stage.kind === "login" ? (
            <>
              <div className={a.codeGroup}>
                <label className={a.codeLabel} htmlFor="access-id">
                  你的 ID
                </label>
                <div className={`${a.passwordField} ${a.idField}`}>
                  <input
                    ref={idInput}
                    id="access-id"
                    className={a.passwordInput}
                    type="text"
                    value={loginId}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    disabled={busy}
                    onChange={(event) => {
                      setLoginId(event.target.value);
                      if (error) setError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const code = pin.current?.value() ?? "";
                      if (code.length === 4) void login(code);
                      else pin.current?.focus();
                    }}
                  />
                </div>
              </div>
              <div className={a.codeGroup}>
                <p className={a.codeLabel}>4 位口令</p>
                <PinField
                  ref={pin}
                  label="口令"
                  autoComplete="current-password"
                  disabled={busy}
                  invalid={Boolean(error)}
                  describedBy={error ? "access-error" : undefined}
                  onComplete={(code) => void login(code)}
                />
              </div>
            </>
          ) : (
            <>
              <p className={a.setHint}>第一次登录，设置你自己的 4 位口令</p>
              <div className={a.codeGroup}>
                <p className={a.codeLabel}>新口令</p>
                <PinField ref={newPin} label="新口令" autoComplete="new-password" autoFocus disabled={busy} onComplete={choose} />
              </div>
              <div className={a.codeGroup}>
                <p className={a.codeLabel}>再输一遍</p>
                <PinField
                  ref={confirmPin}
                  label="确认口令"
                  autoComplete="new-password"
                  disabled={busy}
                  invalid={Boolean(error)}
                  describedBy={error ? "access-error" : undefined}
                  onComplete={(code) => void confirm(code)}
                />
              </div>
            </>
          )}
          <div className={a.errorSlot} aria-live="polite">
            {submitting ? <p className={a.verifying}>正在确认</p> : null}
            {error ? (
              <p id="access-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      </section>

      <footer className={a.panelFooter}>
        <span>天枢 · TKOS</span>
      </footer>

      <div className={a.unlockWash} aria-hidden="true" />
    </main>
  );
}
```

- [ ] **Step 5: 在 `apps/web/src/styles/access.module.css` 末尾加样式**

```css
/* ID 输入框复用口令框外观，但没有右侧进入键：内边距左右对称。 */
.idField .passwordInput {
  padding-inline: 16px;
  text-align: center;
  letter-spacing: 0.04em;
}

.setHint {
  margin: 0 0 4px;
  color: rgb(255 255 255 / 0.86);
  font-size: 14px;
  text-align: center;
}
```

执行时对照 `.passwordInput`（第 699 行）与 `.codeLabel`（第 241 行）的实际颜色和内边距调整数值，保证两个输入区上下对齐、在浅蓝壁纸上可读。

- [ ] **Step 6: 跑测试与类型检查**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS。

---

### Task 7: 本地落地、浏览器验收、文档

**Files:**
- Create: `docs/adr/0020-members-sign-in-and-own-execution-items.md`
- Modify: `CONTEXT.md`：新增「成员」「登录 ID」「执行事项」「事项群组」「发送（信号）」词条；修订「DRI」「CEO WarMap」的描述

- [ ] **Step 1: 重启本地 API 让迁移生效，给 9 人发码**

Run:
- `preview_stop` 当前 tianshu-api，再 `preview_start name=tianshu-api`（API 启动时会跑 `023_member_access.sql`）。
- 然后：

```bash
cd apps/api && pnpm exec tsx --env-file=.env scripts/issue-access.ts
```

Expected: 打印 9 行「姓名 / ID / 初始码 / 身份」，ID 为 lium、bait、liur、sunm、chenx、wangc、qinm、tangj、yus。把这张表交给用户（本地测试用），**不要**自己在锁屏里输入口令。

- [ ] **Step 2: 浏览器验收（口令由用户自己输入）**

- 锁屏（1100 与 390 两个宽度）：ID 框与 4 格口令对齐、在壁纸上可读；截图确认。
- 请用户用初始码登录一次 CEO（lium），在 `127.0.0.1:3100` 上操作：看到「设置你的 4 位口令」，设好后进入 CEO 首页，首页与雷达照常。
- 请用户在 `localhost:3100`（与 127.0.0.1 的 cookie 互相隔离）用一个成员 ID 登录：设好口令后进入 `/me`，看到自己的名字与「暂时没有新通知」。
- 成员直接访问 `localhost:3100/` 与 `localhost:3100/radar`：被带到 `/me`。
- CEO 访问 `127.0.0.1:3100/me`：被带回 `/`。
- 成员点左上角锁：回到锁屏；再访问 `/me` 回到锁屏且带 `next=/me`。
- 检查 `/me` 在 390 宽度下没有横向滚动，通知栏与主区不重叠；若 `.shell` 的 CEO 布局在成员页留下空白栏（例如对话区占位），在 `member-home.module.css` 里为 `[data-testid="member-workspace"]` 覆盖，不改 CEO 样式。

- [ ] **Step 3: 写 ADR 0020**

`docs/adr/0020-members-sign-in-and-own-execution-items.md`：

```markdown
# 成员以自己的身份登录，并拥有自己的执行事项

- 日期：2026-09-24
- 状态：已采纳
- 推翻：ADR-0001 中「单公司、单 CEO」「不承担任务执行」的部分；目标设计 v0.3 的非目标「项目管理和任务执行」「DRI 工作台或多人协作」，以及「/access 单 CEO 登录」「单 CEO MVP 不保存已读」。

天枢内测要让 CEO 把雷达信号发给具体的人、战场或业务域，收件人在自己的通知栏收到，并可以把它转成自己的执行事项，与相关同事在事项群组里讨论。这需要每个成员以自己的身份登录：登录 ID（姓全拼 + 名首字母）+ 自设的 4 位数字口令，初始码由管理员脚本发放，首次登录必须修改；连续输错 5 次锁 15 分钟。CEO 与成员共用一个应用和一个 API，成员页面在 `/me`，成员看不到 CEO 的决策内容。

范围刻意保持很窄：只有「发送信号」「执行事项」「事项群组」和按人的通知，不做项目管理、看板、Mission／个人任务挂接、成员智能体或外部推送。DRI 服务令牌的导入导出边界（DRI Handoff）不变，与「发送」是两回事。设计见 `.scratch/member-workspace/spec.md`。
```

- [ ] **Step 4: 更新 `CONTEXT.md`**

先读 `CONTEXT.md` 现有词条格式（术语、定义、_Avoid_），按同一格式：
- 新增「成员（Member）」「登录 ID」「执行事项（Task）」「事项群组」「发送（信号）」五条。定义取自 spec §1–§3，_Avoid_ 分别写「用户账号体系」「用户名」「任务、待办、项目」「聊天室」「转发、分享」。
- 修订「DRI」：去掉「MVP 中不进入 CEO WarMap 主界面」的表述，改为「可以登录成员工作台，接收发给自己的信号并推进自己的执行事项；DRI Handoff 仍经导出边界」。
- 修订「CEO WarMap」：去掉「单 CEO」与 _Avoid_ 中的「协作平台」，改为说明「以 CEO 决策为中心，成员只参与信号发送、执行事项与事项群组」。

- [ ] **Step 5: 最终检查**

Run:

```bash
pnpm --filter @warmap/contracts test
cd apps/web && npx vitest run && npx tsc --noEmit
cd apps/api && npx tsc -p tsconfig.json --noEmit && npx vitest run --maxWorkers=3 --minWorkers=1
```

Expected: contracts 与 web 全绿；API 失败清单与基线一致。把结果与仍存在的限制写进本文件底部的 `## Comments`，把顶部 `Status:` 改为 `resolved`，并在 `.scratch/member-workspace/` 下补 `map.md` 记录进度。

## Comments

2026-09-24 完成（Claude）：
- 契约 38/38、网页 191/191、两边 tsc 通过；API 全量 343 通过、28 失败，与改动前基线清单逐条一致（Windows 下材料解析、bash 备份脚本、EXDEV，均与本次无关）。
- 本地已跑迁移 023，并给 seed 里 9 人发了初始码（表格交给了用户，不入库）。
- 浏览器已核对：锁屏在 1100 与 375 宽度下「你的 ID + 4 格口令」对齐可读；未登录访问 `/me`、`/radar` 分别回到 `/access?next=%2Fme`、`/access?next=%2Fradar`。
- 与计划的偏差：
  - 会话 payload 最终是 `{pid, v, exp}`，身份每次按 seed 现算（spec 原写 `{exp, pid, role, v}`），这样改 seed 角色后无需等会话过期。
  - 4 格口令与 ID 框统一为 260px 宽的居中组（`.narrowGroup`），避免 ID 框 430px 与口令格宽度不一。
  - 日志脱敏规则补了 `passcode`（覆盖 `newPasscode`）。
- 未执行（需要用户本人输入口令）：用初始码登录 CEO 与成员、首次设置口令、成员被挡在 CEO 页面外、退出登录。按安全规则 Claude 不代为输入口令。
- 限制：成员工作台只有外壳（名字、退出、空通知），通知与执行事项在第 2–4 步接入。

2026-09-24 追加（用户验收时发现）：本地只认 `PUBLIC_ORIGIN=http://localhost:3100`，从 127.0.0.1 或其他地址登录被来源检查 403（「请从正式访问地址打开天枢」）。用户选定方案「本地允许多个地址」：新增 `EXTRA_ALLOWED_ORIGINS`（逗号分隔，线上留空），`isAllowedOrigin` 统一用于登录/改口令与所有写请求；本地 `.env` 已加 `http://127.0.0.1:3100`。新增测试 1 条；API 全量 344 通过、28 失败与基线一致。
