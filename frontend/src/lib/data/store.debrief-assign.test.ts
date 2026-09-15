/**
 * 把会后提炼里的**一条**要点派给某个 DRI（`assignDebriefPoint`）。
 *
 * 这个文件钉的是那颗下拉在账上的两条性质，它们坏了都不会在屏幕上留下症状：
 *
 *   · **窄。** 派一条只动那一条 —— 别的要点的 id、勾、字一个都不许变。整份重建的那条路
 *     （`updateDebrief`）会按下标重发 id、把勾按位置猜回来，于是「派了第一条」的副作用是
 *     第二条的勾莫名其妙地跳到了别处，而屏幕上两条要点看起来都好好的。
 *   · **名字是指派那一刻的快照。** 存进去的不是一个待会儿再去人表里换名字的 id，是当场
 *     抄下来的那两个字。让屏幕每次拿 id 去换的话，人表一改，账上过去那几行跟着改 ——
 *     一本会追溯性改写自己的账，翻开时和一本对的账长得一模一样。
 *
 * 造数据走的是真链路（`ingestMeetingNotes` → 提炼落库），没走任何测试专用后门：这一族
 * 方法的前提全在那份提炼的形状上（点的 id 怎么编、`confirmedAt` 什么时候有），手搓一份
 * 塞进去就把前提也一起搓了。假模型固定给两条要点（`models/mock.ts` 的 `a7.debrief`），
 * 「只动这一条」正好要的就是第二条当对照。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { nextDay } from "./agenda";
import { people } from "./seed-tokenking";

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
  // 判材料和按议题提炼各要叫一次模型。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  seedResearched = mod.__seedResearchedIssueForTest;
});

/* PSN-02 是白田田、PSN-03 是孙铭泽 —— 人表（`seed-tokenking.ts`）里 role 为 dri 的头两位。 */
const BAI = { id: "PSN-02", name: "白田田" } as const;
const SUN = { id: "PSN-03", name: "孙铭泽" } as const;

const TRANSCRIPT =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "第二件先放着，下一季度实测数据到了再说。散会。";

/**
 * 每条用例占一天，不共用会次。
 *
 * 同一天同一个半天是**同一场会**（`scheduleIssue` 会并进去），两条用例落在一个 slot 上的话，
 * 后一条读到的提炼是前一条派过的那一份 —— 而读代码时看不出来。
 */
let dayCursor = 2;
const ownDay = (): string => {
  dayCursor += 1;
  let d = api.today;
  for (let i = 0; i < dayCursor; i += 1) d = nextDay(d);
  return d;
};

/**
 * 一件**已经被采信、并且前期调研做完**的议题 —— 只有这样的议题排得进会（同
 * `store.meeting-intake.test.ts` 里那一段的理由）。
 */
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

/**
 * 一份**刚提炼出来、还没被处置**的会后提炼。
 *
 * 等它跑完的方式是问公开读口 —— 屏幕上那块流动的底问的就是这一句。
 */
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
  // 假模型固定两条要点：下面「只动这一条」全靠第二条当对照。
  expect(debrief.points.length).toBe(2);
  return { slotId: slot.id, issueId, debrief };
};

/** 断言用：把每条要点压成一个可比的形状。 */
const shapeOf = (d: MeetingDebrief) =>
  d.points.map((p) => ({ id: p.id, text: p.text, boundary: p.boundary, checked: p.checked }));

describe("派得出去", () => {
  it("那一条上写下 id 和名字，名字是从人表里抄的", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("派一条出去");
    const target = debrief.points[0];

    const out = await api.assignDebriefPoint(slotId, issueId, target.id, BAI.id);
    expect(out.points[0].assignee).toEqual({ id: BAI.id, name: BAI.name });

    // 返回值不算数，落库了才算：屏幕刷新之后读的是这一口。
    const again = await api.getDebrief(slotId, issueId);
    expect(again!.points[0].assignee).toEqual({ id: BAI.id, name: BAI.name });
  }, 20_000);

  it("改派就是覆盖，不是又派了一个人", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("改派一次");
    const id = debrief.points[0].id;
    await api.assignDebriefPoint(slotId, issueId, id, BAI.id);
    const out = await api.assignDebriefPoint(slotId, issueId, id, SUN.id);
    expect(out.points[0].assignee).toEqual({ id: SUN.id, name: SUN.name });
  }, 20_000);

  it("人表后来改了名，账上这一行不跟着改 —— 存的是当时那两个字", async () => {
    /*
     * 这一条测的是「为什么存名字不只存 id」。屏幕拿 id 现查的话，改名这一下会把过去
     * 每一份提炼上那个人的名字一起改掉 —— 而账的性质恰恰是：半年后那个人换了岗、
     * 甚至从表里没了，这一行仍然答得出当时派给了谁。
     */
    const { slotId, issueId, debrief } = await freshDebrief("改名之后");
    await api.assignDebriefPoint(slotId, issueId, debrief.points[0].id, BAI.id);

    const person = people.find((p) => p.id === BAI.id)!;
    const before = person.name;
    try {
      person.name = "换了个名字";
      const after = await api.getDebrief(slotId, issueId);
      expect(after!.points[0].assignee).toEqual({ id: BAI.id, name: BAI.name });
    } finally {
      person.name = before;
    }
  }, 20_000);
});

describe("撤得回来", () => {
  it("传 null 就撤掉 —— 那一格是不存在，不是一个空名字", async () => {
    /*
     * 留一个 `{ id: "", name: "" }` 在那儿的话，屏幕上那一行会显示成「派给了（空白）」，
     * 而它和「这条还没派」在账上是两件完全不同的事。
     */
    const { slotId, issueId, debrief } = await freshDebrief("撤掉指派");
    const id = debrief.points[0].id;
    await api.assignDebriefPoint(slotId, issueId, id, BAI.id);

    const out = await api.assignDebriefPoint(slotId, issueId, id, null);
    expect(out.points[0].assignee).toBeUndefined();
    expect(Object.hasOwn(out.points[0], "assignee")).toBe(false);

    const again = await api.getDebrief(slotId, issueId);
    expect(Object.hasOwn(again!.points[0], "assignee")).toBe(false);
  }, 20_000);

  it("没派过也撤得动，且不留下任何痕迹", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("撤一条没派过的");
    const out = await api.assignDebriefPoint(slotId, issueId, debrief.points[0].id, null);
    expect(shapeOf(out)).toEqual(shapeOf(debrief));
  }, 20_000);
});

describe("只动这一条", () => {
  it("别的要点的 id、勾、字一个都不变", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("只动这一条");
    // 先在**第二条**上留一个记号：整份重建的坏法就是把这个勾挪到别处或者抹掉。
    const marked = await api.toggleDebriefPoint(slotId, issueId, debrief.points[1].id);
    expect(marked.points[1].checked).toBe(true);
    const others = shapeOf(marked).slice(1);

    const out = await api.assignDebriefPoint(slotId, issueId, debrief.points[0].id, BAI.id);

    expect(shapeOf(out).slice(1)).toEqual(others);
    expect(out.points[1].assignee).toBeUndefined();
    // 被派的那一条自己也只多了一格：id、字、边界照旧。
    expect(out.points[0].id).toBe(debrief.points[0].id);
    expect(out.points[0].text).toBe(debrief.points[0].text);
    expect(out.points[0].boundary).toBe(debrief.points[0].boundary);
    expect(out.points[0].checked).toBe(debrief.points[0].checked);
  }, 20_000);

  it("派一条不算「他改过字」", async () => {
    /*
     * `editedAt` 那枚标记的含义是「这几句已经是他自己的话」（同 `toggleDebriefPoint`
     * 那一段）。派个人并没有改动任何一个字，盖上去的话屏幕就分不出哪几句是模型写的。
     */
    const { slotId, issueId, debrief } = await freshDebrief("派人不算改字");
    expect(debrief.editedAt).toBeUndefined();
    const out = await api.assignDebriefPoint(slotId, issueId, debrief.points[0].id, BAI.id);
    expect(out.editedAt).toBeUndefined();
    // 摘要、待办、未决那几段也一样没被碰过。
    expect(out.summary).toBe(debrief.summary);
    expect(out.todos).toEqual(debrief.todos);
    expect(out.open).toEqual(debrief.open);
  }, 20_000);
});

describe("派不出去的几种", () => {
  it("人不在表上 —— 报出来，不静默落一个只有 id 的指派", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("查无此人");
    const id = debrief.points[0].id;
    await api.assignDebriefPoint(slotId, issueId, id, BAI.id);

    await expect(api.assignDebriefPoint(slotId, issueId, id, "PSN-没有这个人")).rejects.toThrow(
      "没有这个人。",
    );
    // 失败那一下什么都没动：上一次派的人还在，没有被一个半拉子的指派挤掉。
    const after = await api.getDebrief(slotId, issueId);
    expect(after!.points[0].assignee).toEqual({ id: BAI.id, name: BAI.name });
  }, 20_000);

  it("这一份提炼不存在", async () => {
    const { slotId, issueId, debrief } = await freshDebrief("没有这一份");
    const id = debrief.points[0].id;
    // 会次对不上、议题对不上，两种都是「没有这一份」——键是这两样拼出来的。
    await expect(
      api.assignDebriefPoint("SLOT-没有这场会", issueId, id, BAI.id),
    ).rejects.toThrow("没有这一份会后提炼。");
    await expect(
      api.assignDebriefPoint(slotId, "ISS-没有这件议题", id, BAI.id),
    ).rejects.toThrow("没有这一份会后提炼。");
  }, 20_000);

  it("这一条要点不在这份提炼上", async () => {
    const { slotId, issueId } = await freshDebrief("没有这一条");
    await expect(
      api.assignDebriefPoint(slotId, issueId, "PT-不存在的要点", BAI.id),
    ).rejects.toThrow("这一条不在这份提炼上。");
  }, 20_000);

  it("已经确认过的那一份不许再派 —— 确认是封口", async () => {
    /*
     * 封口之后它是一条历史记录。要改，先「还需再议」把它退回来 —— 而那一下在议题上
     * 也留痕。允许在已确认的那份上继续派的话，账会在他认过之后被悄悄改写。
     */
    const { slotId, issueId, debrief } = await freshDebrief("确认之后");
    const id = debrief.points[0].id;
    await api.assignDebriefPoint(slotId, issueId, id, BAI.id);
    await api.confirmDebrief(slotId, issueId);

    await expect(api.assignDebriefPoint(slotId, issueId, id, SUN.id)).rejects.toThrow(
      "这一份已经确认过了。",
    );
    await expect(api.assignDebriefPoint(slotId, issueId, id, null)).rejects.toThrow(
      "这一份已经确认过了。",
    );
    // 封口那一刻的样子原样留着。
    const after = await api.getDebrief(slotId, issueId);
    expect(after!.points[0].assignee).toEqual({ id: BAI.id, name: BAI.name });
  }, 20_000);
});
