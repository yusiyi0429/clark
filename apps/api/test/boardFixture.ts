import { createHash, randomUUID } from "node:crypto";
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

export async function boardFixture(runtime: Parameters<typeof createTestApp>[2] = {}, seed: Parameters<typeof createTestApp>[0] = {}) {
  const storage = await mkdtemp(join(tmpdir(), "board-"));
  // 看板原有的测试跑云端拆卡和云端验收（BOARD_CLOUD_AGENTS）；第 21 节本机那条路的测试传 boardCloudAgents: false。
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, materialStorageDir: storage, boardCloudAgents: true, ...seed }, undefined, {
    monthlyNow: () => BOARD_NOW,
    planTasks: async (missions) => BOARD_TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    deliverableAgents: { review: { async review(input) {
      return { headline: "评过了", summary: "逐条看过", gain: null, criteria: input.criteria.map(({ index }) => ({ index, verdict: "met" as const, reason: "有材料", evidence: "材料", fix: null })) };
    } }, note: { async write() { return { achieved: "达成了", gain: "多了", why: null, lesson: null }; } } },
    deliverableFetcher: async (url) => ({ text: `网页正文 ${url}`, images: [] }),
    // 复盘的评审员：不调模型，每条「部分达到」。
    monthReviewAgent: { async rate(input) {
      return { criteria: input.criteria.map(({ index }) => ({ index, rating: "partial" as const, basis: "看过材料", vague: false, deliverable: false })) };
    } },
    ...runtime,
  });
  const mission = (id: string, owner: string) => t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
    source_ref,source_document_id,source_revision,source_title) VALUES($1,1,$1,'2026-11',$2,$3,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`,
  [id, id === "mine" ? "内部版上线" : "别人的 Mission", owner]);
  await mission("mine", TEST_MEMBER.personId);
  await mission("other", THIRD.personId);
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [THIRD.personId, THIRD.loginId, hashSecret(THIRD.passcode)]);
  const member = await t.memberCookie();
  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, cookie = member) =>
    t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  /** 本人在 mine 下挂 planTaskId 建一件执行事项（卡）。 */
  const card = async (title: string, options: { planTaskId?: string; doneDefinition?: string } = {}) => {
    const res = await call("POST", "/api/me/tasks", { clientId: randomUUID(), title, missionId: "mine", planTaskId: options.planTaskId ?? "task-open",
      doneDefinition: options.doneDefinition ?? "有方案文档\n有评审结论" });
    if (res.statusCode !== 200) throw new Error(res.body);
    return res.json().id as string;
  };
  /**
   * 配对一台电脑。send 是本机在一个新会话里报几条（subject 是卡或专题），返回会话 id；
   * handBack 是本机做完一轮交回来：几份产出、几个链接证据、一次点名用它们的交回。slots 是每批带的本机位置数。
   */
  const local = async (name = "我的电脑", slots = { max: 3, running: 1, queued: 0 }) => {
    const device = randomUUID();
    const token = (await call("POST", "/api/me/local-devices", { deviceId: device, name, os: "win32" })).json().token as string;
    const send = async (subject: { kind: "card"; cardId: string } | { kind: "topic"; topicId: string }, items: [string, unknown][]) => {
      const session = randomUUID();
      const res = await t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${token}` }, payload: { deviceId: device,
        runnerVersion: "0.1.0", slots, items: items.map(([type, data], index) => ({ key: `${device}:${session}:${index + 1}`, sessionId: session, subject,
          occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, index + 1)).toISOString(), type, data })) } });
      if (res.statusCode !== 200 || res.json().rejected.length) throw new Error(res.body);
      return session;
    };
    const handBack = async (cardId: string, options: { files?: [string, string][]; links?: string[] } = {}) => {
      const session = randomUUID();
      let seq = 0;
      const item = (type: string, data: unknown) => ({ key: `${device}:${session}:${++seq}`, sessionId: session, subject: { kind: "card", cardId },
        occurredAt: new Date(Date.UTC(2026, 10, 6, 3, 0, seq)).toISOString(), type, data });
      const outputs = [
        ...(options.files ?? [["方案.md", "# 方案\n有方案文档"]]).map(([name, text]) => {
          const buffer = Buffer.from(text);
          return item("artifact", { artifactId: `a${seq + 1}`, title: name, fileName: name, mimeType: "text/markdown", size: buffer.length,
            sha256: createHash("sha256").update(buffer).digest("hex"), contentBase64: buffer.toString("base64") });
        }),
        ...(options.links ?? ["https://example.com/review"]).map((url) => item("evidence", { kind: "link", title: "评审记录", url })),
      ];
      const items = [...outputs, item("handback", { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "方案.md" }, { index: 2, result: "met", evidence: "评审记录" }],
        outputKeys: outputs.map((output) => output.key) })];
      const res = await t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${token}` },
        payload: { deviceId: device, runnerVersion: "0.1.0", slots, items } });
      if (res.statusCode !== 200 || res.json().rejected.length) throw new Error(res.body);
      return (await t.sql("SELECT id FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1", [cardId]))[0].id as string;
    };
    return { device, token, send, handBack };
  };
  return { t, call, card, local, member, storage, close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}
export type BoardFixture = Awaited<ReturnType<typeof boardFixture>>;
