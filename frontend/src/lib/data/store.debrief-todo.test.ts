/**
 * 待办的两个窄写口：拍板（`confirmDebriefTodo`）与改字（`updateDebriefTodoText`）。
 *
 * 钉的是和 `store.debrief-assign.test.ts` 同一条性质：**只动那一条**。整份重建的
 * `updateDebrief` 按下标重发 id，任何一条待办的 `decidedAt` 都会被按位置猜回来；
 * 这一族方法存在的全部理由就是不这样做。
 *
 * 造数据走真链路（`ingestMeetingNotes` → 提炼落库），不搓测试专用后门 —— 理由同
 * `store.debrief-assign.test.ts` 文件头。假模型固定给两条待办（`models/mock.ts` 的
 * `a7.debrief`），「只动这一条」正好拿第二条当对照。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { nextDay } from "./agenda";

import type {
  api as Api,
  __seedResearchedIssueForTest as SeedResearched,
} from "./store";
import type { MeetingDebrief, ResearchDoc } from "./types";

let api: typeof Api;
let seedResearched: typeof SeedResearched;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照（同 store.meeting-intake.test.ts）。
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  seedResearched = mod.__seedResearchedIssueForTest;
});

const TRANSCRIPT =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "第二件先放着，下一季度实测数据到了再说。散会。";

/** 每条用例占一天，不共用会次（理由同 store.debrief-assign.test.ts）。 */
let dayCursor = 2;
const ownDay = (): string => {
  dayCursor += 1;
  let d = api.today;
  for (let i = 0; i < dayCursor; i += 1) d = nextDay(d);
  return d;
};

const researchedIssue = async (title: string): Promise<string> => {
  const { id } = await api.addIssue(title);
  const doc: ResearchDoc = {
    issueId: id,
    judgment: [{ text: "这一句是报告里的判断", traces: [] }],
    keyEvidence: [{ text: "这一句是证据", traces: [] }],
    counters: [{ text: "这一句是反面", traces: [] }],
    unknowns: [{ text: "这一句是还不知道的", traces: [] }],
    routeSuggestion: "建议上会",
    byAgentLabel: "CEO Agent",
    assembledFrom: [],
    sourceText: "## 核心判断\n\n这一句是报告里的判断。",
    at: "2026-08-25T02:00:00.000Z",
  };
  seedResearched(id, doc, { text: "要不要上会", suggestedDri: "白田田", deadline: "48小时" });
  const card = (await api.listPending()).find((c) => c.issueId === id);
  if (!card) throw new Error(`提请台上没找到刚立的那张卡：${id}`);
  await api.disposeCard(card.id, "discuss");
  return id;
};

const freshDebrief = async (
  title: string,
): Promise<{ slotId: string; issueId: string; debrief: MeetingDebrief }> => {
  const issueId = await researchedIssue(title);
  const slot = await api.scheduleIssue(issueId, { date: ownDay(), half: "am" });
  await api.ingestMeetingNotes(slot.id, TRANSCRIPT);
  for (let i = 0; i < 300; i += 1) {
    const st = await api.slotIntakeState(slot.id);
    if (st.status === "done") break;
    if (st.status !== "checking" && st.status !== "summarizing") {
      throw new Error(`${slot.id} 的材料没提炼成：${st.status}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const debrief = await api.getDebrief(slot.id, issueId);
  if (!debrief) throw new Error(`${slot.id}/${issueId} 上没有提炼出来的那一份。`);
  // 假模型固定两条待办：下面「只动这一条」全靠第二条当对照。
  expect(debrief.todos.length).toBe(2);
  return { slotId: slot.id, issueId, debrief };
};

/** 断言用：把每条待办压成一个可比的形状。 */
const shapeOf = (d: MeetingDebrief) =>
  d.todos.map((t) => ({
    id: t.id,
    text: t.text,
    owner: t.owner,
    principal: t.principal,
    decidedAt: t.decidedAt,
  }));

describe("confirmDebriefTodo", () => {
  it("拍板落下 decidedAt，落库了才算", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("拍板一条");
    const target = debrief.todos[0];
    expect(target.decidedAt).toBeUndefined();

    const out = await api.confirmDebriefTodo(slotId, issueId, target.id);
    expect(out.todos[0].decidedAt).toEqual(expect.any(String));

    const again = await api.getDebrief(slotId, issueId);
    expect(again!.todos[0].decidedAt).toBe(out.todos[0].decidedAt);
  }, 20_000);

  it("只动这一条：别的待办的 id、字、owner、principal 一个都不变", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("拍板只动一条");
    const before = shapeOf(debrief);

    const out = await api.confirmDebriefTodo(slotId, issueId, debrief.todos[0].id);

    expect(shapeOf(out)[1]).toEqual(before[1]);
    expect(out.todos[1].decidedAt).toBeUndefined();
    // 被拍板的那一条自己也只多了一格：字、owner、principal 照旧。
    expect(out.todos[0].text).toBe(debrief.todos[0].text);
    expect(out.todos[0].owner).toBe(debrief.todos[0].owner);
    expect(out.todos[0].principal).toEqual(debrief.todos[0].principal);
  }, 20_000);

  it("拍板不算「他改过字」", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("拍板不算改字");
    expect(debrief.editedAt).toBeUndefined();
    const out = await api.confirmDebriefTodo(slotId, issueId, debrief.todos[0].id);
    expect(out.editedAt).toBeUndefined();
    expect(out.summary).toBe(debrief.summary);
    expect(out.points).toEqual(debrief.points);
    expect(out.open).toEqual(debrief.open);
  }, 20_000);

  it("这一份不存在 / 这一条不在这份提炼上", async () => {
    const { slotId, issueId } = await freshDebrief("拍板查无");
    await expect(
      api.confirmDebriefTodo("SLOT-没有这场会", issueId, "TD-x"),
    ).rejects.toThrow("没有这一份会后提炼。");
    await expect(
      api.confirmDebriefTodo(slotId, issueId, "TD-不存在的待办"),
    ).rejects.toThrow("这一条不在这份提炼上。");
  }, 20_000);

  it("已经确认过的那一份不许再拍板", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("确认之后拍板");
    await api.confirmDebrief(slotId, issueId);
    await expect(
      api.confirmDebriefTodo(slotId, issueId, debrief.todos[0].id),
    ).rejects.toThrow("这一份已经确认过了。");
  }, 20_000);

  it("已经退回再议的那一份不许再拍板", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("退回再议之后拍板");
    await api.reopenDebrief(slotId, issueId);
    await expect(
      api.confirmDebriefTodo(slotId, issueId, debrief.todos[0].id),
    ).rejects.toThrow("这一份已经退回再议了。");
  }, 20_000);
});

describe("updateDebriefTodoText", () => {
  it("改这一条的字，落库了才算", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("改一条待办");
    const target = debrief.todos[0];

    const out = await api.updateDebriefTodoText(slotId, issueId, target.id, "改过的这句话");
    expect(out.todos[0].text).toBe("改过的这句话");
    expect(out.editedAt).toEqual(expect.any(String));

    const again = await api.getDebrief(slotId, issueId);
    expect(again!.todos[0].text).toBe("改过的这句话");
  }, 20_000);

  it("只动这一条：别的待办一个字都不变", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("改字只动一条");
    const before = shapeOf(debrief);

    const out = await api.updateDebriefTodoText(
      slotId,
      issueId,
      debrief.todos[0].id,
      "改过的这句话",
    );

    expect(shapeOf(out)[1]).toEqual(before[1]);
    // 被改的那一条：id、owner、principal 不受影响。
    expect(out.todos[0].id).toBe(debrief.todos[0].id);
    expect(out.todos[0].owner).toBe(debrief.todos[0].owner);
    expect(out.todos[0].principal).toEqual(debrief.todos[0].principal);
  }, 20_000);

  it("空文本按「没改」处理", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("改成空文本");
    const out = await api.updateDebriefTodoText(slotId, issueId, debrief.todos[0].id, "   ");
    expect(out.todos[0].text).toBe(debrief.todos[0].text);
    expect(out.editedAt).toBeUndefined();
  }, 20_000);

  it("这一份不存在 / 这一条不在这份提炼上", async () => {
    const { slotId, issueId } = await freshDebrief("改字查无");
    await expect(
      api.updateDebriefTodoText("SLOT-没有这场会", issueId, "TD-x", "字"),
    ).rejects.toThrow("没有这一份会后提炼。");
    await expect(
      api.updateDebriefTodoText(slotId, issueId, "TD-不存在的待办", "字"),
    ).rejects.toThrow("这一条不在这份提炼上。");
  }, 20_000);

  it("已经确认过的那一份不许再改字", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("确认之后改字");
    await api.confirmDebrief(slotId, issueId);
    await expect(
      api.updateDebriefTodoText(slotId, issueId, debrief.todos[0].id, "字"),
    ).rejects.toThrow("这一份已经确认过了。");
  }, 20_000);

  it("已经退回再议的那一份不许再改字", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("退回再议之后改字");
    await api.reopenDebrief(slotId, issueId);
    await expect(
      api.updateDebriefTodoText(slotId, issueId, debrief.todos[0].id, "字"),
    ).rejects.toThrow("这一份已经退回再议了。");
  }, 20_000);
});
