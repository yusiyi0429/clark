import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** Task 管线的验收行（契约 workHome.ts 的 TaskFeedItem）：GET /api/me/tasks/:taskId/feed，从卡和交回现算。 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 3, minute)).toISOString();
type Handback = { attempt: number; outcome: "pass" | "fail"; minute: number; verdicts: string[]; returnText?: string; overruled?: { minute: number; reason: string };
  merge?: Record<string, unknown>; owner?: string };
/** 直接落库一次有结论的交回，返回交回 id。 */
async function handback(f: BoardFixture, cardId: string, h: Handback): Promise<string> {
  const result = { headline: "结论", beyondScope: [],
    criteria: h.verdicts.map((verdict, index) => ({ index: index + 1, verdict, reason: "理由", evidence: null, fix: verdict === "met" ? null : "补上" })) };
  const rows = await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status,finished_at,result,outcome,return_text,
    overruled_at,overruled_by,overrule_reason,merge) VALUES($1,$2,$3,$4,$5,'["甲","乙"]'::jsonb,'done',$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
  [randomUUID(), cardId, h.owner ?? TEST_MEMBER.personId, `k${h.attempt}`, h.attempt, at(h.minute), JSON.stringify(result), h.outcome, h.returnText ?? null,
    h.overruled ? at(h.overruled.minute) : null, h.overruled ? TEST_MEMBER.personId : null, h.overruled?.reason ?? null, h.merge ? JSON.stringify(h.merge) : null]);
  return rows[0].id as string;
}
const criterion = (f: BoardFixture, cardId: string, index: number) =>
  f.t.sql("UPDATE tasks SET criterion_index=$2,criterion_text=$3 WHERE id=$1", [cardId, index, index === 1 ? "有题库打分结果" : "有新人上手录屏"]);
const feed = async (f: BoardFixture, taskId = "task-open") => {
  const res = await f.call("GET", `/api/me/tasks/${taskId}/feed`);
  expect(res.statusCode).toBe(200);
  return res.json().items as { kind: string; id: string; at: string }[];
};

describe("Task 管线的验收行", { timeout: 30_000 }, () => {
  it("过了、受阻、约定都达到、返工卡四种行，按时间从旧到新、同一时间按 id；别人的卡和别的 Task 的卡不出现", async () => {
    const f = await boardFixture();
    try {
      const ids: Record<string, string> = {};
      for (const title of ["打分", "录屏", "卡住的", "合回后推翻的", "返工：合回后推翻的"]) ids[title] = await f.card(title);
      await criterion(f, ids["打分"], 1);
      await criterion(f, ids["录屏"], 2);

      // 打分：第一次没过，第二次过了、已合进 main。
      await handback(f, ids["打分"], { attempt: 1, outcome: "fail", minute: 1, verdicts: ["not_met", "met"], returnText: "补上第 1 条" });
      const scorePass = await handback(f, ids["打分"], { attempt: 2, outcome: "pass", minute: 5, verdicts: ["met", "met"],
        merge: { merged: true, commit: "abc123", baseBranch: "main", reason: null, message: null, auto: true, at: at(6), seq: 3 } });
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [ids["打分"]]);
      // 只有第 1 条达到：还没有「约定都达到」。
      expect((await feed(f)).map((item) => item.kind)).toEqual(["card_passed"]);

      // 录屏：验收没过，本人「仍然通过」（推翻算通过，算全部达到）；没能自动合回。
      const videoPass = await handback(f, ids["录屏"], { attempt: 1, outcome: "fail", minute: 8, verdicts: ["met", "not_met"], overruled: { minute: 10, reason: "录屏够了" },
        merge: { merged: false, commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", auto: true, at: at(11), seq: 1 } });
      // 卡住的：连续两次没过，最近那次的改法给网页。
      await handback(f, ids["卡住的"], { attempt: 1, outcome: "fail", minute: 2, verdicts: ["not_met", "met"], returnText: "第一次的改法" });
      const blocked = await handback(f, ids["卡住的"], { attempt: 2, outcome: "fail", minute: 3, verdicts: ["not_met", "met"], returnText: "第二次的改法" });
      // 合回后推翻：原卡过了、合回了，本人推翻；同一件 Task 下开了返工卡。
      const mergedPass = await handback(f, ids["合回后推翻的"], { attempt: 1, outcome: "pass", minute: 15, verdicts: ["met", "met"],
        overruled: { minute: 20, reason: "页面没对齐" }, merge: { merged: true, commit: "def456", baseBranch: "main", reason: null, message: null, auto: true, at: at(16), seq: 2 } });
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [ids["合回后推翻的"]]);
      await f.t.sql("UPDATE tasks SET rework_of_card_id=$2,created_at=$3 WHERE id=$1", [ids["返工：合回后推翻的"], ids["合回后推翻的"], at(21)]);

      // 别人在这件 Task 下的卡、本人在别的 Task 下的卡：都过了，但不出现。
      const theirs = randomUUID();
      await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,plan_task_id,criterion_index,criterion_text)
        VALUES($1,'别人的卡',$2,'self','done','other',1,'task-open',1,'有题库打分结果')`, [theirs, THIRD.personId]);
      await handback(f, theirs, { attempt: 1, outcome: "pass", minute: 4, verdicts: ["met", "met"], owner: THIRD.personId });
      const elsewhere = await f.card("别的 Task 的卡", { planTaskId: "task-theirs" });
      await handback(f, elsewhere, { attempt: 1, outcome: "pass", minute: 4, verdicts: ["met", "met"] });

      expect(await feed(f)).toEqual([
        { kind: "card_blocked", id: `blocked:${blocked}`, at: at(3), cardId: ids["卡住的"], title: "卡住的", handbackId: blocked, fix: "第二次的改法" },
        { kind: "card_passed", id: `passed:${scorePass}`, at: at(5), cardId: ids["打分"], title: "打分", met: 2, total: 2,
          merge: { state: "merged", commit: "abc123", baseBranch: "main", reason: null, message: null, at: at(6) } },
        // 同一时间（推翻的时间）按 id：criteria: 在 passed: 前面。
        { kind: "criteria_met", id: "criteria:task-open:2", at: at(10), met: 2, total: 2 },
        { kind: "card_passed", id: `passed:${videoPass}`, at: at(10), cardId: ids["录屏"], title: "录屏", met: 2, total: 2,
          merge: { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at: at(11) } },
        { kind: "rework_opened", id: `rework:${ids["返工：合回后推翻的"]}`, at: at(21), cardId: ids["返工：合回后推翻的"], title: "返工：合回后推翻的",
          fromCardId: ids["合回后推翻的"], reason: "页面没对齐" },
      ]);
      // 推翻掉的那次通过不再算一行。
      expect((await feed(f)).some((item) => item.id === `passed:${mergedPass}`)).toBe(false);

      // 第 1 条那张卡最近一次又没过：约定不再都达到；卡住的那张后来过了：不再受阻。
      await handback(f, ids["打分"], { attempt: 3, outcome: "fail", minute: 30, verdicts: ["not_met", "met"] });
      await handback(f, ids["卡住的"], { attempt: 3, outcome: "pass", minute: 31, verdicts: ["met", "met"] });
      const kinds = (await feed(f)).map((item) => item.kind);
      expect(kinds).not.toContain("criteria_met");
      expect(kinds).not.toContain("card_blocked");
    } finally { await f.close(); }
  });

  it("不是负责人 403，看不到或找不到 404", async () => {
    const f = await boardFixture();
    try {
      expect((await f.call("GET", "/api/me/tasks/task-theirs/feed")).statusCode).toBe(403);
      expect((await f.call("GET", "/api/me/tasks/task-other/feed")).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/tasks/no-such-task/feed")).statusCode).toBe(404);
      expect(await feed(f)).toEqual([]);
    } finally { await f.close(); }
  });
});
