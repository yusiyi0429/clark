import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { THomePlanTask } from "@warmap/contracts";
import { hashSecret } from "../src/session.js";
import { createTestApp, TEST_MEMBER } from "./helpers.js";

/** 看板、拆卡、Agent 验收、出版本、专题测试共用：本人一个本月 Mission（mine），别人一个（other），本体里几个 Task。 */
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
export const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "3579" } as const;
export const BOARD_NOW = new Date("2026-11-06T02:00:00.000Z");
export const BOARD_TASKS: THomePlanTask[] = [
  { taskId: "task-open", missionId: "mine", name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: ["有题库打分结果", "有新人上手录屏"] },
  { taskId: "task-theirs", missionId: "mine", name: "别人负责的", doneDefinition: null, criteria: ["有方案"], responsibleId: THIRD.personId },
  { taskId: "task-other", missionId: "other", name: "别人 Mission 的", doneDefinition: null, criteria: ["有方案"] },
];

export async function boardFixture(runtime: Parameters<typeof createTestApp>[2] = {}) {
  const storage = await mkdtemp(join(tmpdir(), "board-"));
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, materialStorageDir: storage }, undefined, {
    monthlyNow: () => BOARD_NOW,
    planTasks: async (missions) => BOARD_TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    deliverableAgents: { review: { async review(input) {
      return { headline: "评过了", summary: "逐条看过", gain: null, criteria: input.criteria.map(({ index }) => ({ index, verdict: "met" as const, reason: "有材料", evidence: "材料", fix: null })) };
    } }, note: { async write() { return { achieved: "达成了", gain: "多了", why: null, lesson: null }; } } },
    deliverableFetcher: async (url) => ({ text: `网页正文 ${url}`, images: [] }),
    ...runtime,
  });
  const mission = (id: string, owner: string) => t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
    source_ref,source_document_id,source_revision,source_title) VALUES($1,1,$1,'2026-11',$2,$3,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`,
  [id, id === "mine" ? "内部版上线" : "别人的 Mission", owner]);
  await mission("mine", TEST_MEMBER.personId);
  await mission("other", THIRD.personId);
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [THIRD.personId, THIRD.loginId, hashSecret(THIRD.passcode)]);
  const member = await t.memberCookie();
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, cookie = member) =>
    t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  /** 本人在 mine 下挂 planTaskId 建一件执行事项（卡）。 */
  const card = async (title: string, options: { planTaskId?: string; doneDefinition?: string } = {}) => {
    const res = await call("POST", "/api/me/tasks", { clientId: randomUUID(), title, missionId: "mine", planTaskId: options.planTaskId ?? "task-open",
      doneDefinition: options.doneDefinition ?? "有方案文档\n有评审结论" });
    if (res.statusCode !== 200) throw new Error(res.body);
    return res.json().id as string;
  };
  return { t, call, card, member, storage, close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}
export type BoardFixture = Awaited<ReturnType<typeof boardFixture>>;
