/**
 * Commitment 在 store 上的一整轮：灌纲领 → DRI 回传 → 一号位裁决 → 修订 → 生效。
 *
 * 每一步都在真身份里跑：这一条链路的全部意义就是两侧看到的不是同一片东西。
 */
// 必须在 import 之前设置：store.ts 模块求值期会 loadSnapshot 读开发机上 .data/store.json 里的真实数据，
// 不设这个开关测试会拿现场数据跑且不报错，断言结果跟着那个 gitignore 掉的文件飘。
process.env.TKOS_PERSIST = "0";

import { beforeAll, describe, expect, it } from "vitest";

import { runAsActor } from "./actor";
import { api, commitmentsIntake } from "./store";

const PERIOD = "PRD-2026-12";
const ID = `D-04:${PERIOD}`;
/* PSN-14 是陈溪南 —— D-04（Agents）名单上的第一位（2026-08-31 在位人校准）。 */
const asDri = <T,>(fn: () => Promise<T>) => runAsActor({ personId: "PSN-14", role: "dri" }, fn);
const asCeo = <T,>(fn: () => Promise<T>) => runAsActor({ personId: "PSN-01", role: "ceo" }, fn);

beforeAll(() => {
  commitmentsIntake({
    period: { id: PERIOD, label: "测试期", startsOn: "2026-12-01", endsOn: "2026-12-31" },
    companyOutcome: { statement: "测试用", dueOn: "2026-12-31" },
    domains: [
      {
        domainId: "D-04",
        northStar: "首批 Agents 进入日常使用",
        items: [
          { proposed: "A4 深研上线", tier: "acceptance" },
          { proposed: "A5 判断生成", tier: "required" },
        ],
      },
    ],
  });
});

describe("一整轮", () => {
  it("DRI 只看得到自己域的那份，且带上域的名字与轮次", async () => {
    const mine = await asDri(() => api.listMyCommitments(PERIOD));
    const one = mine.find((c) => c.id === ID);
    expect(one?.status).toBe("drafted");
    expect(one?.domainCode).toBe("D-04");
    expect(one?.rounds).toBe(0);
    // PSN-12（秦梦怡，Organization & Talent）看不到 D-04。
    const other = await runAsActor({ personId: "PSN-12", role: "dri" }, () =>
      api.listMyCommitments(PERIOD)
    );
    expect(other.some((c) => c.id === ID)).toBe(false);
  });

  it("回传 → 裁决 → 修订 → 生效，轮次数到 2", async () => {
    await asDri(() =>
      api.submitCommitment(ID, {
        northStar: "首批 Agents 进入两个真实场景的日常使用",
        items: [
          { id: `${ID}-m1`, verdict: "accept", evidence: ["两个场景各有一周连续使用记录"], milestone: { own: "12/10 上线" }, tier: "acceptance" },
          { id: `${ID}-m2`, verdict: "modify", reason: "证据换成一号位采信率", evidence: ["采信率过半"], milestone: {}, tier: "required" },
        ],
        assumptions: [{ text: "模型额度够", defaultPath: "不够就砍到一个场景", dueOn: "2026-12-05" }],
        preconditions: ["12/01 前拿到线上机器"],
        questions: [{ text: "谁定采信率的口径", toWhom: "刘明华", needBy: "2026-12-03", closed: false }],
        note: "第一轮",
      })
    );

    let screen = await asCeo(() => api.getCommitment(ID));
    expect(screen.status).toBe("submitted");
    expect(screen.rounds).toBe(1);
    expect(screen.items[1].verdict).toBe("modify");

    screen = await asCeo(() =>
      api.adjudicateCommitment(ID, {
        [`${ID}-m1`]: { verdict: "endorse", note: "" },
        [`${ID}-m2`]: { verdict: "revise", note: "采信率写到 60%" },
      })
    );
    expect(screen.status).toBe("adjudicated");
    expect(screen.items[1].ruling?.by).toBe("刘明华");

    screen = await asDri(() =>
      api.submitCommitment(ID, {
        northStar: screen.northStar,
        items: screen.items.map((i) => ({
          id: i.id,
          verdict: i.verdict,
          reason: i.reason,
          evidence: i.id.endsWith("m2") ? ["采信率 ≥ 60%"] : i.evidence,
          milestone: i.milestone,
          tier: i.tier,
        })),
        assumptions: screen.assumptions,
        preconditions: screen.preconditions,
        questions: screen.questions,
        note: "按裁决把口径改成 60%",
      })
    );
    expect(screen.version).toBe(2);
    expect(screen.rounds).toBe(2);

    screen = await asCeo(() => api.signCommitment(ID));
    expect(screen.status).toBe("effective");

    // 生效之后两侧都写不动。
    await expect(asDri(() => api.submitCommitment(ID, { ...blank(screen), note: "再改" }))).rejects.toThrow(
      "已经生效"
    );
    await expect(asCeo(() => api.adjudicateCommitment(ID, {}))).rejects.toThrow("已经生效");
  });

  it("生效前提超过两条要拒 —— M2 的硬上限", async () => {
    // 另建一份，别污染上面那条链路。
    commitmentsIntake({
      period: { id: PERIOD, label: "测试期", startsOn: "2026-12-01", endsOn: "2026-12-31" },
      companyOutcome: { statement: "测试用", dueOn: "2026-12-31" },
      domains: [{ domainId: "D-07", northStar: "核心团队搭起来", items: [{ proposed: "招两个人", tier: "acceptance" }] }],
    });
    await expect(
      runAsActor({ personId: "PSN-12", role: "dri" }, () =>
        api.submitCommitment(`D-07:${PERIOD}`, {
          northStar: "核心团队搭起来",
          items: [{ id: `D-07:${PERIOD}-m1`, verdict: "accept", evidence: ["两个人入职"], milestone: {}, tier: "acceptance" }],
          assumptions: [],
          preconditions: ["一", "二", "三"],
          questions: [],
          note: "",
        })
      )
    ).rejects.toThrow("最多两条");
  });

  it("别人域的那份，我提交不了", async () => {
    await expect(
      runAsActor({ personId: "PSN-12", role: "dri" }, () =>
        api.submitCommitment(ID, {
          northStar: "硬塞",
          items: [],
          assumptions: [],
          preconditions: [],
          questions: [],
          note: "",
        })
      )
    ).rejects.toThrow("不是你的域");
  });
});

/** 拿一份现成的当空白骨架用，省得每处重写一遍。 */
function blank(screen: Awaited<ReturnType<typeof api.getCommitment>>) {
  return {
    northStar: screen.northStar,
    items: screen.items.map((i) => ({
      id: i.id,
      verdict: i.verdict,
      reason: i.reason,
      evidence: i.evidence,
      milestone: i.milestone,
      tier: i.tier,
    })),
    assumptions: screen.assumptions,
    preconditions: screen.preconditions,
    questions: screen.questions,
  };
}
