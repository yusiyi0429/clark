/**
 * `listActionItems()`——面板右栏的取数口：会后归**当前视角这个人**的执行项。
 *
 * 这个文件钉的是这个取数口存在的全部理由，一共四条：
 *
 *   · **点了他名字的那条要出现。**
 *   · **点了别人名字的那条不能出现**——认错人比不认更糟（理由见 `todo-assignee.ts`）。
 *   · **秘书按下「无需再议」（`confirmDebrief`）之后，这条仍然要出现。** 这是这个取数
 *     口区别于 `listDebriefs` 的全部理由：秘书那一下的意思是「这些结论认了」，事情这时
 *     才真正落到一号位头上，不该在这一刻从他的面板上消失。
 *   · **这一格是落库那一刻算好、存下来的，不是每次读的时候才现算。** 这条不直接对着
 *     屏幕，但它是 `assignedTo` 那份缓存存在的全部理由——真跑一遍才知道它真的被算了。
 *
 * 相三之后多钉一样：**每条 action item 上那一格「要不要他拍板」**（`principal`）。三条
 * 分支各一条用例——模型判了要他拍板的、判了不用的、以及**根本没有这一格的老记录**。
 * 第三条是这一相真正要保护的那一条：一号位立的规矩是「一条 action item 不许最后没有
 * 人在判它」，所以判不出来一律兜底成「归他」，宁可多摆一条到他面前。兜错方向的代价
 * 不对称——多给一条他扫一眼就划掉，少给一条则是一件只有他能定的事在他不知道的情况
 * 下被人替他定了，而屏幕上看不出少了什么。
 *
 * 造数据走的是真链路（`ingestMeetingNotes` → 提炼落库），假模型，同
 * `store.debrief-assign.test.ts`。**上一版这里为了绕过假模型「永远不填 owner」这条
 * 限制，加了一个测试专用的 `__setDebriefTodoOwnerForTest` 直接改库——那条路被指出
 * 两个问题：一是它把 `assignedTo` 删掉再靠读时兜底补回来，落库那一刻真正跑的那段
 * 计算（`extractAndLandDebriefs` 里 `todos: d.todos.map(...)` 那一段）反而从没被任何
 * 测试执行过；二是它往 `store.ts` 这份要发布的代码里加了一个只为单测存在的导出。
 * 两条都是真问题，已经删掉那个后门。**
 *
 * 真正的修法在假模型那一侧：`models/mock.ts` 的 `a7.debrief` 现在会读一遍转写正文，
 * 转写里如果真写着一号位自陈接下这件事的那句话（「我来」），就把它原样填进 `owner`；
 * 别的情况一如既往地不给。这不是在替假模型「多编一点东西」——上一版拒绝填 `owner`
 * 针对的是**凭空生成一个转写里根本没有的名字**，而回声一句转写里字面上就有的话，
 * 恰好是 A7 自己的规矩要求的那一半（`a7/debrief.ts`：「会上点了名就一定要填」）。
 * 于是「转写里点了名」这个事实现在真的能从真链路里造出来，三条断言不再需要绕过
 * `ingestMeetingNotes`，第四条（持久化时算好）也第一次有了能跑它的入口。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { nextDay } from "./agenda";

import type { api as Api, __seedResearchedIssueForTest as SeedResearched } from "./store";
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

/** 转写里真点了名——「我来」原样躺在正文里，假模型现在会把它原样搬进 `owner`。 */
const TRANSCRIPT_SELF_ASSIGNED =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "下一季度实测数据的采集口径，我来把它落成一页纸。散会。";

/** 点的是别人的名字——假模型不认识「小张」是谁，这一版也不该替它猜。 */
const TRANSCRIPT_NAMED_OTHER =
  "今天这场会先过第一件。成本那一档我们按台账上那句口径走，没有人拿出相反的数据。" +
  "下一季度实测数据的采集口径，小张来把它落成一页纸。散会。";

/**
 * 每条用例占一天，不共用会次——理由同 `store.debrief-assign.test.ts`：同一天同一个
 * 半天是同一场会，两条用例落在一个 slot 上的话，后一条读到的是前一条已经改过的那份。
 */
let dayCursor = 2;
const ownDay = (): string => {
  dayCursor += 1;
  let d = api.today;
  for (let i = 0; i < dayCursor; i += 1) d = nextDay(d);
  return d;
};

/** 一件已经被采信、并且前期调研做完的议题——同 `store.debrief-assign.test.ts`。 */
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
 * 一份刚提炼出来、还没被处置的会后提炼。转写由调用方给——同一条真链路，喂不同的话
 * 进去，才分得出「点了名」和「没点名/点了别人」这两种输入分别落成什么样。
 */
const freshDebrief = async (
  title: string,
  transcript: string,
): Promise<{ slotId: string; issueId: string; debrief: MeetingDebrief }> => {
  const issueId = await researchedIssue(title);
  const slot = await api.scheduleIssue(issueId, { date: ownDay(), half: "am" });
  await api.ingestMeetingNotes(slot.id, transcript);
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
  /*
   * 假模型固定两条待办，顺序也是固定的：第一条是只有一号位能做的选择
   * （`principal.needed` 为 true），第二条是路已经定了、剩下照着做的（false）。
   * 面板上下两层各要一条，理由写在 `models/mock.ts` 那一段罐头上面。
   */
  expect(debrief.todos.length).toBe(2);
  return { slotId: slot.id, issueId, debrief };
};

const CEO_ASSIGNEE = { personId: "PSN-01", name: "刘明华", confidence: "explicit" as const };

/**
 * 判不出来时兜底的那句原话（`a7/debrief.ts` 的 `resolvePrincipal`）。
 *
 * 在测试里写死这一句，是为了让「兜底」和「模型真判了要他拍板」分得开：两者的 `needed`
 * 都是 true，只有这句理由能证明走的是哪一条路。
 */
const FALLBACK_REASON = "没判出来 —— 先归到你这里";

describe("会后归他的那几条", () => {
  it("转写里真点了名（「我来」），落库那一刻就已经算好 assignedTo——不是读的时候才补", async () => {
    const { debrief } = await freshDebrief("我来做这件", TRANSCRIPT_SELF_ASSIGNED);
    /*
     * 这里直接看 `getDebrief()` 读回来的那一份，不经过 `listActionItems()`：这条断言
     * 要证明的是持久化那一刻（`extractAndLandDebriefs` 里的 `todos.map(...)`）已经把
     * `assignedTo` 算好存了下来，而不是靠 `listActionItems()` 自己的读时兜底补出来的。
     * 上一版用测试后门绕过假模型时，这条链路从没被任何测试真正跑过。
     */
    expect(debrief.todos[0].owner).toBe("我");
    expect(debrief.todos[0].assignedTo).toEqual(CEO_ASSIGNEE);
    // 卡面顶行标签同一条理由：假模型这一条给的是「成本口径拍板」，落库时原样收下。
    expect(debrief.todos[0].label).toBe("成本口径拍板");
  }, 20_000);

  it("点了一号位名字的那条，出现在结果里", async () => {
    const { slotId, issueId, debrief } = await freshDebrief(
      "点了我的名字",
      TRANSCRIPT_SELF_ASSIGNED,
    );
    const todoId = debrief.todos[0].id;

    const items = await api.listActionItems();
    const item = items.find((i) => i.id === todoId);
    expect(item).toBeDefined();
    expect(item!.assignedTo).toEqual(CEO_ASSIGNEE);
    // 顺带钉一下投影的其余几格：这是取数口的产出形状，不是这个取数口本身。
    expect(item!.text).toBe(debrief.todos[0].text);
    // 卡面顶行标签原样带出——不是取数口自己现算的。
    expect(item!.label).toBe(debrief.todos[0].label);
    expect(item!.issueId).toBe(issueId);
    expect(item!.slotId).toBe(slotId);
    expect(item!.debriefSummary).toBe(debrief.summary);
    // 同一场会同一件议题的另一条待办摆进 siblings —— sheet 上「它想到的」那一段用。
    expect(item!.siblings).toEqual([
      { id: debrief.todos[1].id, text: debrief.todos[1].text },
    ]);
  }, 20_000);

  it("点了别人名字的那条，不出现——认错人比不认更糟", async () => {
    const { debrief } = await freshDebrief("点了小张的名字", TRANSCRIPT_NAMED_OTHER);
    const todoId = debrief.todos[0].id;
    // 转写里点的是「小张」，假模型不认识这个人，压根不会填 owner——这正是这一版
    // 该有的样子：宁可不填，也不替它猜一个可能猜错的人。
    expect(debrief.todos[0].owner).toBeUndefined();
    expect(debrief.todos[0].assignedTo).toBeUndefined();

    const items = await api.listActionItems();
    expect(items.find((i) => i.id === todoId)).toBeUndefined();
  }, 20_000);

  it("秘书按下「无需再议」之后，这条仍然出现——这是这个取数口存在的全部理由", async () => {
    const { slotId, issueId, debrief } = await freshDebrief(
      "确认之后还在",
      TRANSCRIPT_SELF_ASSIGNED,
    );
    const todoId = debrief.todos[0].id;

    const before = await api.listActionItems();
    expect(before.find((i) => i.id === todoId)).toBeDefined();

    await api.confirmDebrief(slotId, issueId);

    // `listDebriefs`（相一那一屏）答的是「还压在秘书那儿的」，确认完这一份会从那里消失；
    // 而这个取数口答的是「这几件事此刻是不是他的」，答案不因为秘书确认过而改变。
    const after = await api.listActionItems();
    const item = after.find((i) => i.id === todoId);
    expect(item).toBeDefined();
    expect(item!.assignedTo?.personId).toBe("PSN-01");
  }, 20_000);
});

describe("这条要不要他拍板", () => {
  it("模型判了要他拍板的那条，带着它自己那句理由到面板上——不是被兜底推上来的", async () => {
    const { debrief } = await freshDebrief("要他拍板的那条", TRANSCRIPT_SELF_ASSIGNED);
    const todo = debrief.todos[0];

    // 落库那一刻就已经存下来了，和 `assignedTo` 同一段代码、同一条理由。
    expect(todo.principal).toEqual({ needed: true, reason: expect.any(String) });

    const items = await api.listActionItems();
    const item = items.find((i) => i.id === todo.id);
    expect(item).toBeDefined();
    expect(item!.principal.needed).toBe(true);
    /*
     * 这两条断言缺一不可。只看 `needed === true` 的话，一条**被兜底推上来的**待办也能
     * 让它变绿——而兜底和「模型真判了要他拍板」是两件事：前者说的是这一轮没判出来，
     * 后者说的是判过了、结论是要他定。屏幕上这两句话不一样，这里也不该混。
     */
    expect(item!.principal.reason).toBe(todo.principal!.reason);
    expect(item!.principal.reason).not.toBe(FALLBACK_REASON);
  }, 20_000);

  it("模型判了不用他拍板的那条，照实是 false——兜底不许把它一起推上去", async () => {
    const { debrief } = await freshDebrief("不用他拍板的那条", TRANSCRIPT_SELF_ASSIGNED);
    const todo = debrief.todos[1];

    expect(todo.principal?.needed).toBe(false);

    const items = await api.listActionItems();
    const item = items.find((i) => i.id === todo.id);
    /*
     * 这一条同样归他（转写里他自陈接了活），所以它**在**面板上——只是在下面那一层。
     * 「不用他拍板」不等于「不是他的事」：两样分开判，混成一个的话，他自己要做的杂事
     * 会和一件待定的选择摆在同一层，而那正是相三要拆开的那件事。
     */
    expect(item).toBeDefined();
    expect(item!.principal.needed).toBe(false);
    expect(item!.principal.reason).toBe(todo.principal!.reason);
  }, 20_000);

  it("库里那一格根本没有的老记录，读出来是「归他」——一条都不许静静消失", async () => {
    const { slotId, issueId, debrief } = await freshDebrief(
      "没有这一格的老记录",
      TRANSCRIPT_SELF_ASSIGNED,
    );

    /*
     * 造一份「相三之前落的库」出来，走的是真写口：`updateDebrief` 整份重建 todos，
     * 而它只收 `text / owner / due` 三样——重建出来的那一条身上没有 `principal`，
     * 形状和这一格加进来之前落的记录一模一样。**不开测试后门**（上一版那个
     * `__setDebriefTodoOwnerForTest` 已经因为同样的理由删掉了，见文件开头）。
     *
     * 这条路依赖 `updateDebrief` 不带回 `principal` 这件事。哪天那一段改成把它按位置
     * 带回来（像 `checked` 那样），这条用例要换一条造老记录的路，而不是删掉——它钉的
     * 是读口的兜底，不是那个写口的行为。
     */
    await api.updateDebrief(slotId, issueId, {
      todos: [{ text: debrief.todos[0].text, owner: "我" }],
    });

    const stored = await api.getDebrief(slotId, issueId);
    const todo = stored!.todos[0];
    // 先钉住前提：这一条现在确实没有那一格。前提塌了的话，下面那条断言会变成一句空话。
    expect(todo.principal).toBeUndefined();

    const items = await api.listActionItems();
    const item = items.find((i) => i.id === todo.id);
    expect(item).toBeDefined();
    // 判不出来就摆到他面前，并且照实说是没判出来——不假装这是一次判断的结果。
    expect(item!.principal).toEqual({ needed: true, reason: FALLBACK_REASON });
  }, 20_000);
});
