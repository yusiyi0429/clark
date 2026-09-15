/**
 * 屏幕上那行「走到第几步、已经跑了多久」的接线。
 *
 * 这一层钉的是**那三个字段是从任务表读出来的，不是编的**。步骤本身由链路上报（A3 两步；
 * A4 整轮四步 —— 装配上下文 → 三条链路各自研究 → 压成四节 → 反证复核，而三条链路在自己
 * 那一栏里各再走四步，没配检索 key 时那四步缩成两步；常量在 `a3/run.ts`、`a4/run.ts` 里，
 * 那里就是它们唯一的出处）。单测里出不了网、造不出一轮真的
 * 跑成的深研，所以这里直接把任务表摆成要验的样子 —— 和 `store.triggers.test.ts` 里
 * 造「A5 就地失败」那一处同一个手法。
 *
 * 最要紧的一条是最后那两个：**没有一轮在跑的时候，这三个字段必须全空**。屏幕拿
 * 「有没有起点」当「要不要呼吸」的判据，编一个进去就等于让一格呼吸的字代表一件没有
 * 任何人在做的事，而一号位会一直等它。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { clearTask, runTask, taskReports, taskState, taskStep } from "@/lib/agent/tasks";
import type { DraftReport } from "./types";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

const settle = async (get: () => Promise<{ status: string }>) => {
  for (let i = 0; i < 100; i++) {
    const st = await get();
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("任务两秒还没跑完 —— 假模型下不该发生");
};

/** 摆一轮不会自己结束的任务出来，返回收尾的把手。 */
const hold = (kind: string, id: string) => {
  let end!: () => void;
  runTask(kind, id, () => new Promise<{ attempts?: number }>((r) => (end = () => r({}))));
  return () => end();
};

/**
 * 摆一步真实存在的：`a4/run.ts` 的 `STEPS.digest` —— **整轮**那四步里的第三步（三条链路
 * 各自那四步是另一套分母，见下面那组用例）。这一层验的是「屏幕上那行字是从任务表读出来
 * 的」，不是那两个数算得对不对 —— 序号与分母由链路自己算，把它抄成常量再断言等于把算法
 * 搬到测试里。
 */
const STEP = { label: "压成四节", no: 3, total: 4, at: "2026-08-20T10:00:00.000Z" };

describe("深研：议题清单和首页那一行", () => {
  it("在跑的那一轮带着步骤原话和起点", async () => {
    const issue = await api.addIssue("要不要把交付这件事从项目制改成产品制");
    const end = hold("deep", issue.id);
    taskStep("deep", issue.id, STEP);

    const mine = (await api.listIssues()).find((i) => i.id === issue.id);
    expect(mine?.research).toMatchObject({ state: "running", step: STEP });
    // 起点，不是「已经跑了多少秒」：秒数由屏幕自己走（见 `IssueResearchStatus`）。
    expect(mine?.research.state === "running" && mine.research.startedAt).toBeTruthy();
    end();
  });

  it("跑挂了那一行不许还在呼吸 —— 失败之后没有任何人在跑", async () => {
    const issue = await api.addIssue("要不要把交付的验收标准收敛成一份");
    /*
     * 走真的那条路开一轮（`startDeepResearch` → `ensureDeepResearch`）：它会先往
     * 深研的 job 表里记一笔，而单测里这一轮必然在第一步挂掉（出不了网）。那一笔
     * 不会跟着失败一起消失 —— 这条断言钉的就是它不许把失败读成「进行中」。
     */
    await api.startDeepResearch(issue.id);
    expect((await settle(() => api.deepResearchStatus(issue.id))).status).toBe("failed");

    const mine = (await api.listIssues()).find((i) => i.id === issue.id);
    expect(mine?.research).toEqual({ state: "idle" });
    // 为什么挂的仍答得出来，只是不由首页那一行来说。
    expect((await api.deepResearchStatus(issue.id)).error).toBeTruthy();
  });

  it("没人在跑就是 idle，不许有步骤也不许有起点", async () => {
    const issue = await api.addIssue("要不要把客户续约的口径统一到一个人手上");
    // 这件议题从没起过深研 —— 采信那一下才起（见 `store.triggers.test.ts`）。
    expect(await api.listIssues().then((l) => l.find((i) => i.id === issue.id)?.research)).toEqual({
      state: "idle",
    });
  });
});

/**
 * 还在跑的时候就摆上页签行的那三条链路。
 *
 * 三条链路（DeepSeek / Claude / ChatGPT）同时起跑，各自编命题、各自联网取证、各自写报告，
 * 一条要跑十几分钟而三条不会同时结束；某一条写完时整轮还剩两步（压成四节、反证复核）。
 * 全部落库才上页签的话，他对着一句「深度研究还在装配」等二十分钟。所以每条链路一边跑一边
 * 把自己的样子交给任务表（`Harness.reports`），页签行从那里读。这里钉的是读的那一头：
 * `listReports` 把草稿摊成页签，形状对得上落库之后那几栏。
 *
 * 夹具把三种状态一次摆齐 —— **写完的、在跑的、挂了的**。三种在屏幕上是三副面孔（能读的
 * 原文 / 自己的秒表和步号 / 那句失败原话），而它们共用同一个 `DraftReport` 形状，所以哪
 * 一种被读错都不会有别的地方报错。
 */
describe("深研还在跑：页签行上那三条链路", () => {
  /*
   * 页签顺序就是链路表的顺序（`a4/run.ts` 的 `LANES`）：DeepSeek、Claude、ChatGPT。主源是
   * ChatGPT 那一条，所以它的 key 是 `agent` —— **key 跟着身份走，不跟着位置走**，这也是
   * 这里故意把 `agent` 摆在最后一项的原因。
   */
  const drafts: DraftReport[] = [
    // 还在跑：这一条自己走到第 2/4 步。分母是**链路**那四步，不是整轮那四步。
    {
      key: "agent:alt0",
      label: "DeepSeek",
      modelAlias: "deepseek-v4-pro",
      byAgentLabel: "您的 Agent",
      kind: "writer",
      step: { label: "取证", no: 2, total: 4, at: STEP.at },
      startedAt: "2026-08-20T09:58:00.000Z",
    },
    // 挂了：另外两条照旧 —— 一条链路挂掉不拖垮这一轮（见 `a4/run.ts`）。
    {
      key: "agent:alt1",
      label: "Claude",
      modelAlias: "claude-opus-5",
      byAgentLabel: "您的 Agent",
      kind: "writer",
      note: "这一条没跑成",
      error: "模型输出被 max_tokens(8000) 截断。",
      startedAt: "2026-08-20T09:58:00.000Z",
    },
    // 写完了：主源那一条，带着**它自己**的用时（不是整轮的）。
    {
      key: "agent",
      label: "ChatGPT",
      modelAlias: "gpt-5.6",
      byAgentLabel: "您的 Agent",
      kind: "writer",
      text: "## 判断\n先说结论。",
      durationMs: 96_000,
    },
  ];

  it("写完的那条是能读的报告，在跑的带着自己的秒表，挂了的带着那句原话", async () => {
    const issue = await api.addIssue("要不要把交付这件事的排期收到一张看板上");
    const end = hold("deep", issue.id);
    taskReports("deep", issue.id, drafts);

    const list = await api.listReports(issue.id);
    // key 必须和落库之后一模一样：不然报告落下来的那一刻他选中的那一栏会跳走。
    expect(list.map((r) => r.key)).toEqual(["agent:alt0", "agent:alt1", "agent"]);

    // 写完的那一条：有正文、有它自己的用时。
    expect(list[2].source?.text).toContain("先说结论");
    expect(list[2].source?.kind).toBe("writer");
    expect(list[2].source?.durationMs).toBe(96_000);
    // 还没落库，所以没有装配清单、没有时刻 —— 那两样要等这一轮收尾才算完。
    expect(list[2].source?.assembledFrom).toBeUndefined();
    expect(list[2].source?.at).toBeUndefined();

    /*
     * 在跑的那一条：**它自己**的步号和起点。这就是「单独计时」的落点 —— 读整轮那个起点的
     * 话，屏幕上三栏的秒数会一模一样。
     */
    expect(list[0].source).toBeUndefined();
    expect(list[0].pending?.step).toMatchObject({ label: "取证", no: 2, total: 4 });
    expect(list[0].pending?.startedAt).toBe("2026-08-20T09:58:00.000Z");
    expect(list[0].pending?.error).toBeUndefined();

    // 挂了的那一条：原话照传，视图不改写（它要拿这句话分清是钥匙没配还是额度用完了）。
    expect(list[1].pending?.error).toContain("max_tokens");
    end();
  });

  it("这一轮结算之后草稿就作废 —— 没有任何一栏由它撑着", async () => {
    const issue = await api.addIssue("要不要把对外报价的审批收到两个人手上");
    const end = hold("deep", issue.id);
    taskReports("deep", issue.id, drafts);
    expect((await api.listReports(issue.id)).length).toBe(3);

    end();
    await settle(() => api.deepResearchStatus(issue.id));
    /*
     * 结算重建了整个 TaskState，草稿跟着 `step` 一起消失（见 `runTask`）。这一条钉的是
     * 那个后果：一轮跑完（或跑挂）之后页签行不许还摆着几份没落库的原件 —— 那时候屏幕上
     * 那几栏读的会是一轮已经过去了的东西。
     */
    expect(taskState("deep", issue.id).reports).toBeUndefined();
    expect((await api.listReports(issue.id)).some((r) => r.key.startsWith("agent"))).toBe(false);
  });

  it("没在跑的那一条写不进去 —— 慢一步的收尾不许把结算过的任务改回在跑的样子", async () => {
    const issue = await api.addIssue("要不要把续约谈判的授权额度写进一份口径");
    taskReports("deep", issue.id, drafts);
    expect(taskState("deep", issue.id).reports).toBeUndefined();
  });
});

describe("预研：提请台那张卡", () => {
  it("在跑的那一轮：卡面带着起点和步骤原话", async () => {
    const issue = await api.addIssue("要不要把本体的对外接口收到一个网关后面");
    /*
     * `addIssue` 自己起的那一轮在单测里必然失败（第一步就要 GraphKnowledge，而这里
     * 出不了网）。先等它落定，再解闩摆一个可控的 —— 直接叠上去会被 `runTask` 挡掉。
     */
    expect((await settle(() => api.preResearchStatus(issue.id))).status).toBe("failed");
    expect(clearTask("preresearch", issue.id)).toBe(true);

    const end = hold("preresearch", issue.id);
    taskStep("preresearch", issue.id, { label: "写这一轮预研", no: 2, total: 2, at: STEP.at });

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card?.preResearchStep).toMatchObject({ no: 2, total: 2, label: "写这一轮预研" });
    expect(card?.preResearchStartedAt).toBeTruthy();
    expect(card?.preResearchFailed).toBeUndefined();
    end();
  });

  it("跑挂了照实说没跑成 —— 失败不许伪装成等待", async () => {
    const issue = await api.addIssue("要不要把研究这件事按域拆给各自的承接人");
    expect((await settle(() => api.preResearchStatus(issue.id))).status).toBe("failed");

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card?.preResearchFailed).toBe(true);
    // 挂了的那一轮不许留着起点：留着屏幕就照旧呼吸，而没有任何东西在跑。
    expect(card?.preResearchStartedAt).toBeUndefined();
    expect(card?.preResearchStep).toBeUndefined();
  });

  it("压根没起过那一轮：三个字段全空，卡面照实说没有预研", async () => {
    const issue = await api.addIssue("要不要把定价这件事收回到总部");
    expect((await settle(() => api.preResearchStatus(issue.id))).status).toBe("failed");
    // 抹掉那次失败，就回到了 demo 那一档的样子：没有报告，也没有任何一轮在跑。
    expect(clearTask("preresearch", issue.id)).toBe(true);

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card?.preResearchAt).toBeUndefined();
    expect(card?.preResearchFailed).toBeUndefined();
    expect(card?.preResearchStartedAt).toBeUndefined();
    expect(card?.preResearchStep).toBeUndefined();
  });
});
