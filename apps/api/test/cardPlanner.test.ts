import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CardPlanAgent, CardPlanInput, TCardPlanCandidate } from "../src/cardPlanner.js";
import { cardPlanProblem } from "../src/cardPlanner.js";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

const CARDS: TCardPlanCandidate["cards"] = [
  { title: "跑一遍题库打分", brief: "用现有题库跑一遍", standards: ["有打分表", "有低分题清单"], criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: "第 1 条要打分结果" },
  { title: "录新人上手", brief: "找一位新人录屏", standards: ["有 3 分钟录屏"], criterionIndex: 2, executor: "self", modelTier: "light", why: "要本人约人" },
  { title: "写复盘", brief: "", standards: ["有复盘文档"], criterionIndex: null, executor: "claude_code", modelTier: "strong", why: "收个尾" },
];

async function plannerFixture() {
  const calls: CardPlanInput[] = [];
  let release: () => void = () => undefined;
  let impl: (input: CardPlanInput) => Promise<TCardPlanCandidate> = async () => ({ cards: CARDS });
  const plan: CardPlanAgent = { plan: (input) => { calls.push(input); return impl(input); } };
  const f = await boardFixture({ boardAgents: { plan } });
  const hold = () => { impl = () => new Promise((resolve) => { release = () => resolve({ cards: CARDS }); }); };
  return { ...f, calls, hold, release: () => release(), setImpl: (next: typeof impl) => { impl = next; } };
}

describe("拆卡：作业和草稿", () => {
  it("拆卡进队列，同一个 Task 同时只跑一次；伙伴拿到 Task、标准、Mission、已有的卡和本人的想法；草稿虚线进待开始", async () => {
    const f = await plannerFixture();
    try {
      await f.card("已有的一张");
      f.hold();
      const first = await f.call("POST", "/api/plan-tasks/task-open/card-plans", { hint: "先打分再录屏" });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ status: "queued", hint: "先打分再录屏", expectedSeconds: 60 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const again = await f.call("POST", "/api/plan-tasks/task-open/card-plans", {});
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ id: first.json().id, status: "running" });
      f.release();
      await f.t.app.cardPlans.idle();
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toEqual({ task: { name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: [{ index: 1, text: "有题库打分结果" }, { index: 2, text: "有新人上手录屏" }] },
        mission: { title: "内部版上线", milestones: [] }, existing: [{ title: "已有的一张", criterionIndex: null, status: "not_started" }], hint: "先打分再录屏" });
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.plan).toMatchObject({ id: first.json().id, status: "done", error: null });
      expect(board.drafts).toMatchObject([
        { position: 0, title: "跑一遍题库打分", brief: "用现有题库跑一遍", doneDefinition: "有打分表\n有低分题清单", criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: "第 1 条要打分结果" },
        { position: 1, title: "录新人上手", executor: "self", modelTier: "light" },
        { position: 2, title: "写复盘", brief: "", criterionIndex: null, modelTier: "strong" },
      ]);
      expect((await f.call("POST", "/api/plan-tasks/task-theirs/card-plans", {})).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("放进看板建执行事项，挂对 Mission 和 Task、来源自己建；可以顺手改；处理过的再放、再去掉都是 409", async () => {
    const f = await plannerFixture();
    try {
      await f.call("POST", "/api/plan-tasks/task-open/card-plans", {});
      await f.t.app.cardPlans.idle();
      const drafts = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { id: string }[];
      const accepted = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [
        { id: drafts[0].id, title: "跑题库打分（改）", executor: "self" }, { id: drafts[1].id }] });
      expect(accepted.statusCode).toBe(200);
      const cards = accepted.json().cards;
      expect(cards).toMatchObject([
        { title: "跑题库打分（改）", source: "self", status: "not_started", planTaskId: "task-open", doneDefinition: "有打分表\n有低分题清单",
          mission: { missionId: "mine", title: "内部版上线" }, owner: { personId: TEST_MEMBER.personId },
          card: { stage: "todo", executor: "self", criterion: { index: 1, text: "有题库打分结果" } } },
        { title: "录新人上手", card: { executor: "self", criterion: { index: 2, text: "有新人上手录屏" } } },
      ]);
      expect((await f.t.sql("SELECT brief FROM tasks WHERE id=$1", [cards[0].id]))[0].brief).toBe("用现有题库跑一遍");
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [{ id: drafts[0].id }] })).json()).toMatchObject({ code: "DRAFT_DECIDED" });
      expect((await f.call("POST", `/api/card-drafts/${drafts[2].id}/dismiss`)).statusCode).toBe(204);
      expect((await f.call("POST", `/api/card-drafts/${drafts[2].id}/dismiss`)).statusCode).toBe(409);
      expect((await f.call("POST", `/api/card-drafts/${randomUUID()}/dismiss`)).statusCode).toBe(404);
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.drafts).toEqual([]);
      expect(board.cards.map((card: { title: string }) => card.title)).toEqual(["跑题库打分（改）", "录新人上手"]);
    } finally { await f.close(); }
  });

  it("伙伴出的卡编号越界、和已有的卡重名时这次拆卡算没拆完，可以再拆；重启以后排队中的接着拆", async () => {
    const f = await plannerFixture();
    try {
      await f.card("跑一遍题库打分");
      await f.call("POST", "/api/plan-tasks/task-open/card-plans", {});
      await f.t.app.cardPlans.idle();
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json()).toMatchObject({ plan: { status: "failed", error: "拆卡没做完，可以重试" }, drafts: [] });
      f.setImpl(async () => ({ cards: CARDS.map((card) => ({ ...card, title: `${card.title}（新）` })) }));
      const queued = randomUUID();
      await f.t.sql("INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id) VALUES($1,'task-open','mine',$2)", [queued, TEST_MEMBER.personId]);
      await f.t.app.cardPlans.recover();
      await f.t.app.cardPlans.idle();
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json()).toMatchObject({ plan: { id: queued, status: "done" } });
    } finally { await f.close(); }
  });

  it("校验：编号要在标准范围内，完成标准合起来不超过 500 字，不能重名", () => {
    expect(cardPlanProblem({ cards: CARDS }, 2, [])).toBeNull();
    expect(cardPlanProblem({ cards: CARDS }, 0, [])).toBe("这个 Task 没有标准，第 1 张的 criterionIndex 写 null");
    expect(cardPlanProblem({ cards: [{ ...CARDS[0], criterionIndex: 3 }, ...CARDS.slice(1)] }, 2, [])).toBe("第 1 张的 criterionIndex 只能是 1 到 2 或 null");
    expect(cardPlanProblem({ cards: CARDS }, 2, ["录 新人上手"])).toBe("第 2 张「录新人上手」和已有的卡或前面的草稿重名");
    expect(cardPlanProblem({ cards: [CARDS[0], { ...CARDS[1], standards: Array(5).fill("长".repeat(110)) }, CARDS[2]] }, 2, [])).toBe("第 2 张的完成标准合起来超过 500 字，写短一些");
  });
});
