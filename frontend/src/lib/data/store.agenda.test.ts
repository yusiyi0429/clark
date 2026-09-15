/**
 * 排会与会后提炼，对象库这一头。
 *
 * 这里钉的是**聚类这件事在数据层是不是真的只有一句话**：给两件议题定同一天的同一半天，
 * 库里必须只长出一场会。屏幕上那个「同一场会画在一起」是这条规则的投影 —— 规则不成立
 * 的话，视图层就会开始长出合并逻辑，而那种逻辑一旦存在，「看着是一场、其实是两条」就
 * 迟早会出现，并且在屏幕上看不出来。
 *
 * 粒度从「几点到几点」降到「上午 / 下午」之后，另外几条跟着变成必须钉住的：
 *
 *   · **改半天是先摘再排**，一件议题只可能在一场会上。
 *   · **摘空的会要消失** —— 留着的话它会占掉一个 `seq`，后面每一场的颜色都往后串一位，
 *     看起来像颜色自己会变。唯一的例外是已经交过材料的那一场：那上面挂着提炼。
 *   · **散会由他按下的那一下说，不由时钟说**（`endMeetingSlot` → `slot.ended`）。会后
 *     那整条链路（交材料、提炼、确认）都挂在它后面，所以它必须有一个确定的答案。
 *   · **确认和还需再议是并排的两个出口**：前者把议题推到已部署，后者退回去等下一场。
 *     合成一个「处理过了」的话，屏幕上就分不出「这件事定了」和「这件事还要再谈一次」——
 *     而那正是他刚刚做出的那个判断。
 *   · **他处置过的那一份不许被重跑盖掉**：那上面已经有他自己的字，也已经有他按下的
 *     那一次判断。
 *
 * 每条断言都从公开读口取（`listSlots` / `listIssues` / `listDebriefs`），一处内部状态
 * 都不摸 —— 断的是屏幕真正依赖的东西（同 `__getCardForTest` 那段注释的理由）。所以也
 * 没有 `beforeEach` 里的清库：每条用例自己拿新的议题号和不撞车的那一格。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { nextDay } from "./agenda";

import type {
  api as Api,
  __backdateSlotForTest as Backdate,
  __seedResearchedIssueForTest as SeedResearched,
} from "./store";
import type { ResearchDoc } from "./types";

let api: typeof Api;
let seedResearched: typeof SeedResearched;
/**
 * 把一场会挪到过去。**只有这一个口能造出「已经过去的那一格」** —— `scheduleIssue`
 * 现在不让排到过去，而这几条用例要验的恰恰是排完之后时间走过去了会怎么样。
 */
let __backdateSlotForTest: typeof Backdate;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照（同 store.remove-issue.test.ts）。
  process.env.TKOS_PERSIST = "0";
  // 会后提炼要叫一次模型。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  seedResearched = mod.__seedResearchedIssueForTest;
  __backdateSlotForTest = mod.__backdateSlotForTest;
});

/** 一件新议题。`addIssue` 顺手起的那一轮预研在假模型下就地失败，与这里每一条断言无关。 */
const newIssue = async (title: string): Promise<string> => (await api.addIssue(title)).id;

/**
 * 一件「前期调研已经做完」的议题 —— 报告写什么无关，这里只看那一格在不在。
 *
 * 绝大多数用例都得从这儿开始：**没到手研究的议题现在根本排不进会**，而那正是下面第一
 * 条断言要钉的东西。
 */
const researchedIssue = async (title: string): Promise<string> => {
  const id = await newIssue(title);
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
  return id;
};

/**
 * 往后数第 n 天。**每条用例占一个 n，互不撞车。**
 *
 * 原来这里是写死的 `2026-09-04`、`2026-09-05`……那时日期只是「不撞车」的编号，排哪一天
 * 对断言毫无影响。2026-08-30 之后不再是这样了：「这一格过去了没有」现在由时钟判
 * （见 `slotPast`），排在过去的那一格根本收不进议题。写死的日期意味着这个文件在
 * 2026-09-04 那天开始一条一条地红，而红的原因和它要验的东西一点关系都没有。
 *
 * 从 `api.today` 往后数，就永远排在将来。n 从 4 起，接着原来那串编号，省得每条用例
 * 重新分一遍。
 */
const dayN = (n: number): string => {
  let d = api.today;
  for (let i = 0; i < n; i += 1) d = nextDay(d);
  return d;
};

const slotById = async (id: string) => (await api.listSlots()).find((s) => s.id === id);
const summaryOf = async (issueId: string) =>
  (await api.listIssues()).find((i) => i.id === issueId)!;
const pendingDebriefOf = async (issueId: string) =>
  (await api.listDebriefs()).find((d) => d.issueId === issueId);

const TRANSCRIPT =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "第二件先放着，下一季度实测数据到了再说。散会。";

/**
 * 交一份材料，**等它跑完**。
 *
 * `ingestMeetingNotes` 现在收下就返回，判材料和按议题提炼都在后台跑（那一块要留在议题栏
 * 原地不动地跑，屏幕得立刻拿到状态）。所以这个文件里每一处「交完材料之后」的断言都得先
 * 等这一轮落地 —— 不等的话，红的那一下和它要验的东西没有关系。
 *
 * 等的方式是**问公开读口**，不摸任务表：屏幕上那块流动的底问的就是这一句，测试等的和
 * 它等的是同一个事实。
 */
const ingest = async (slotId: string, name?: string) => {
  await api.ingestMeetingNotes(slotId, TRANSCRIPT, name);
  for (let i = 0; i < 300; i += 1) {
    const st = await api.slotIntakeState(slotId);
    if (st.status !== "checking" && st.status !== "summarizing") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${slotId} 的材料一直没跑完。`);
};

describe("同一天的同一半天就是同一场会", () => {
  it("两件议题排到同一格，库里只长出一场", async () => {
    const a = await researchedIssue("同场测试 A");
    const b = await researchedIssue("同场测试 B");
    const at = { date: dayN(4), half: "am" } as const;
    const first = await api.scheduleIssue(a, at);
    const second = await api.scheduleIssue(b, at);
    // 两次排会拿到的是同一条。不成立的话屏幕上会画出两块色块，而两块看着都对。
    expect(second.id).toBe(first.id);
    expect((await slotById(first.id))!.issueIds).toEqual([a, b]);
  });

  it("上午和下午是两场 —— 同一天的两格互不相干", async () => {
    const a = await researchedIssue("半天测试 A");
    const b = await researchedIssue("半天测试 B");
    const am = await api.scheduleIssue(a, { date: dayN(5), half: "am" });
    const pm = await api.scheduleIssue(b, { date: dayN(5), half: "pm" });
    expect(am.id).not.toBe(pm.id);
    expect((await slotById(am.id))!.issueIds).toEqual([a]);
    expect((await slotById(pm.id))!.issueIds).toEqual([b]);
  });

  it("并进已有的一场，不用抄那两个字段", async () => {
    // 屏幕上那颗「并到这一场」只有一个 slotId 在手。让它自己去抄日期和半天，抄错一位
    // 就会新开一场看着一样的会。
    const a = await researchedIssue("并场测试 A");
    const b = await researchedIssue("并场测试 B");
    const first = await api.scheduleIssue(a, { date: dayN(6), half: "am" });
    const after = await api.joinSlot(b, first.id);
    expect(after.id).toBe(first.id);
    expect(after.issueIds).toEqual([a, b]);
  });

  it("前期调研没到手的排不进去，拒的那句话能直接上屏", async () => {
    /*
     * 屏幕上那几件本来就没有排会的入口，这里再挡一道是因为**拖拽也能排** —— 两条路
     * 必须落在同一个判据上（`readyForMeeting`）。分家之后会出现「键是灰的、但拖得进去」，
     * 而那种不一致没人看得出来是有意还是坏了。
     */
    const plain = await newIssue("还没查的那一件");
    expect((await summaryOf(plain)).readyForMeeting).toBe(false);
    await expect(
      api.scheduleIssue(plain, { date: dayN(7), half: "am" }),
    ).rejects.toThrow(/前期调研/);
    const done = await researchedIssue("已经查完的那一件");
    expect((await summaryOf(done)).readyForMeeting).toBe(true);
    await expect(api.scheduleIssue(done, { date: dayN(7), half: "am" })).resolves.toBeTruthy();
  });
});

describe("一件议题只可能在一场会上", () => {
  it("改半天是先摘再排 —— 不是在两格上各留一份", async () => {
    const a = await researchedIssue("改半天测试");
    const before = await api.scheduleIssue(a, { date: dayN(8), half: "am" });
    await api.scheduleIssue(a, { date: dayN(8), half: "pm" });
    // 原来那一格空了，自己消失。
    expect(await slotById(before.id)).toBeUndefined();
    expect((await summaryOf(a)).slot?.half).toBe("pm");
  });

  it("摘空的会自己消失 —— 不然它会占掉一个 seq，后面每一场的颜色都往后串一位", async () => {
    const a = await researchedIssue("撤会测试");
    const s = await api.scheduleIssue(a, { date: dayN(9), half: "am" });
    await api.unscheduleIssue(a);
    expect(await slotById(s.id)).toBeUndefined();
    expect((await summaryOf(a)).slot).toBeUndefined();
  });

  it("同场还有别人时只摘走这一件，会还在", async () => {
    const a = await researchedIssue("同场撤会 A");
    const b = await researchedIssue("同场撤会 B");
    const at = { date: dayN(10), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    await api.unscheduleIssue(a);
    expect((await slotById(s.id))!.issueIds).toEqual([b]);
  });

  it("没排过的撤一次不报错 —— 撤销这个动作本来就该是幂等的", async () => {
    const a = await researchedIssue("幂等撤会测试");
    await expect(api.unscheduleIssue(a)).resolves.toEqual({ issueId: a });
  });
});

describe("摘要上那一格", () => {
  it("排上会之后带着哪一天的哪半天、同场几件、这件是第几件", async () => {
    // 议题卡片照这几个字画那一行「明天下午 · 同场 2 件之 1」，它不该回头去问会议表。
    const a = await researchedIssue("摘要测试 A");
    const b = await researchedIssue("摘要测试 B");
    const at = { date: dayN(11), half: "pm" } as const;
    await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    expect((await summaryOf(a)).slot).toMatchObject({
      date: dayN(11),
      half: "pm",
      size: 2,
      index: 1,
      ended: false,
    });
    expect((await summaryOf(b)).slot).toMatchObject({ size: 2, index: 2 });
  });

  it("同一场会上的两件，颜色序号必须相同", async () => {
    // 颜色在这里承担的全部意思就是「这两件是同一场」。不同就等于屏幕在说假话。
    const a = await researchedIssue("同色测试 A");
    const b = await researchedIssue("同色测试 B");
    const at = { date: dayN(12), half: "am" } as const;
    await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    expect((await summaryOf(a)).slot!.seq).toBe((await summaryOf(b)).slot!.seq);
  });
});

describe("请一个域的人到场", () => {
  it("能加、也能撤", async () => {
    /*
     * 这个字段只补一种情况：某个域的 DRI 要来，但他手上没有议题在这场会上。加完撤不掉
     * 的话，屏幕上就多出一枚按不动的标记 —— 而那种东西没人知道该怎么弄掉。
     */
    const a = await researchedIssue("请人测试");
    const s = await api.scheduleIssue(a, { date: dayN(13), half: "am" });
    const on = await api.inviteDomain(s.id, "D-05", true);
    expect(on.extraDomainIds).toEqual(["D-05"]);
    const off = await api.inviteDomain(s.id, "D-05", false);
    expect(off.extraDomainIds).toEqual([]);
  });

  it("已经有议题在场的域不许再加一遍", async () => {
    /*
     * 参会域默认是算出来的（会上那几件议题各自的域）。这个域本来就在场，再往
     * `extraDomainIds` 里加一份的话，撤的时候撤掉的是那一份、屏幕上那枚标记却仍然由
     * 议题贡献着 —— 于是它变成一枚按不动的标记。
     */
    const a = await researchedIssue("重复域测试");
    // PSN-02（白田田）是 D-03 Method 的负责人，派人这一下顺手把议题归到 D-03 上。
    await api.assignIssue(a, "PSN-02");
    expect((await summaryOf(a)).domainId).toBe("D-03");
    const s = await api.scheduleIssue(a, { date: dayN(14), half: "am" });
    await expect(api.inviteDomain(s.id, "D-03", true)).rejects.toThrow(/已经有议题/);
  });
});

describe("散会由他按下的那一下说", () => {
  it("按第二下什么都不做 —— 他和秘书同时开着这一屏时都可能按", async () => {
    const a = await researchedIssue("幂等结束测试");
    const s = await api.scheduleIssue(a, { date: dayN(15), half: "am" });
    const first = await api.endMeetingSlot(s.id);
    expect(first.endedAt).toBeTruthy();
    const again = await api.endMeetingSlot(s.id);
    // 时刻不许被第二下改写：会后那条链路上的每一步都以它为起点。
    expect(again.endedAt).toBe(first.endedAt);
  });

  it("一件议题都没有的会不给标结束", async () => {
    /*
     * 一场会只有交过材料才可能是空的（摘空的会本来会自己消失，交过材料的那一场不删 ——
     * 那几份提炼是按 slotId 存的）。标它结束没有任何意义，而屏幕上会因此出现一场
     * 「开完了、零件议题」的会。
     */
    const a = await researchedIssue("空会测试");
    const s = await api.scheduleIssue(a, { date: dayN(16), half: "am" });
    await ingest(s.id);
    await api.unscheduleIssue(a);
    expect((await slotById(s.id))!.issueIds).toEqual([]);
    await expect(api.endMeetingSlot(s.id)).rejects.toThrow(/一件议题都没有/);
  });

  it("标记之后，会上那几件在摘要里都变成「已开完」", async () => {
    // 卡片上「在等开会」和「在等你确认会后要点」是两种完全不同的样子，只差这一个布尔。
    const a = await researchedIssue("结束投影 A");
    const b = await researchedIssue("结束投影 B");
    const at = { date: dayN(17), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    expect((await summaryOf(a)).slot!.ended).toBe(false);
    await api.endMeetingSlot(s.id);
    expect((await summaryOf(a)).slot!.ended).toBe(true);
    expect((await summaryOf(b)).slot!.ended).toBe(true);
  });

  it("已经开完的那一格不再收新议题 —— 要谈就排下一场", async () => {
    /*
     * 收进去的话，这件议题会立刻显示成「在等你确认会后要点」，而那场会上根本没谈过它。
     */
    const a = await researchedIssue("已结束不收 A");
    const c = await researchedIssue("已结束不收 C");
    const at = { date: dayN(18), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.endMeetingSlot(s.id);
    await expect(api.scheduleIssue(c, at)).rejects.toThrow(/已经开完/);
    expect((await slotById(s.id))!.issueIds).toEqual([a]);
  });
});

describe("过去了的那一格", () => {
  /**
   * 往回数第 n 天。**这个 describe 里唯一往回数的地方** —— 别处都在将来。
   *
   * 数得远一点（10 天以上）：预载的那套案例里就有昨天下午的一场会，撞上去的话这几条
   * 用例验的就变成了那一场，而它自己带着纪要。
   */
  const backN = (n: number): string => {
    const [y, m, d] = api.today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };

  it("排不进去 —— 拒的那句话能直接上屏", async () => {
    /*
     * 这一条挡的是拖拽落错和两个人同时在改。屏幕上那两格本来就不给落（编排页只把还没
     * 过去的那一格注册成落区，见 `DayBoard`），但那是屏幕上的一道闩 —— 数据层不能靠
     * 屏幕守着。
     */
    const a = await researchedIssue("过去了排不进 A");
    await expect(
      api.scheduleIssue(a, { date: backN(11), half: "pm" }),
    ).rejects.toThrow(/已经过去/);
    expect((await summaryOf(a)).slot).toBeUndefined();
  });

  it("到点了就算结束 —— 没人按过那一下也一样", async () => {
    /*
     * 这是 2026-08-30 换掉的那条规则。原来只有 `endMeetingSlot` 能让 `ended` 变真，于是
     * 他忘了按，那几件议题第二天还躺在「可以排会」的清单里 —— 屏幕上没有一处说得出这场
     * 会昨天就该开完了。
     *
     * 从库里直接摆一场昨天的会（`scheduleIssue` 现在不让排到过去，这是唯一的造法）。
     */
    const a = await researchedIssue("到点算结束 A");
    const s = await api.scheduleIssue(a, { date: dayN(40), half: "am" });
    expect((await summaryOf(a)).slot!.ended).toBe(false);

    __backdateSlotForTest(s.id, backN(11));
    const after = await summaryOf(a);
    expect(after.slot!.ended).toBe(true);
    // 没人按过 —— `endedAt` 仍然是空的。两条判据是「或」，不是把一条写进另一条。
    expect((await slotById(s.id))!.endedAt).toBeUndefined();
  });
});

describe("这场会没开", () => {
  const backN = (n: number): string => {
    const [y, m, d] = api.today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };

  it("整场撤掉，上面那几件原样回到议题清单里", async () => {
    /*
     * 时钟不知道这场会有没有真的开。没有这一口，一场被取消的会会把它上面的议题永远卡在
     * 「等一份不会来的纪要」上：它们不在议题栏里（已经挪走了），而屏幕上也没有入口把它们
     * 拖回去。
     */
    const a = await researchedIssue("未召开 A");
    const b = await researchedIssue("未召开 B");
    const at = { date: dayN(41), half: "pm" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    __backdateSlotForTest(s.id, backN(11));
    expect((await summaryOf(a)).slot!.ended).toBe(true);

    const out = await api.cancelMeetingSlot(s.id);
    expect(out.issueIds.sort()).toEqual([a, b].sort());

    // 两件都回到「没排会」的样子 —— 于是它们又出现在议题栏和编排页的待排清单里。
    expect((await summaryOf(a)).slot).toBeUndefined();
    expect((await summaryOf(b)).slot).toBeUndefined();
    // 一场没开过的会在账上不留痕：日程里没有它了。
    expect(await slotById(s.id)).toBeUndefined();
    // 留痕留在议题各自的时间线上 —— 那才是可查的地方。
    const line = await api.getTimeline(a);
    expect(line.some((e) => e.headline?.includes("会议未召开"))).toBe(true);
  });

  it("已经有纪要的撤不掉 —— 那时它已经开过了", async () => {
    /*
     * 撤掉等于把一场有产出的会从账上抹掉。要退回研究中，那是「还需再议」那条路，
     * 而那一条会留下「这件事又要谈一次」的记录。
     */
    const a = await researchedIssue("有纪要撤不掉 A");
    const s = await api.scheduleIssue(a, { date: dayN(42), half: "am" });
    await api.endMeetingSlot(s.id);
    await ingest(s.id);
    await expect(api.cancelMeetingSlot(s.id)).rejects.toThrow(/已经有纪要/);
    expect((await summaryOf(a)).slot).toBeTruthy();
  });
});

describe("会后提炼", () => {
  it("一场会过了几件议题就出几份，各自只说自己那一件", async () => {
    // 合成一份的话，他在议题卡片上看到的是另外两件事的待办 —— 而他此刻正在决定这一件。
    const a = await researchedIssue("提炼测试 A");
    const b = await researchedIssue("提炼测试 B");
    const at = { date: dayN(19), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    await ingest(s.id);
    const pending = (await api.listDebriefs()).filter((d) => d.slotId === s.id);
    expect(pending.map((d) => d.issueId).sort()).toEqual([a, b].sort());
  });

  it("卡面要的那几段都落下来了：一句概述、几条要点、还没定的、谈拢了没有", async () => {
    /*
     * 这四段是会后确认那张卡的全部内容，缺哪一段都会让那张卡在屏幕上塌掉一块：
     * 概述空了卡就没有开头；`open` 丢了，一份读起来样样都定了的纪要会让他以为共识
     * 已经达成；`consensus` 缺了，卡上默认高亮哪一颗键就没有依据。
     */
    const a = await researchedIssue("形状测试");
    const s = await api.scheduleIssue(a, { date: dayN(20), half: "am" });
    await ingest(s.id, "会议录音.wav");
    const d = (await pendingDebriefOf(a))!;
    expect(d.summary.length).toBeGreaterThan(0);
    expect(d.points.length).toBeGreaterThan(0);
    expect(d.points.every((p) => p.text.length > 0)).toBe(true);
    expect(typeof d.consensus.reached).toBe("boolean");
    expect(d.consensus.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(d.open)).toBe(true);
    // 边界跟着要点走，不并成另一段 —— 分家之后读的人得自己把它们对回去。
    expect(d.points.some((p) => typeof p.boundary === "string" && p.boundary.length > 0)).toBe(
      true,
    );
  });

  it("落下来之后挂在议题摘要上，不用点进去就看得见", async () => {
    const a = await researchedIssue("挂摘要测试");
    const s = await api.scheduleIssue(a, { date: dayN(21), half: "am" });
    await ingest(s.id);
    const summary = await summaryOf(a);
    expect(summary.debrief?.summary.length).toBeGreaterThan(0);
    expect(summary.debrief?.points.length).toBeGreaterThan(0);
  });

  it("太短的记录不收 —— 提炼不出东西来", async () => {
    const a = await researchedIssue("太短测试");
    const s = await api.scheduleIssue(a, { date: dayN(22), half: "am" });
    await expect(api.ingestMeetingNotes(s.id, "散会")).rejects.toThrow();
  });

  it("他改过字之后那一份标上 editedAt，边界和未决都改得动", async () => {
    /*
     * 「AI 补全 · 待核」这枚标记的含义是「这句没人认过」。他亲手改完之后再挂着它，
     * 就是屏幕在说假话。边界和未决那两段是展开里的东西，改不动的话他只能整条删掉重写。
     */
    const a = await researchedIssue("改字测试");
    const s = await api.scheduleIssue(a, { date: dayN(23), half: "am" });
    await ingest(s.id);
    await api.updateDebrief(s.id, a, {
      points: [{ text: "他自己改过的那一句", boundary: "只管这一条产品线" }],
      open: ["下一轮要带实测数据回来"],
    });
    const d = (await pendingDebriefOf(a))!;
    expect(d.editedAt).toBeTruthy();
    expect(d.points.map((p) => p.text)).toEqual(["他自己改过的那一句"]);
    expect(d.points[0].boundary).toBe("只管这一条产品线");
    expect(d.open).toEqual(["下一轮要带实测数据回来"]);
  });

  it("确认下来 —— 这一件推到已部署，也从日程上摘下来", async () => {
    /*
     * 会后确认是这件议题在他这里的**最后一次处置**：他认下这场会的结论，这件事就不再
     * 压在他身上。不推状态也不摘会的话，屏幕上会出现一件「会开完了、要点也认了、却还
     * 挂在议题栏里等着排下一场会」的东西，而没有任何动作能让它离开那一栏。
     */
    const a = await researchedIssue("确认测试");
    const s = await api.scheduleIssue(a, { date: dayN(24), half: "am" });
    await ingest(s.id);
    expect(await pendingDebriefOf(a)).toBeTruthy();

    await api.confirmDebrief(s.id, a);
    // 首页那一叠摞着的卡片摊的就是待处置的那几份 —— 认完之后它不再是一件待办。
    expect(await pendingDebriefOf(a)).toBeUndefined();
    const summary = await summaryOf(a);
    expect(summary.settled).toBe(true);
    expect(summary.slot).toBeUndefined();
    expect(summary.debrief).toBeUndefined();
  });

  it("还需再议 —— 同样摘下来，但这件事没有定", async () => {
    /*
     * 它和「确认」是并排的两条路，不是「不确认」。一件议题常常要开几次会才谈拢，而他
     * 接下来要做的恰恰是给它排新的一场：不摘的话它还挂在一场已经开完的会下面，摘了
     * 却顺手标成已部署的话，一件根本没谈拢的事会从议题栏里消失。
     */
    const a = await researchedIssue("再议测试");
    const s = await api.scheduleIssue(a, { date: dayN(25), half: "am" });
    await ingest(s.id);
    await api.reopenDebrief(s.id, a);
    expect(await pendingDebriefOf(a)).toBeUndefined();
    const summary = await summaryOf(a);
    expect(summary.settled).toBe(false);
    expect(summary.slot).toBeUndefined();
  });

  it("他处置过的那一份，重传一次录音不会把它送回他那一叠", async () => {
    /*
     * 秘书把同一场会的材料重传一遍是常事（第一份转写漏了一段）。重跑会盖掉还没处置的
     * 那几份 —— 那是对的，它们上面还没有他的字。但**已经处置过的不许盖**：盖掉的是他
     * 自己按下去的那一次判断，而屏幕上的表现只是「那张卡又摞回来了」，看着像他忘了按。
     */
    const a = await researchedIssue("不覆盖测试 A");
    const b = await researchedIssue("不覆盖测试 B");
    const at = { date: dayN(26), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    await ingest(s.id);
    await api.updateDebrief(s.id, a, { points: [{ text: "他自己改过的那一句" }] });
    await api.confirmDebrief(s.id, a);
    await api.reopenDebrief(s.id, b);

    // 判了「还需再议」的那一件仍然要开下一场，他先把它放回这一格上；然后录音重传。
    await api.scheduleIssue(b, at);
    await ingest(s.id);

    expect(await pendingDebriefOf(a)).toBeUndefined();
    expect(await pendingDebriefOf(b)).toBeUndefined();
  });
});

describe("拖出来的顺序", () => {
  it("整串写回，排在最前的那件 rank 是 0", async () => {
    const a = await newIssue("排序测试 A");
    const b = await newIssue("排序测试 B");
    await api.reorderAgenda([b, a]);
    expect((await summaryOf(b)).agendaRank).toBe(0);
    expect((await summaryOf(a)).agendaRank).toBe(1);
  });

  it("同一场会里拖动要落到那场会自己的议程上，否则松手会弹回去", async () => {
    // 会内次序由 `slot.issueIds` 说了算（`agendaCompare` 先比它）。不同步的话，他把
    // 第二件拖到第一，松手之后它会弹回去 —— 而弹回去看着就像拖拽坏了。
    const a = await researchedIssue("会内排序 A");
    const b = await researchedIssue("会内排序 B");
    const at = { date: dayN(27), half: "am" } as const;
    const s = await api.scheduleIssue(a, at);
    await api.scheduleIssue(b, at);
    await api.reorderAgenda([b, a]);
    expect((await slotById(s.id))!.issueIds).toEqual([b, a]);
  });
});
