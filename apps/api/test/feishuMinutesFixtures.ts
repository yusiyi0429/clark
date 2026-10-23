import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TMeetingCardCandidate } from "@warmap/contracts";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import type { FeishuMinutesApi } from "../src/feishu/minutes.js";
import { FEISHU_MINUTES_READ_SCOPES } from "../src/feishu/oauth.js";
import { hashSecret } from "../src/session.js";

// 妙记相关测试共用：人员、飞书密钥、逐字稿样例、假会后整理、授权与登录。
export const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
export const CEO = TEST_CEO.personId; // 测试甲
export const HOST = TEST_MEMBER.personId; // 测试乙
export const OWNER = "person-fixture-003"; // 测试丙
export const feishuEnv = { tokenKey: randomBytes(32), tokenKeyVersion: 1 };

/** 飞书导出的逐字稿 txt（合成样例）：第一行开会时刻，然后关键词，再是「姓名 hh:mm:ss.mmm」加正文。 */
export const TRANSCRIPT = [
  "2026-06-01 10:02:10 CST|58min 3s",
  "",
  "关键词:",
  "接口、看板",
  "",
  "测试乙 00:00:05.120 ",
  "接口统一改成 v2，测试丙那边月底前切过去。",
  "",
  "测试丙 00:01:10.002 ",
  "好，我月底前把渠道看板接到 v2。",
  "我们定在 10:30 再碰一次。",
  "",
].join("\n");

export const CANDIDATE: TMeetingCardCandidate = {
  summary: "接口统一切到 v2",
  sections: [{ heading: "接口", body: "已定：接口统一改成 v2。", turnIds: ["turn-0001"] }],
  objectChanges: [],
  actionItems: [],
};

export function recordingOutcome(): PostMeetingAgent & { inputs: PostMeetingAgentInput[] } {
  const agent = { inputs: [] as PostMeetingAgentInput[], async generate(input: PostMeetingAgentInput) { agent.inputs.push(input); return { candidate: structuredClone(CANDIDATE) }; } };
  return agent;
}

export async function authorize(t: TestApp, personId: string, openId: string, name: string, at: Date, scope = "offline_access") {
  await t.pool.query("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, $2, $3)", [personId, openId, name]);
  await saveAuthorizedToken(t.pool.query.bind(t.pool), feishuEnv, personId, { accessToken: `u-${personId}`, expiresIn: 7200, scope }, at);
}

/** 连上飞书、带读妙记要的权限（按真实时刻授权）。 */
export const connect = (t: TestApp, personId: string, openId: string, name: string) =>
  authorize(t, personId, openId, name, new Date(), FEISHU_MINUTES_READ_SCOPES.join(" "));

/** 给成员开登录口令并登录，返回 cookie。 */
export async function loginAs(t: TestApp, personId: string, loginId: string, passcode: string): Promise<string> {
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [personId, loginId, hashSecret(passcode)]);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId, passcode } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return String(login.headers["set-cookie"]).split(";")[0];
}

/** 接了飞书的天枢（妙记接口用假实现），上线时刻拨到一天前。 */
export async function inboxApp(api: FeishuMinutesApi): Promise<TestApp> {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, feishu: { appId: "cli_test", appSecret: "test-secret", ...feishuEnv } }, undefined,
    { outcomeAgent: recordingOutcome(), meetingFollowThroughAgents: { minutesApi: api } });
  await t.pool.query("UPDATE feishu_minute_inbox_launch SET launched_at = now() - interval '1 day'");
  return t;
}
