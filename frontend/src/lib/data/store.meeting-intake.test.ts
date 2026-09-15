/**
 * 交材料这一段：**这一场会走到哪一步了，以及那几件议题此刻坐在哪一栏。**
 *
 * 这个文件钉的是 2026-08-31 换掉的那条栏目归属规则。原来是「会到点了（`slotPast`）就整场
 * 挪进右栏等纪要」—— 于是右栏里长期摞着几张什么都没有、只写着「等纪要」的卡，而**没交材料
 * 和这场会没开在他澄清之前是同一件事**：两种都还没有任何产出。现在右栏只装已经提炼出摘要
 * 和 checklist 的（`debrief`），其余留在议题栏，交材料的出口就长在那一块上。
 *
 * 四条：
 *
 *   · 会到点了、材料还没交 —— 那几件议题**仍然在议题栏**（`isLiveIssue`），右栏没有它们。
 *   · 材料交上来、提炼跑完 —— 这时候才有 `debrief`，也才离开议题栏。
 *   · 材料被判成对不上这场会 —— **一份 debrief 都不建**，那句原话原样留在这一场会上。
 *   · 交上来那份材料的**全文**真的存下来了（判成没用的那一份也存）。
 *
 * 断言全从公开读口取（`listIssues` / `listSlots` / `listDebriefs` / `slotIntakeState`），
 * 一处内部状态都不摸 —— 断的是屏幕真正依赖的东西（同 `store.agenda.test.ts` 那段理由）。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { isLiveIssue } from "@/components/agenda/console-shell";

import { nextDay } from "./agenda";

import type {
  api as Api,
  __backdateSlotForTest as Backdate,
  __seedResearchedIssueForTest as SeedResearched,
} from "./store";
import type { ResearchDoc } from "./types";

let api: typeof Api;
let seedResearched: typeof SeedResearched;
let __backdateSlotForTest: typeof Backdate;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照（同 store.agenda.test.ts）。
  process.env.TKOS_PERSIST = "0";
  // 判材料和按议题提炼各要叫一次模型。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  seedResearched = mod.__seedResearchedIssueForTest;
  __backdateSlotForTest = mod.__backdateSlotForTest;
});

/**
 * 一件**已经被采信、并且前期调研做完**的议题。
 *
 * 两步都要：没到手研究的议题排不进会；而刚立出来的那一件是 `Candidate`，它归左上角那扇窗，
 * 本来就不在议题栏里 —— 从那个起点出发的话，下面每一条「它还在议题栏」都会因为一个和
 * 栏目归属无关的理由变绿。采信这一下（`disposeCard` 的 `discuss`）就是那道门。
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

/** 往后数第 n 天。理由同 `store.agenda.test.ts`：写死日期会让这个文件到某一天开始乱红。 */
const dayN = (n: number): string => {
  let d = api.today;
  for (let i = 0; i < n; i += 1) d = nextDay(d);
  return d;
};

/** 往回数第 n 天。数得远一点：预载案例里就有昨天下午那场会，撞上去验的就不是这几条了。 */
const backN = (n: number): string => {
  const [y, m, d] = api.today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};

const summaryOf = async (issueId: string) =>
  (await api.listIssues()).find((i) => i.id === issueId)!;
const slotById = async (id: string) => (await api.listSlots()).find((s) => s.id === id);

const TRANSCRIPT =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "第二件先放着，下一季度实测数据到了再说。散会。";

/**
 * 一份**明摆着不是这场会记录**的材料。
 *
 * 假模型认的是里面那几个字（见 `models/mock.ts` 里 `a7.intake` 那一支）：它分不出一段话
 * 像不像一场会，所以判没用那一档在离线只能靠一个写明了的记号来走到 —— 而这一档必须走得到，
 * 它决定了后面那一大笔钱花不花。
 */
const NOT_A_MEETING =
  "这份东西不是会议记录，是一篇产品说明的初稿，从头到尾只有一个人在写，没有任何一句是会上说的话。";

/**
 * 交一份材料，**等它跑完**。
 *
 * 等的方式是问公开读口 —— 屏幕上那块流动的底问的就是这一句，测试等的和它等的是同一个事实。
 */
const ingest = async (slotId: string, text: string, name?: string) => {
  const first = await api.ingestMeetingNotes(slotId, text, name);
  for (let i = 0; i < 300; i += 1) {
    const st = await api.slotIntakeState(slotId);
    if (st.status !== "checking" && st.status !== "summarizing") return { first, last: st };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${slotId} 的材料一直没跑完。`);
};

describe("会开完了、材料还没交", () => {
  it("那几件议题仍然在议题栏里 —— 右栏一张卡都没有", async () => {
    /*
     * 这一条就是被推翻的那条旧规则的反面。旧规则下这两件议题此刻已经整场挪去了右栏，
     * 以「等纪要」的样子摞在他的待办里 —— 而这场会有没有开过，此刻没有任何人知道。
     */
    const a = await researchedIssue("到点没交材料 A");
    const b = await researchedIssue("到点没交材料 B");
    const at = { date: dayN(4), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    __backdateSlotForTest(s.id, backN(11));

    for (const id of [a, b]) {
      const summary = await summaryOf(id);
      // 会确实已经过去了 —— 不是「还没到点所以当然在议题栏」。
      expect(summary.slot!.ended).toBe(true);
      expect(summary.debrief).toBeUndefined();
      expect(isLiveIssue(summary)).toBe(true);
    }
    // 这一场还没收到过任何材料。
    expect(await api.slotIntakeState(s.id)).toEqual({ status: "idle" });
  });

  it("这场会压根没开，也是同一档 —— 在他澄清之前，两种是同一件事", async () => {
    const a = await researchedIssue("没开过的那场会 A");
    const s = await api.scheduleIssue(a, { date: dayN(5), half: "pm" });
    __backdateSlotForTest(s.id, backN(12));
    expect(isLiveIssue(await summaryOf(a))).toBe(true);
    // 「未召开」那个出口仍然按得动 —— 它长在议题栏那一块上。
    const out = await api.cancelMeetingSlot(s.id);
    expect(out.issueIds).toEqual([a]);
    expect((await summaryOf(a)).slot).toBeUndefined();
  });
});

describe("材料交上来了", () => {
  it("松手那一刻就是 checking，不用等它跑完", async () => {
    /*
     * 立刻返回是这条链路的形状要求：那一块要留在议题栏原地不动地跑，屏幕得在他松手那一刻
     * 就拿到状态。等跑完再返回的话，那几十秒里屏幕手上什么都没有，只能自己编一句话。
     */
    const a = await researchedIssue("立刻返回测试");
    const s = await api.scheduleIssue(a, { date: dayN(6), half: "am" });
    const { first } = await ingest(s.id, TRANSCRIPT, "复核会录音.wav");
    expect(first.status).toBe("checking");
    expect(first.name).toBe("复核会录音.wav");
  });

  it("提炼跑完才有 debrief，也才离开议题栏", async () => {
    const a = await researchedIssue("跑完才挪栏");
    const s = await api.scheduleIssue(a, { date: dayN(7), half: "am" });

    const before = await summaryOf(a);
    expect(isLiveIssue(before)).toBe(true);

    const { last } = await ingest(s.id, TRANSCRIPT);
    expect(last.status).toBe("done");

    const after = await summaryOf(a);
    expect(after.debrief?.summary.length).toBeGreaterThan(0);
    expect(after.debrief?.points.length).toBeGreaterThan(0);
    // 有了摘要和 checklist，这时候它才归右栏。
    expect(isLiveIssue(after)).toBe(false);
  });

  it("交上来那份全文原样存着 —— 详细内容页第一项就是它", async () => {
    const a = await researchedIssue("全文落库测试");
    const s = await api.scheduleIssue(a, { date: dayN(8), half: "am" });
    await ingest(s.id, TRANSCRIPT, "0901 复核会.txt");
    const slot = (await slotById(s.id))!;
    expect(slot.transcript).toBe(TRANSCRIPT);
    expect(slot.audioName).toBe("0901 复核会.txt");
    expect(slot.transcribedAt).toBeTruthy();
  });
});

describe("交上来的材料对不上这场会", () => {
  it("一份 debrief 都不建，那句原话原样留着", async () => {
    /*
     * 判没用那一下省掉的是后面那一次 `pro` 档、吃下几万字的提炼调用。省没省得掉在这里只
     * 有一个看得见的形式：**库里一份提炼都没有**。建一份空的上去的话，右栏会立刻摞出一张
     * 什么都没有的卡，而他要做的事恰恰是回到议题栏重新交一份。
     */
    const a = await researchedIssue("对不上这场会");
    const s = await api.scheduleIssue(a, { date: dayN(9), half: "am" });
    const { last } = await ingest(s.id, NOT_A_MEETING, "上周产品评审.txt");

    expect(last.status).toBe("rejected");
    // 原话照登：屏幕上写的就是这一句，所以它必须说得出对不上在哪儿。
    expect(last.reason).toContain("对不上");
    expect(last.name).toBe("上周产品评审.txt");

    expect((await api.listDebriefs()).filter((d) => d.slotId === s.id)).toEqual([]);
    const summary = await summaryOf(a);
    expect(summary.debrief).toBeUndefined();
    // 这件议题一步都没往前走：它还在议题栏，等着他交一份对的。
    expect(isLiveIssue(summary)).toBe(true);

    const slot = (await slotById(s.id))!;
    // 判没用的那一份也存 —— 他最想点开看一眼的正是「我到底传了个什么」。
    expect(slot.transcript).toBe(NOT_A_MEETING);
    // 没提炼过，所以没有这一格（口径写在 `MeetingSlot.transcribedAt` 上）。
    expect(slot.transcribedAt).toBeUndefined();
  });

  it("换一份对的再交，上一次那句话不留在这一份上", async () => {
    /*
     * 不清的话，屏幕会照登一句说的是上一份材料的话 —— 而它此刻正压在一份已经提炼完的
     * 材料上面。
     */
    const a = await researchedIssue("重交一份对的");
    const s = await api.scheduleIssue(a, { date: dayN(10), half: "am" });
    expect((await ingest(s.id, NOT_A_MEETING)).last.status).toBe("rejected");

    const { last } = await ingest(s.id, TRANSCRIPT);
    expect(last.status).toBe("done");
    expect(last.reason).toBeUndefined();
    expect((await summaryOf(a)).debrief?.summary.length).toBeGreaterThan(0);
  });
});
